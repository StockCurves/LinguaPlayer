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
import datetime
from pathlib import Path

# ── Directories ─────────────────────────────────────────────────────────
MP3_CACHE_DIR = Path(__file__).parent / "mp3_cache"
MP3_CACHE_DIR.mkdir(exist_ok=True)
TEMP_DIR = Path(tempfile.gettempdir()) / "lingua_player"
TEMP_DIR.mkdir(exist_ok=True)
USER_UPLOADS_DIR = Path(__file__).parent / "user_uploads"
USER_UPLOADS_DIR.mkdir(exist_ok=True)

from flask import Flask, request, jsonify, send_file, Response, stream_with_context
from flask_cors import CORS
from werkzeug.utils import secure_filename

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 200 * 1024 * 1024  # 200MB limit
CORS(app, resources={r"/*": {"origins": "*"}}, supports_credentials=False)

import logging
logging.basicConfig(level=logging.DEBUG)

@app.before_request
def log_request():
    print(f"[REQUEST] {request.method} {request.path} Content-Length={request.content_length}", flush=True)

@app.errorhandler(500)
def handle_500(e):
    """Return JSON for any unhandled server error instead of HTML."""
    print(f"[500 ERROR] {e}", flush=True)
    traceback.print_exc()
    return jsonify({"error": f"Internal server error: {str(e)}"}), 500

@app.errorhandler(413)
def handle_413(e):
    """Return JSON for request-too-large errors."""
    return jsonify({"error": "File too large. Maximum size is 200MB."}), 413

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

def transcribe_chunks(chunks: list[Path], video_id: str, model_name: str, progress_cb=None) -> list[dict]:
    import whisper
    model = whisper.load_model(model_name)
    all_results = []
    # Pre-compute chunk durations for display
    chunk_start_minutes = []
    if len(chunks) > 1:
        from pydub import AudioSegment
        offset_min = 0.0
        for c in chunks:
            chunk_start_minutes.append(offset_min)
            dur = len(AudioSegment.from_mp3(str(c))) / 1000.0 / 60.0
            offset_min += dur
    else:
        chunk_start_minutes = [0.0]

    for idx, chunk_path in enumerate(chunks):
        # Report progress
        if progress_cb:
            if len(chunks) == 1:
                progress_cb("transcribing", f"Transcribing audio with Whisper ({model_name})…")
            else:
                start_m = int(chunk_start_minutes[idx])
                end_m = int(chunk_start_minutes[idx + 1]) if idx + 1 < len(chunk_start_minutes) else "end"
                progress_cb("transcribing", f"Transcribing chunk {idx+1}/{len(chunks)} ({start_m}–{end_m} min)…")

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

# ── SSE Streaming helper ─────────────────────────────────────────────
def _save_to_library(mp3_path: Path, title: str, url: str, source: str) -> str:
    """Save an MP3 to user_uploads library so user can reload / re-transcribe."""
    file_id = hashlib.md5(url.encode()).hexdigest()[:12]
    lib_mp3 = USER_UPLOADS_DIR / f"{file_id}.mp3"
    lib_meta = USER_UPLOADS_DIR / f"{file_id}.json"
    if not lib_mp3.exists():
        shutil.copy2(str(mp3_path), str(lib_mp3))
    safe_name = re.sub(r'[^\w\s-]', '', title).strip().replace(' ', '_')[:60]
    if not safe_name.lower().endswith('.mp3'):
        safe_name += '.mp3'
    meta = {
        "title": title,
        "filename": safe_name,
        "url": url,
        "source": source,
        "date": datetime.datetime.now().isoformat(),
    }
    lib_meta.write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
    return file_id

def _sse_event(event: str, data: dict) -> str:
    """Format a single SSE event."""
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"

