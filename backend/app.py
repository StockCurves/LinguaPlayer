"""
LinguaPlayer Backend Server
Downloads YouTube / podcast audio, slices long audio at silence boundaries,
transcribes with Whisper (word-level), and returns SRT + audio.
"""

import os
import re
import json
import base64
import hashlib
import tempfile
import traceback
import shutil
import io
from pathlib import Path

# ── Directories ─────────────────────────────────────────────────────────
MP3_CACHE_DIR = Path(__file__).parent / "mp3_cache"
MP3_CACHE_DIR.mkdir(exist_ok=True)
TEMP_DIR = Path(tempfile.gettempdir()) / "lingua_player"
TEMP_DIR.mkdir(exist_ok=True)

from flask import Flask, request, jsonify, send_file
from flask_cors import CORS
from werkzeug.utils import secure_filename

app = Flask(__name__)
CORS(app, resources={r"/*": {"origins": "*"}}, supports_credentials=False)

@app.after_request
def add_cors_headers(response):
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type"
    return response

@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok"})

MAX_CHUNK_DURATION_MS = 9 * 60 * 1000
SILENCE_THRESH_DB = -40
MIN_SILENCE_LEN_MS = 500
SILENCE_SEARCH_WINDOW_MS = 2 * 60 * 1000

def get_video_id(url: str) -> str:
    return hashlib.md5(url.encode()).hexdigest()[:12]

def _meta_path(video_id: str) -> Path:
    return MP3_CACHE_DIR / f"{video_id}.json"

def _mp3_path(video_id: str) -> Path:
    return MP3_CACHE_DIR / f"{video_id}.mp3"

def download_audio(url: str, video_id: str) -> Path:
    import yt_dlp
    output_path = _mp3_path(video_id)
    if output_path.exists():
        return output_path
    tmp_output = TEMP_DIR / f"{video_id}.%(ext)s"
    ydl_opts = {
        "format": "bestaudio/best",
        "outtmpl": str(tmp_output),
        "postprocessors": [{"key": "FFmpegExtractAudio", "preferredcodec": "mp3", "preferredquality": "192"}],
        "quiet": True,
        "no_warnings": True,
    }
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(url, download=True)
        title = info.get("title", video_id)
        duration = info.get("duration", 0)
        thumbnail = info.get("thumbnail", "")
    tmp_mp3 = TEMP_DIR / f"{video_id}.mp3"
    if tmp_mp3.exists():
        tmp_mp3.rename(output_path)
    meta = {"title": title, "url": url, "duration": duration, "thumbnail": thumbnail}
    _meta_path(video_id).write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
    return output_path

def get_video_title(url: str, video_id: str | None = None) -> str:
    if video_id:
        meta_file = _meta_path(video_id)
        if meta_file.exists():
            try: return json.loads(meta_file.read_text(encoding="utf-8")).get("title", "youtube_audio")
            except: pass
    import yt_dlp
    try:
        with yt_dlp.YoutubeDL({"quiet": True, "no_warnings": True}) as ydl:
            info = ydl.extract_info(url, download=False)
            return info.get("title", "youtube_audio")
    except: return "youtube_audio"

def slice_audio(mp3_path: Path, video_id: str) -> list[Path]:
    from pydub import AudioSegment
    from pydub.silence import detect_silence
    audio = AudioSegment.from_mp3(str(mp3_path))
    total_ms = len(audio)
    if total_ms <= MAX_CHUNK_DURATION_MS + 60_000: return [mp3_path]
    chunks: list[Path] = []
    offset = 0
    chunk_idx = 0
    while offset < total_ms:
        remaining = total_ms - offset
        if remaining <= MAX_CHUNK_DURATION_MS + 60_000:
            chunk = audio[offset:]
            chunk_path = TEMP_DIR / f"{video_id}_chunk_{chunk_idx}.mp3"
            chunk.export(str(chunk_path), format="mp3")
            chunks.append(chunk_path)
            break
        search_start = offset + MAX_CHUNK_DURATION_MS - SILENCE_SEARCH_WINDOW_MS
        search_end = offset + MAX_CHUNK_DURATION_MS
        search_segment = audio[search_start:search_end]
        silences = detect_silence(search_segment, min_silence_len=MIN_SILENCE_LEN_MS, silence_thresh=SILENCE_THRESH_DB)
        if silences:
            last_silence = silences[-1]
            cut_point = search_start + (last_silence[0] + last_silence[1]) // 2
        else:
            cut_point = offset + MAX_CHUNK_DURATION_MS
        chunk = audio[offset:cut_point]
        chunk_path = TEMP_DIR / f"{video_id}_chunk_{chunk_idx}.mp3"
        chunk.export(str(chunk_path), format="mp3")
        chunks.append(chunk_path)
        offset = cut_point
        chunk_idx += 1
    return chunks