@app.route("/api/process-url-stream", methods=["POST", "OPTIONS"])
def process_url_stream():
    """SSE streaming endpoint for YouTube / Podcast download + transcription.
    Sends progress events as the work proceeds, then a final 'done' event.
    """
    if request.method == "OPTIONS": 
        resp = Response("", 204)
        resp.headers["Access-Control-Allow-Origin"] = "*"
        resp.headers["Access-Control-Allow-Methods"] = "POST, OPTIONS"
        resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
        return resp

    data = request.get_json()
    url = data.get("url", "").strip()
    model_name = data.get("model", "base")
    enable_volume = data.get("enable_volume_adjustment", True)
    if not url:
        return jsonify({"error": "No URL provided"}), 400

    is_yt = bool(re.search(r'(?:youtube\.com|youtu\.be)', url, re.I))

    def generate():
        try:
            # ── Step 1: Download ──────────────────────────────────────
            yield _sse_event("progress", {
                "step": "downloading",
                "message": "Downloading audio…" if is_yt else "Downloading podcast audio…"
            })

            if is_yt:
                vid = get_video_id(url)
                mp3_path = download_audio(url, vid)
                title = get_video_title(url, vid)
            else:
                vid = get_video_id(url)
                mp3_path, title = download_podcast_audio(url, vid)

            safe_title = re.sub(r'[^\w\s-]', '', title).strip().replace(' ', '_')[:60]

            yield _sse_event("progress", {
                "step": "downloaded",
                "message": f"✅ Audio downloaded: {title}"
            })

            # ── Step 1b: Save to library ───────────────────────────────
            file_id = _save_to_library(mp3_path, title, url, "youtube" if is_yt else "podcast")
            yield _sse_event("progress", {
                "step": "saved_to_library",
                "message": "💾 Saved MP3 to library",
                "file_id": file_id,
            })

            # ── Step 2: Slice audio ────────────────────────────────────
            yield _sse_event("progress", {
                "step": "slicing",
                "message": "Splitting audio into chunks…"
            })
            chunks = slice_audio(mp3_path, vid)
            yield _sse_event("progress", {
                "step": "sliced",
                "message": f"Audio split into {len(chunks)} chunk(s)"
            })

            # ── Step 3: Transcribe with progress callback ──────────────
            def on_progress(step, msg):
                """This is a closure – we can't yield from here directly,
                so we stash messages and yield them after each chunk."""
                on_progress.pending.append((step, msg))
            on_progress.pending = []

            # We transcribe chunk-by-chunk so we can yield progress in between
            import whisper
            model = whisper.load_model(model_name)
            all_results = []

            # Pre-compute chunk time labels
            chunk_start_minutes = []
            if len(chunks) > 1:
                from pydub import AudioSegment
                offset_min = 0.0
                for c in chunks:
                    chunk_start_minutes.append(offset_min)
                    dur = len(AudioSegment.from_mp3(str(c))) / 1000.0 / 60.0
                    offset_min += dur
            else:
                chunk_start_minutes = [0.0]

            for idx, chunk_path in enumerate(chunks):
                if len(chunks) == 1:
                    msg = f"Transcribing audio with Whisper ({model_name})…"
                else:
                    start_m = int(chunk_start_minutes[idx])
                    end_m = int(chunk_start_minutes[idx + 1]) if idx + 1 < len(chunk_start_minutes) else "end"
                    msg = f"Transcribing chunk {idx+1}/{len(chunks)} ({start_m}–{end_m} min)…"

                yield _sse_event("progress", {
                    "step": "transcribing",
                    "message": msg,
                    "chunk": idx + 1,
                    "total_chunks": len(chunks),
                })

                recovery_path = TEMP_DIR / f"{vid}_result_{idx}.json"
                if recovery_path.exists():
                    with open(recovery_path, "r", encoding="utf-8") as f:
                        result = json.load(f)
                else:
                    result = model.transcribe(str(chunk_path), word_timestamps=True, verbose=False)
                    result = serialize_whisper_result(result)
                    with open(recovery_path, "w", encoding="utf-8") as f:
                        json.dump(result, f, ensure_ascii=False)
                all_results.append(result)

            # ── Step 4: Build sentences ────────────────────────────────
            yield _sse_event("progress", {
                "step": "building",
                "message": "Building sentences from transcription…"
            })
            sentences = merge_and_build_sentences(
                all_results,
                get_chunk_durations(chunks) if len(chunks) > 1 else [0.0]
            )
            srt_content = sentences_to_srt(sentences)
            srt_adjusted = sentences_to_srt(
                refine_end_times_by_silence(sentences, mp3_path)
            ) if enable_volume else ""

            # Save SRTs to library
            orig_srt_path = USER_UPLOADS_DIR / f"{file_id}.original.srt"
            mod_srt_path = USER_UPLOADS_DIR / f"{file_id}.modified.srt"
            orig_srt_path.write_text(srt_content, encoding="utf-8")
            if srt_adjusted:
                mod_srt_path.write_text(srt_adjusted, encoding="utf-8")

            # ── Step 5: Extract waveform ───────────────────────────────
            yield _sse_event("progress", {
                "step": "waveform",
                "message": "Extracting audio waveform…"
            })
            waveform_peaks = extract_waveform_peaks(mp3_path)
            peaks_path = USER_UPLOADS_DIR / f"{file_id}.peaks.json"
            peaks_path.write_text(json.dumps(waveform_peaks), encoding="utf-8")

            # ── Step 6: Encode audio ───────────────────────────────────
            yield _sse_event("progress", {
                "step": "encoding",
                "message": "Preparing audio for playback…"
            })
            with open(mp3_path, "rb") as f:
                audio_b64 = base64.b64encode(f.read()).decode("ascii")

            cleanup_temp_files(vid)

            # ── Final result ───────────────────────────────────────────
            yield _sse_event("done", {
                "audio_base64": audio_b64,
                "audio_filename": f"{safe_title}.mp3",
                "srt_content": srt_content,
                "srt_content_adjusted": srt_adjusted,
                "sentence_count": len(sentences),
                "waveform_peaks": waveform_peaks,
                "file_id": file_id,
            })

        except Exception as e:
            traceback.print_exc()
            yield _sse_event("error", {"error": str(e)})

    return Response(
        stream_with_context(generate()),
        mimetype="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
            "Access-Control-Allow-Origin": "*",
        },
    )

@app.route("/api/transcribe-upload", methods=["POST", "OPTIONS"])
def transcribe_upload():
    if request.method == "OPTIONS": return "", 204
    print(f"[transcribe-upload] files keys: {list(request.files.keys())}", flush=True)
    print(f"[transcribe-upload] form keys: {list(request.form.keys())}", flush=True)
    if "file" not in request.files: return jsonify({"error": "No file uploaded"}), 400
    audio_file = request.files["file"]
    model_name = request.form.get("model", "base")
    enable_volume = request.form.get("enable_volume_adjustment", "true").lower() == "true"
    force_transcribe = request.form.get("force_transcribe", "false").lower() == "true"
    if not audio_file.filename: return jsonify({"error": "Empty filename"}), 400
    print(f"[transcribe-upload] filename={audio_file.filename}, model={model_name}", flush=True)
    file_id = hashlib.md5(audio_file.filename.encode()).hexdigest()[:12]
    mp3_path = USER_UPLOADS_DIR / f"{file_id}.mp3"
    orig_srt_path = USER_UPLOADS_DIR / f"{file_id}.original.srt"
    mod_srt_path = USER_UPLOADS_DIR / f"{file_id}.modified.srt"
    meta_path = USER_UPLOADS_DIR / f"{file_id}.json"
    
    try:
        if mp3_path.exists() and orig_srt_path.exists() and not force_transcribe:
            orig_content = orig_srt_path.read_text(encoding="utf-8")
            mod_content = mod_srt_path.read_text(encoding="utf-8") if mod_srt_path.exists() else ""
            # Load starred_indices from meta
            meta_path = USER_UPLOADS_DIR / f"{file_id}.json"
            starred_indices = []
            if meta_path.exists():
                try:
                    meta = json.loads(meta_path.read_text(encoding="utf-8"))
                    starred_indices = meta.get("starred_indices", [])
                except: pass

            return jsonify({
                "exists": True,
                "file_id": file_id,
                "filename": audio_file.filename,
                "original_srt": orig_content,
                "modified_srt": mod_content,
                "starred_indices": starred_indices
            })
            
        # Always save the file to ensure we're not using a corrupted/truncated version
        audio_file.save(str(mp3_path))
        file_size = mp3_path.stat().st_size
        print(f"[transcribe-upload] saved to {mp3_path} ({file_size} bytes)", flush=True)
        safe_name = re.sub(r'[^\w\s-]', '', audio_file.filename).strip().replace(' ', '_')[:60]
        if not safe_name.lower().endswith('.mp3'): safe_name += '.mp3'
        
        # Save meta
        meta_info = {
            "title": audio_file.filename,
            "filename": safe_name,
            "date": datetime.datetime.now().isoformat()
        }
        meta_path.write_text(json.dumps(meta_info, ensure_ascii=False), encoding="utf-8")

        print(f"[transcribe-upload] slicing audio...", flush=True)
        chunks = slice_audio(mp3_path, file_id)
        print(f"[transcribe-upload] {len(chunks)} chunk(s), transcribing with model={model_name}...", flush=True)
        results = transcribe_chunks(chunks, file_id, model_name)
        print(f"[transcribe-upload] transcription done, building sentences...", flush=True)
        sentences = merge_and_build_sentences(results, get_chunk_durations(chunks) if len(chunks) > 1 else [0.0])
        srt_content = sentences_to_srt(sentences)
        srt_adjusted = sentences_to_srt(refine_end_times_by_silence(sentences, mp3_path)) if enable_volume else ""
        waveform_peaks = extract_waveform_peaks(mp3_path)
        peaks_path = USER_UPLOADS_DIR / f"{file_id}.peaks.json"
        peaks_path.write_text(json.dumps(waveform_peaks), encoding="utf-8")
        
        # Save SRTs
        orig_srt_path.write_text(srt_content, encoding="utf-8")
        if srt_adjusted:
            mod_srt_path.write_text(srt_adjusted, encoding="utf-8")
            
        print(f"[transcribe-upload] done! {len(sentences)} sentences", flush=True)
        return jsonify({"srt_content": srt_content, "srt_content_adjusted": srt_adjusted, "sentence_count": len(sentences), "waveform_peaks": waveform_peaks, "file_id": file_id})
    except Exception as e:
        print(f"[transcribe-upload] ERROR: {e}", flush=True)
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
    # Supports both JSON and FormData
    if request.is_json:
        data = request.json
    else:
        # For multipart/form-data, parameters are in request.form
        data = request.form

    filename = data.get("filename")
    # Support both naming conventions
    start_ms = data.get("start_ms") or data.get("startTime")
    end_ms = data.get("end_ms") or data.get("endTime")

    if not filename or start_ms is None or end_ms is None:
        return jsonify({"error": f"Missing params: filename={filename}, start={start_ms}, end={end_ms}"}), 400

    try:
        start_ms, end_ms = int(float(start_ms)), int(float(end_ms))
    except (ValueError, TypeError):
        return jsonify({"error": f"Invalid start/end time format: start={start_ms}, end={end_ms}"}), 400

    temp_source_path = None
    try:
        if "file" in request.files:
            # If file is uploaded, use it
            audio_file = request.files["file"]
            # Create a semi-unique temp name to avoid collisions
            safe_name = secure_filename(audio_file.filename) or "temp_audio"
            temp_source_path = TEMP_DIR / f"exp_src_{os.getpid()}_{safe_name}"
            audio_file.save(str(temp_source_path))
            mp3_path = temp_source_path
        else:
            # If no file is provided, it must be some error in the request
            return jsonify({"error": "No audio file provided in request"}), 400

        if not mp3_path.exists():
            return jsonify({"error": "Source audio file failed to save"}), 500

        from pydub import AudioSegment
        audio = AudioSegment.from_mp3(str(mp3_path))
        
        # Clamp milliseconds to audio length
        start_ms = max(0, min(start_ms, len(audio)))
        end_ms = max(0, min(end_ms, len(audio)))
        
        segment = audio[start_ms:end_ms]

        # Apply gain to normalize
        TARGET_DBFS = -12.0
        if segment.dBFS != float("-inf") and len(segment) > 0:
            diff = TARGET_DBFS - segment.dBFS
            # Don't boost too much if it's very quiet to avoid noise
            segment = segment.apply_gain(max(-20.0, min(20.0, diff)))

        buf = io.BytesIO()
        # Correct method name is .export() not .exports()
        segment.export(buf, format="mp3", bitrate="192k")
        buf.seek(0)
        
        # Cleanup temp file immediately
        if temp_source_path and temp_source_path.exists():
            temp_source_path.unlink()

        return send_file(buf, mimetype="audio/mpeg", as_attachment=True, download_name=filename)
    except Exception as e:
        if temp_source_path and temp_source_path.exists():
            try: temp_source_path.unlink()
            except: pass
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