def transcribe_chunks(chunks: list[Path], video_id: str, model_name: str) -> list[dict]:
    import whisper
    model = whisper.load_model(model_name)
    all_results = []
    for idx, chunk_path in enumerate(chunks):
        recovery_path = TEMP_DIR / f"{video_id}_result_{idx}.json"
        if recovery_path.exists():
            with open(recovery_path, "r", encoding="utf-8") as f: result = json.load(f)
        else:
            result = model.transcribe(str(chunk_path), word_timestamps=True, verbose=False)
            result = serialize_whisper_result(result)
            with open(recovery_path, "w", encoding="utf-8") as f: json.dump(result, f, ensure_ascii=False)
        all_results.append(result)
    return all_results

def serialize_whisper_result(result: dict) -> dict:
    segments = []
    for seg in result.get("segments", []):
        s = {"start": seg["start"], "end": seg["end"], "text": seg["text"], "words": []}
        for w in seg.get("words", []):
            s["words"].append({"word": w["word"], "start": w["start"], "end": w["end"]})
        segments.append(s)
    return {"segments": segments, "language": result.get("language", "en")}

def get_chunk_durations(chunks: list[Path]) -> list[float]:
    from pydub import AudioSegment
    return [len(AudioSegment.from_mp3(str(c))) / 1000.0 for c in chunks]

def merge_and_build_sentences(results: list[dict], chunk_durations: list[float]) -> list[dict]:
    SENTENCE_ENDERS = re.compile(r'[.?!\u2026;:]$')
    all_words = []
    time_offset = 0.0
    for idx, result in enumerate(results):
        for seg in result["segments"]:
            for w in seg.get("words", []):
                all_words.append({"word": w["word"], "start": w["start"] + time_offset, "end": w["end"] + time_offset})
        if idx < len(chunk_durations): time_offset += chunk_durations[idx]
    if not all_words: return []
    sentences = []
    current_words = []
    for word in all_words:
        current_words.append(word)
        if SENTENCE_ENDERS.search(word["word"].strip()):
            sentences.append({"start": current_words[0]["start"], "end": current_words[-1]["end"], "text": "".join(w["word"] for w in current_words).strip()})
            current_words = []
    if current_words:
        sentences.append({"start": current_words[0]["start"], "end": current_words[-1]["end"], "text": "".join(w["word"] for w in current_words).strip()})
    return sentences

def extract_waveform_peaks(mp3_path: Path, samples_per_second: int = 50) -> list[float]:
    from pydub import AudioSegment
    try:
        audio = AudioSegment.from_mp3(str(mp3_path))
        if audio.channels > 1: audio = audio.set_channels(1)
        total_ms = len(audio)
        if total_ms == 0: return []
        frame_ms = 1000 // samples_per_second
        peaks = []
        for i in range(0, total_ms, frame_ms):
            chunk = audio[i:i + frame_ms]
            peaks.append(chunk.rms)
        if peaks:
            max_peak = max(peaks)
            return [p / max_peak for p in peaks] if max_peak > 0 else [0.0] * len(peaks)
        return []
    except Exception as e:
        print(f"Error in extract_waveform_peaks: {e}")
        return []

def refine_end_times_by_silence(sentences: list[dict], mp3_path: Path, look_ahead_ms: int = 800, silence_thresh_db: float = -38.0, frame_ms: int = 20) -> list[dict]:
    from pydub import AudioSegment
    try:
        audio = AudioSegment.from_mp3(str(mp3_path))
        total_ms = len(audio)
        refined = []
        for s in sentences:
            orig_end_ms = int(s["end"] * 1000)
            scan_start_ms = max(0, orig_end_ms - 50)
            scan_end_ms = min(total_ms, orig_end_ms + look_ahead_ms)
            new_end_ms = orig_end_ms
            t = scan_start_ms
            while t + frame_ms <= scan_end_ms:
                frame = audio[t : t + frame_ms]
                if frame.dBFS < silence_thresh_db or frame.dBFS == float('-inf'):
                    new_end_ms = t
                    break
                t += frame_ms
            refined.append({"start": s["start"], "end": new_end_ms / 1000.0, "text": s["text"]})
        return refined
    except: return sentences