@app.route("/api/dashboard-files", methods=["GET"])
def dashboard_files():
    try:
        files = []
        for meta_path in USER_UPLOADS_DIR.glob("*.json"):
            file_id = meta_path.stem
            try:
                meta = json.loads(meta_path.read_text(encoding="utf-8"))
                has_mod = (USER_UPLOADS_DIR / f"{file_id}.modified.srt").exists()
                meta["id"] = file_id
                meta["has_modified_srt"] = has_mod
                files.append(meta)
            except:
                pass
        # Sort by date desc
        files.sort(key=lambda x: x.get("date", ""), reverse=True)
        return jsonify({"files": files})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/api/load-dashboard-file/<file_id>", methods=["GET"])
def load_dashboard_file(file_id):
    try:
        mp3_path = USER_UPLOADS_DIR / f"{file_id}.mp3"
        orig_path = USER_UPLOADS_DIR / f"{file_id}.original.srt"
        mod_path = USER_UPLOADS_DIR / f"{file_id}.modified.srt"
        
        if not mp3_path.exists():
            return jsonify({"error": "File not found"}), 404
            
        with open(mp3_path, "rb") as f: audio_b64 = base64.b64encode(f.read()).decode("ascii")
        
        orig_content = orig_path.read_text(encoding="utf-8") if orig_path.exists() else ""
        mod_content = mod_path.read_text(encoding="utf-8") if mod_path.exists() else ""
        
        # Load peaks if available, else calc
        peaks_path = USER_UPLOADS_DIR / f"{file_id}.peaks.json"
        if peaks_path.exists():
            try:
                waveform_peaks = json.loads(peaks_path.read_text(encoding="utf-8"))
            except Exception:
                waveform_peaks = extract_waveform_peaks(mp3_path)
                peaks_path.write_text(json.dumps(waveform_peaks), encoding="utf-8")
        else:
            waveform_peaks = extract_waveform_peaks(mp3_path)
            peaks_path.write_text(json.dumps(waveform_peaks), encoding="utf-8")
        
        # Load meta for starred_indices
        meta_path = USER_UPLOADS_DIR / f"{file_id}.json"
        starred_indices = []
        if meta_path.exists():
            try:
                meta = json.loads(meta_path.read_text(encoding="utf-8"))
                starred_indices = meta.get("starred_indices", [])
            except: pass

        return jsonify({
            "audio_base64": audio_b64,
            "original_srt": orig_content,
            "modified_srt": mod_content,
            "filename": f"{file_id}.mp3",
            "waveform_peaks": waveform_peaks,
            "starred_indices": starred_indices
        })
    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500

@app.route("/api/save-srt", methods=["POST"])
def save_srt():
    data = request.get_json()
    file_id = data.get("file_id")
    srt_content = data.get("srt_content", "")
    srt_type = data.get("type", "modified") # 'original' or 'modified'
    starred_indices = data.get("starred_indices") # Optional list of IDs/indices
    if not file_id: return jsonify({"error": "No file_id provided"}), 400
    try:
        # Save SRT
        save_path = USER_UPLOADS_DIR / f"{file_id}.{srt_type}.srt"
        save_path.write_text(srt_content, encoding="utf-8")
        
        # Save starred_indices to meta if provided
        if starred_indices is not None:
            meta_path = USER_UPLOADS_DIR / f"{file_id}.json"
            if meta_path.exists():
                meta = json.loads(meta_path.read_text(encoding="utf-8"))
                meta["starred_indices"] = starred_indices
                meta_path.write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
        
        return jsonify({"success": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/api/delete-dashboard-file/<file_id>", methods=["DELETE"])
def delete_dashboard_file(file_id):
    try:
        # Define all possible file extensions for a library entry
        extensions = [".mp3", ".json", ".original.srt", ".modified.srt", ".peaks.json"]
        deleted_count = 0
        for ext in extensions:
            file_path = USER_UPLOADS_DIR / f"{file_id}{ext}"
            if file_path.exists():
                file_path.unlink()
                deleted_count += 1
        
        if deleted_count == 0:
            return jsonify({"error": "No files found for this ID"}), 404
            
        return jsonify({"success": True, "deleted_files": deleted_count})
    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500

if __name__ == "__main__":
    print("LinguaPlayer Backend started on port 5000")
    app.run(host="0.0.0.0", port=5000)