def seconds_to_srt_time(seconds: float) -> str:
    hours = int(seconds // 3600)
    minutes = int((seconds % 3600) // 60)
    secs = int(seconds % 60)
    millis = int(round((seconds - int(seconds)) * 1000))
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{millis:03d}"

def sentences_to_srt(sentences: list[dict]) -> str:
    lines = []
    for idx, s in enumerate(sentences, 1):
        lines.append(str(idx))
        lines.append(f"{seconds_to_srt_time(s['start'])} --> {seconds_to_srt_time(s['end'])}")
        lines.append(s["text"])
        lines.append("")
    return "\n".join(lines)

def cleanup_temp_files(video_id: str):
    for f in TEMP_DIR.glob(f"{video_id}_chunk_*"): f.unlink(missing_ok=True)
    for f in TEMP_DIR.glob(f"{video_id}_result_*"): f.unlink(missing_ok=True)

@app.route("/api/youtube-info", methods=["POST"])
def youtube_info():
    data = request.get_json()
    url = data.get("url", "").strip()
    if not url: return jsonify({"error": "No URL provided"}), 400
    video_id = get_video_id(url)
    meta_file = _meta_path(video_id)
    if meta_file.exists():
        try:
            meta = json.loads(meta_file.read_text(encoding="utf-8"))
            return jsonify({"title": meta.get("title", ""), "duration": meta.get("duration", 0), "thumbnail": meta.get("thumbnail", ""), "cached": True})
        except: pass
    try:
        import yt_dlp
        with yt_dlp.YoutubeDL({"quiet": True, "no_warnings": True}) as ydl:
            info = ydl.extract_info(url, download=False)
            return jsonify({"title": info.get("title", ""), "duration": info.get("duration", 0), "thumbnail": info.get("thumbnail", ""), "cached": False})
    except Exception as e: return jsonify({"error": str(e)}), 500

@app.route("/api/extract-peaks", methods=["POST"])
def api_extract_peaks():
    if "file" not in request.files: return jsonify({"error": "No file part"}), 400
    file = request.files["file"]
    if file.filename == "": return jsonify({"error": "No selected file"}), 400
    try:
        fname = secure_filename(file.filename)
        if not fname: fname = "upload.mp3"
        tpath = TEMP_DIR / f"peaks_{fname}"
        file.save(str(tpath))
        peaks = extract_waveform_peaks(tpath)
        tpath.unlink(missing_ok=True)
        return jsonify({"waveform_peaks": peaks})
    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500

@app.route("/api/download-mp3", methods=["POST"])
def download_mp3():
    data = request.get_json()
    url = data.get("url", "").strip()
    if not url: return jsonify({"error": "No URL provided"}), 400
    video_id = get_video_id(url)
    try:
        mp3_path = download_audio(url, video_id)
        title = get_video_title(url, video_id)
        safe_title = re.sub(r'[^\w\s-]', '', title).strip().replace(' ', '_')[:60]
        return send_file(mp3_path, mimetype="audio/mpeg", as_attachment=True, download_name=f"{safe_title or video_id}.mp3")
    except Exception as e: return jsonify({"error": str(e)}), 500

@app.route("/api/process-youtube", methods=["POST"])
def process_youtube():
    data = request.get_json()
    url, model_name, enable_volume = data.get("url", "").strip(), data.get("model", "base"), data.get("enable_volume_adjustment", True)
    if not url: return jsonify({"error": "No URL provided"}), 400
    video_id = get_video_id(url)
    try:
        mp3_path = download_audio(url, video_id)
        title = get_video_title(url, video_id)
        safe_title = re.sub(r'[^\w\s-]', '', title).strip().replace(' ', '_')[:60]
        chunks = slice_audio(mp3_path, video_id)
        results = transcribe_chunks(chunks, video_id, model_name)
        sentences = merge_and_build_sentences(results, get_chunk_durations(chunks) if len(chunks) > 1 else [0.0])
        srt_content = sentences_to_srt(sentences)
        srt_adjusted = sentences_to_srt(refine_end_times_by_silence(sentences, mp3_path)) if enable_volume else ""
        waveform_peaks = extract_waveform_peaks(mp3_path)
        with open(mp3_path, "rb") as f: audio_b64 = base64.b64encode(f.read()).decode("ascii")
        cleanup_temp_files(video_id)
        return jsonify({"audio_base64": audio_b64, "audio_filename": f"{safe_title}.mp3", "srt_content": srt_content, "srt_content_adjusted": srt_adjusted, "sentence_count": len(sentences), "waveform_peaks": waveform_peaks})
    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500

@app.route("/api/process-podcast", methods=["POST"])
def process_podcast():
    data = request.get_json()
    url, model_name, enable_volume = data.get("url", "").strip(), data.get("model", "base"), data.get("enable_volume_adjustment", True)
    if not url: return jsonify({"error": "No URL provided"}), 400
    podcast_id = get_video_id(url)
    try:
        mp3_path, title = download_podcast_audio(url, podcast_id)
        safe_title = re.sub(r'[^\w\s-]', '', title).strip().replace(' ', '_')[:60]
        chunks = slice_audio(mp3_path, podcast_id)
        results = transcribe_chunks(chunks, podcast_id, model_name)
        sentences = merge_and_build_sentences(results, get_chunk_durations(chunks) if len(chunks) > 1 else [0.0])
        srt_content = sentences_to_srt(sentences)
        srt_adjusted = sentences_to_srt(refine_end_times_by_silence(sentences, mp3_path)) if enable_volume else ""
        waveform_peaks = extract_waveform_peaks(mp3_path)
        with open(mp3_path, "rb") as f: audio_b64 = base64.b64encode(f.read()).decode("ascii")
        cleanup_temp_files(podcast_id)
        return jsonify({"audio_base64": audio_b64, "audio_filename": f"{safe_title or podcast_id}.mp3", "srt_content": srt_content, "srt_content_adjusted": srt_adjusted, "sentence_count": len(sentences), "waveform_peaks": waveform_peaks})
    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500

@app.route("/api/transcribe-upload", methods=["POST", "OPTIONS"])
def transcribe_upload():
    if request.method == "OPTIONS": return "", 204
    if "file" not in request.files: return jsonify({"error": "No file uploaded"}), 400
    audio_file = request.files["file"]
    model_name = request.form.get("model", "base")
    enable_volume = request.form.get("enable_volume_adjustment", "true").lower() == "true"
    if not audio_file.filename: return jsonify({"error": "Empty filename"}), 400
    file_id = hashlib.md5(audio_file.filename.encode()).hexdigest()[:12]
    mp3_path = TEMP_DIR / f"{file_id}.mp3"
    try:
        if not mp3_path.exists(): audio_file.save(str(mp3_path))
        safe_name = re.sub(r'[^\w\s-]', '', audio_file.filename).strip().replace(' ', '_')[:60]
        if not safe_name.lower().endswith('.mp3'): safe_name += '.mp3'
        chunks = slice_audio(mp3_path, file_id)
        results = transcribe_chunks(chunks, file_id, model_name)
        sentences = merge_and_build_sentences(results, get_chunk_durations(chunks) if len(chunks) > 1 else [0.0])
        srt_content = sentences_to_srt(sentences)
        srt_adjusted = sentences_to_srt(refine_end_times_by_silence(sentences, mp3_path)) if enable_volume else ""
        waveform_peaks = extract_waveform_peaks(mp3_path)
        return jsonify({"srt_content": srt_content, "srt_content_adjusted": srt_adjusted, "sentence_count": len(sentences), "waveform_peaks": waveform_peaks})
    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500

@app.route("/api/refine-srt", methods=["POST"])
def refine_srt():
    if "file" not in request.files: return jsonify({"error": "No file"}), 400
    audio_file, srt_content = request.files["file"], request.form.get("srt_content", "")
    if not srt_content: return jsonify({"error": "No SRT content"}), 400
    file_id = hashlib.md5(audio_file.filename.encode()).hexdigest()[:12]
    mp3_path = TEMP_DIR / f"refine_{file_id}.mp3"
    try:
        if not mp3_path.exists(): audio_file.save(str(mp3_path))
        sentences = []
        for part in srt_content.replace('\r', '').split('\n\n'):
            lines = part.strip().split('\n')
            if len(lines) < 3: continue
            time_match = re.search(r'(\d+:\d+:\d+,\d+) --> (\d+:\d+:\d+,\d+)', lines[1])
            if not time_match: continue
            def to_s(t):
                h, m, s_ms = t.split(':')
                s, ms = s_ms.split(',')
                return int(h)*3600 + int(m)*60 + int(s) + int(ms)/1000.0
            sentences.append({"start": to_s(time_match.group(1)), "end": to_s(time_match.group(2)), "text": "\n".join(lines[2:])})
        refined = refine_end_times_by_silence(sentences, mp3_path)
        return jsonify({"srt_content_adjusted": sentences_to_srt(refined)})
    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500

@app.route("/api/export-sentence-mp3", methods=["POST"])
def export_sentence_mp3():
    data = request.json
    filename, start_ms, end_ms = data.get("filename"), data.get("startTime"), data.get("endTime")
    if not filename or start_ms is None or end_ms is None: return jsonify({"error": "Missing params"}), 400
    mp3_path = MP3_CACHE_DIR / filename
    if not mp3_path.exists(): mp3_path = TEMP_DIR / filename
    if not mp3_path.exists(): return jsonify({"error": f"File not found: {filename}"}), 404
    try:
        from pydub import AudioSegment
        audio = AudioSegment.from_mp3(str(mp3_path))
        segment = audio[start_ms:end_ms]
        TARGET_DBFS = -10.0
        if segment.dBFS != float('-inf') and len(segment) > 0:
            segment = segment.apply_gain(TARGET_DBFS - segment.dBFS)
        buf = io.BytesIO()
        segment.exports(buf, format="mp3", bitrate="192k")
        buf.seek(0)
        return send_file(buf, mimetype="audio/mpeg", as_attachment=True, download_name=filename)
    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500

def download_podcast_audio(url: str, podcast_id: str) -> tuple[Path, str]:
    output_path, meta_file = _mp3_path(podcast_id), _meta_path(podcast_id)
    if output_path.exists():
        title = podcast_id
        if meta_file.exists():
            try: title = json.loads(meta_file.read_text(encoding='utf-8')).get('title', podcast_id)
            except: pass
        return output_path, title
    import requests as http_requests
    from urllib.parse import urlparse, unquote
    if any(urlparse(url).path.lower().endswith(ext) for ext in ('.mp3', '.m4a', '.ogg', '.wav', '.aac', '.opus', '.flac')):
        resp = http_requests.get(url, stream=True, timeout=120, headers={'User-Agent': 'Mozilla/5.0'})
        resp.raise_for_status()
        url_path = unquote(urlparse(url).path)
        raw_name = os.path.splitext(os.path.basename(url_path))[0] or podcast_id
        title = raw_name.replace('_', ' ').replace('-', ' ').strip()
        ext = os.path.splitext(urlparse(url).path)[1].lower() or '.mp3'
        tmp_raw = TEMP_DIR / f"{podcast_id}_raw{ext}"
        with open(tmp_raw, 'wb') as f:
            for chunk in resp.iter_content(chunk_size=65536): f.write(chunk)
        if ext == '.mp3': shutil.move(str(tmp_raw), str(output_path))
        else:
            from pydub import AudioSegment
            AudioSegment.from_file(str(tmp_raw)).export(str(output_path), format='mp3', bitrate='192k')
            tmp_raw.unlink(missing_ok=True)
    else:
        import yt_dlp
        tmp_output = TEMP_DIR / f"{podcast_id}.%(ext)s"
        ydl_opts = {'format': 'bestaudio/best', 'outtmpl': str(tmp_output), 'postprocessors': [{'key': 'FFmpegExtractAudio', 'preferredcodec': 'mp3', 'preferredquality': '192'}], 'quiet': True, 'no_warnings': True}
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=True)
            title = info.get('title', podcast_id)
        tmp_mp3 = TEMP_DIR / f"{podcast_id}.mp3"
        if tmp_mp3.exists(): shutil.move(str(tmp_mp3), str(output_path))
        else:
            for f in TEMP_DIR.glob(f"{podcast_id}.*"):
                if f.suffix.lower() in ('.mp3', '.m4a', '.webm', '.opus', '.ogg'):
                    if f.suffix.lower() == '.mp3': shutil.move(str(f), str(output_path))
                    else:
                        from pydub import AudioSegment
                        AudioSegment.from_file(str(f)).export(str(output_path), format='mp3', bitrate='192k')
                        f.unlink(missing_ok=True)
                    break
    if not output_path.exists(): raise RuntimeError(f"Failed to download: {url}")
    meta_file.write_text(json.dumps({'title': title, 'url': url, 'source': 'podcast'}, ensure_ascii=False), encoding='utf-8')
    return output_path, title

if __name__ == "__main__":
    print("LinguaPlayer Backend started on port 5000")
    app.run(host="0.0.0.0", port=5000)
