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
from pathlib import Path

# ── Directories ─────────────────────────────────────────────────────────
# Persistent cache: final MP3s live here between runs / reboots
MP3_CACHE_DIR = Path(__file__).parent / "mp3_cache"
MP3_CACHE_DIR.mkdir(exist_ok=True)
# Ephemeral scratch: audio chunks + Whisper recovery JSON (large, OK to lose)
TEMP_DIR = Path(tempfile.gettempdir()) / "lingua_player"
TEMP_DIR.mkdir(exist_ok=True)

from flask import Flask, request, jsonify, send_file
from flask_cors import CORS

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



MAX_CHUNK_DURATION_MS = 9 * 60 * 1000  # 9 minutes in ms
SILENCE_THRESH_DB = -40  # dB threshold for silence detection
MIN_SILENCE_LEN_MS = 500  # minimum silence length in ms
SILENCE_SEARCH_WINDOW_MS = 2 * 60 * 1000  # search for silence within last 2 min of chunk


def get_video_id(url: str) -> str:
    """Extract a stable ID from the URL for caching / recovery."""
    return hashlib.md5(url.encode()).hexdigest()[:12]


# ── Step 1: Download audio ──────────────────────────────────────────────

def _meta_path(video_id: str) -> Path:
    return MP3_CACHE_DIR / f"{video_id}.json"


def _mp3_path(video_id: str) -> Path:
    return MP3_CACHE_DIR / f"{video_id}.mp3"


def download_audio(url: str, video_id: str) -> Path:
    """Download YouTube audio as MP3 into the persistent cache dir.
    If the file already exists, returns immediately (cache hit).
    Also writes a sidecar .json with the video title.
    """
    import yt_dlp

    output_path = _mp3_path(video_id)
    if output_path.exists():
        print(f"  ✓ Cache hit: {output_path.name}")
        return output_path

    # Download to a temp location first, then move to the cache dir
    tmp_output = TEMP_DIR / f"{video_id}.%(ext)s"
    ydl_opts = {
        "format": "bestaudio/best",
        "outtmpl": str(tmp_output),
        "postprocessors": [
            {
                "key": "FFmpegExtractAudio",
                "preferredcodec": "mp3",
                "preferredquality": "192",
            }
        ],
        "quiet": True,
        "no_warnings": True,
    }

    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(url, download=True)
        title = info.get("title", video_id)
        duration = info.get("duration", 0)
        thumbnail = info.get("thumbnail", "")

    # Move finished MP3 from temp → persistent cache
    tmp_mp3 = TEMP_DIR / f"{video_id}.mp3"
    if tmp_mp3.exists():
        tmp_mp3.rename(output_path)

    # Write sidecar metadata (title, url, duration)
    meta = {"title": title, "url": url, "duration": duration, "thumbnail": thumbnail}
    _meta_path(video_id).write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")

    return output_path


def get_video_title(url: str, video_id: str | None = None) -> str:
    """Get video title. Checks the sidecar cache first — avoids a network call."""
    if video_id:
        meta_file = _meta_path(video_id)
        if meta_file.exists():
            try:
                return json.loads(meta_file.read_text(encoding="utf-8")).get("title", "youtube_audio")
            except Exception:
                pass
    import yt_dlp
    try:
        with yt_dlp.YoutubeDL({"quiet": True, "no_warnings": True}) as ydl:
            info = ydl.extract_info(url, download=False)
            return info.get("title", "youtube_audio")
    except Exception:
        return "youtube_audio"


# ── Step 2: Slice long audio at silence boundaries ──────────────────────

def slice_audio(mp3_path: Path, video_id: str) -> list[Path]:
    """
    If the audio is longer than 10 minutes, slice it into ≤9-min chunks
    at silence boundaries so sentences aren't cut mid-word.
    Returns a list of chunk file paths.
    """
    from pydub import AudioSegment
    from pydub.silence import detect_silence

    audio = AudioSegment.from_mp3(str(mp3_path))
    total_ms = len(audio)

    if total_ms <= MAX_CHUNK_DURATION_MS + 60_000:  # ≤10 min, no slicing
        return [mp3_path]

    chunks: list[Path] = []
    offset = 0
    chunk_idx = 0

    while offset < total_ms:
        remaining = total_ms - offset

        if remaining <= MAX_CHUNK_DURATION_MS + 60_000:
            # Remaining audio is short enough — take it all
            chunk = audio[offset:]
            chunk_path = TEMP_DIR / f"{video_id}_chunk_{chunk_idx}.mp3"
            chunk.export(str(chunk_path), format="mp3")
            chunks.append(chunk_path)
            break

        # Look for silence near the 9-min mark
        search_start = offset + MAX_CHUNK_DURATION_MS - SILENCE_SEARCH_WINDOW_MS
        search_end = offset + MAX_CHUNK_DURATION_MS
        search_segment = audio[search_start:search_end]

        silences = detect_silence(
            search_segment,
            min_silence_len=MIN_SILENCE_LEN_MS,
            silence_thresh=SILENCE_THRESH_DB,
        )

        if silences:
            # Use the LAST silence found (closest to 9 min mark)
            last_silence = silences[-1]
            # Cut at the middle of the silence
            cut_point = search_start + (last_silence[0] + last_silence[1]) // 2
        else:
            # No silence found — just cut at 9 min
            cut_point = offset + MAX_CHUNK_DURATION_MS

        chunk = audio[offset:cut_point]
        chunk_path = TEMP_DIR / f"{video_id}_chunk_{chunk_idx}.mp3"
        chunk.export(str(chunk_path), format="mp3")
        chunks.append(chunk_path)

        offset = cut_point
        chunk_idx += 1

    return chunks


# ── Step 3: Transcribe with Whisper (crash-recoverable) ─────────────────

def transcribe_chunks(chunks: list[Path], video_id: str, model_name: str) -> list[dict]:
    """
    Transcribe each chunk with Whisper. Saves partial results to temp JSON
    files so that if the process crashes, it can resume without re-transcribing
    already-done chunks.
    """
    import whisper

    model = whisper.load_model(model_name)
    all_results = []

    for idx, chunk_path in enumerate(chunks):
        recovery_path = TEMP_DIR / f"{video_id}_result_{idx}.json"

        if recovery_path.exists():
            # Recover from previous run
            with open(recovery_path, "r", encoding="utf-8") as f:
                result = json.load(f)
            print(f"  ✓ Chunk {idx} recovered from cache")
        else:
            print(f"  ⏳ Transcribing chunk {idx}/{len(chunks)-1} ...")
            result = model.transcribe(
                str(chunk_path),
                word_timestamps=True,
                verbose=False,
            )
            # Convert to serialisable form
            result = serialize_whisper_result(result)
            # Save for crash recovery
            with open(recovery_path, "w", encoding="utf-8") as f:
                json.dump(result, f, ensure_ascii=False)
            print(f"  ✓ Chunk {idx} done")

        all_results.append(result)

    return all_results


def serialize_whisper_result(result: dict) -> dict:
    """Convert Whisper result to a JSON-serialisable dict."""
    segments = []
    for seg in result.get("segments", []):
        s = {
            "start": seg["start"],
            "end": seg["end"],
            "text": seg["text"],
            "words": [],
        }
        for w in seg.get("words", []):
            s["words"].append({
                "word": w["word"],
                "start": w["start"],
                "end": w["end"],
            })
        segments.append(s)
    return {"segments": segments, "language": result.get("language", "en")}


# ── Step 4: Merge chunks & build sentences ──────────────────────────────

def get_chunk_durations(chunks: list[Path]) -> list[float]:
    """Get duration in seconds for each chunk."""
    from pydub import AudioSegment
    durations = []
    for c in chunks:
        audio = AudioSegment.from_mp3(str(c))
        durations.append(len(audio) / 1000.0)
    return durations


def merge_and_build_sentences(
    results: list[dict], chunk_durations: list[float]
) -> list[dict]:
    """
    Merge multi-chunk results with time offsets, then group words into
    full sentences using punctuation (. ? ! … ; :).
    """
    SENTENCE_ENDERS = re.compile(r'[.?!\u2026;:]$')

    # Collect all words with global timestamps
    all_words = []
    time_offset = 0.0

    for idx, result in enumerate(results):
        for seg in result["segments"]:
            for w in seg.get("words", []):
                all_words.append({
                    "word": w["word"],
                    "start": w["start"] + time_offset,
                    "end": w["end"] + time_offset,
                })
        if idx < len(chunk_durations):
            time_offset += chunk_durations[idx]

    if not all_words:
        return []

    # Group words into sentences
    sentences = []
    current_words: list[dict] = []

    for word in all_words:
        current_words.append(word)
        stripped = word["word"].strip()
        if SENTENCE_ENDERS.search(stripped):
            sentence_text = "".join(w["word"] for w in current_words).strip()
            sentences.append({
                "start": current_words[0]["start"],
                "end": current_words[-1]["end"],
                "text": sentence_text,
            })
            current_words = []

    # Flush remaining words as a sentence
    if current_words:
        sentence_text = "".join(w["word"] for w in current_words).strip()
        sentences.append({
            "start": current_words[0]["start"],
            "end": current_words[-1]["end"],
            "text": sentence_text,
        })

    return sentences


# ── Step 4b: Refine end-times using audio volume ─────────────────────────

def refine_end_times_by_silence(
    sentences: list[dict],
    mp3_path: Path,
    look_ahead_ms: int = 800,
    silence_thresh_db: float = -38.0,
    frame_ms: int = 20,
) -> list[dict]:
    """
    For each sentence, scan the audio starting just before (50 ms) the
    Whisper end-time up to `look_ahead_ms` ms forward.  The first frame
    whose RMS falls below `silence_thresh_db` becomes the new end-time.
    If no silence is found the original end-time is kept unchanged.

    Returns a NEW list of sentences (originals are not mutated).
    """
    from pydub import AudioSegment

    try:
        audio = AudioSegment.from_mp3(str(mp3_path))
    except Exception as e:
        print(f"  ⚠ refine_end_times: could not load audio — {e}")
        return sentences  # fall back to originals

    total_ms = len(audio)
    refined = []

    for s in sentences:
        orig_end_ms = int(s["end"] * 1000)
        # start scanning slightly before the whisper end to catch early silence
        scan_start_ms = max(0, orig_end_ms - 50)
        scan_end_ms   = min(total_ms, orig_end_ms + look_ahead_ms)

        new_end_ms = orig_end_ms  # default: keep original

        t = scan_start_ms
        while t + frame_ms <= scan_end_ms:
            frame = audio[t : t + frame_ms]
            if frame.dBFS < silence_thresh_db or frame.dBFS == float('-inf'):
                new_end_ms = t
                break
            t += frame_ms

        refined.append({
            "start": s["start"],
            "end":   new_end_ms / 1000.0,
            "text":  s["text"],
        })

    print(f"  ✓ refine_end_times: adjusted {sum(1 for o, r in zip(sentences, refined) if abs(o['end'] - r['end']) > 0.02)} / {len(sentences)} end-times")
    return refined


# ── Step 5: Format as SRT ───────────────────────────────────────────────

def seconds_to_srt_time(seconds: float) -> str:
    """Convert seconds to SRT timestamp format HH:MM:SS,mmm"""
    hours = int(seconds // 3600)
    minutes = int((seconds % 3600) // 60)
    secs = int(seconds % 60)
    millis = int(round((seconds - int(seconds)) * 1000))
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{millis:03d}"


def sentences_to_srt(sentences: list[dict]) -> str:
    """Convert sentence list to SRT format string."""
    lines = []
    for idx, s in enumerate(sentences, 1):
        lines.append(str(idx))
        lines.append(
            f"{seconds_to_srt_time(s['start'])} --> {seconds_to_srt_time(s['end'])}"
        )
        lines.append(s["text"])
        lines.append("")  # blank line separator
    return "\n".join(lines)


# ── Cleanup helpers ─────────────────────────────────────────────────────

def cleanup_temp_files(video_id: str):
    """Remove ephemeral chunk and Whisper recovery files from TEMP_DIR.
    The MP3 in MP3_CACHE_DIR is intentionally preserved.
    """
    for f in TEMP_DIR.glob(f"{video_id}_chunk_*"):
        f.unlink(missing_ok=True)
    for f in TEMP_DIR.glob(f"{video_id}_result_*"):
        f.unlink(missing_ok=True)


# ── Flask endpoints ─────────────────────────────────────────────────────

@app.route("/api/youtube-info", methods=["POST"])
def youtube_info():
    """Return video title and duration. Checks sidecar cache first."""
    data = request.get_json()
    url = data.get("url", "").strip()
    if not url:
        return jsonify({"error": "No URL provided"}), 400
    video_id = get_video_id(url)
    meta_file = _meta_path(video_id)
    if meta_file.exists():
        try:
            meta = json.loads(meta_file.read_text(encoding="utf-8"))
            return jsonify({"title": meta.get("title", ""),
                            "duration": meta.get("duration", 0),
                            "thumbnail": meta.get("thumbnail", ""),
                            "cached": True})
        except Exception:
            pass
    try:
        import yt_dlp
        with yt_dlp.YoutubeDL({"quiet": True, "no_warnings": True}) as ydl:
            info = ydl.extract_info(url, download=False)
            return jsonify({
                "title": info.get("title", ""),
                "duration": info.get("duration", 0),
                "thumbnail": info.get("thumbnail", ""),
                "cached": False,
            })
    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


@app.route("/api/download-mp3", methods=["POST"])
def download_mp3():
    """Serve cached MP3 (or download + cache first)."""
    data = request.get_json()
    url = data.get("url", "").strip()
    if not url:
        return jsonify({"error": "No URL provided"}), 400

    video_id = get_video_id(url)

    try:
        cached = _mp3_path(video_id).exists()
        print(f"[download-mp3] {'Cache hit' if cached else 'Downloading'}: {url}")
        mp3_path = download_audio(url, video_id)
        title = get_video_title(url, video_id)
        safe_title = re.sub(r'[^\w\s-]', '', title).strip().replace(' ', '_')[:60]
        filename = f"{safe_title}.mp3" if safe_title else f"{video_id}.mp3"

        print(f"[download-mp3] Serving: {filename}")
        return send_file(
            mp3_path,
            mimetype="audio/mpeg",
            as_attachment=True,
            download_name=filename,
        )
    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500



@app.route("/api/process-youtube", methods=["POST"])
def process_youtube():
    data = request.get_json()
    url = data.get("url", "").strip()
    model_name = data.get("model", "base")
    enable_volume = data.get("enable_volume_adjustment", True)

    if not url:
        return jsonify({"error": "No URL provided"}), 400
    if model_name not in ("base", "small", "medium"):
        return jsonify({"error": "Invalid model. Choose base, small, or medium."}), 400

    video_id = get_video_id(url)

    try:
        # 1. Download (cache hit if already downloaded)
        cached = _mp3_path(video_id).exists()
        print(f"[1/4] {'Cache hit — skipping download' if cached else 'Downloading audio from'}: {url}")
        mp3_path = download_audio(url, video_id)
        title = get_video_title(url, video_id)  # reads from sidecar, no network call if cached
        safe_title = re.sub(r'[^\w\s-]', '', title).strip().replace(' ', '_')[:60]

        # 2. Slice
        print(f"[2/4] Slicing audio if needed ...")
        chunks = slice_audio(mp3_path, video_id)
        chunk_durations = get_chunk_durations(chunks) if len(chunks) > 1 else [0.0]
        print(f"       → {len(chunks)} chunk(s)")

        # 3. Transcribe
        print(f"[3/4] Transcribing with Whisper ({model_name}) ...")
        results = transcribe_chunks(chunks, video_id, model_name)

        # 4. Merge & build SRT
        print(f"[4/4] Building SRT ...")
        if len(chunks) == 1:
            # Single chunk — use original timestamps directly
            chunk_durations = [0.0]
        sentences = merge_and_build_sentences(results, chunk_durations)
        srt_content = sentences_to_srt(sentences)

        # 4b. Volume-refined SRT
        if enable_volume:
            print(f"[4b/4] Refining end-times by silence ...")
            sentences_adjusted = refine_end_times_by_silence(sentences, mp3_path)
            srt_content_adjusted = sentences_to_srt(sentences_adjusted)
        else:
            print(f"[4b/4] Skipping volume refinement ...")
            srt_content_adjusted = ""

        # Read the full MP3 for the frontend
        with open(mp3_path, "rb") as f:
            audio_b64 = base64.b64encode(f.read()).decode("ascii")

        # Cleanup temp chunk / recovery files (MP3 in mp3_cache/ is kept)
        cleanup_temp_files(video_id)

        print(f"Done! {len(sentences)} sentences generated.")

        return jsonify({
            "audio_base64": audio_b64,
            "audio_filename": f"{safe_title}.mp3",
            "srt_content": srt_content,
            "srt_content_adjusted": srt_content_adjusted,
            "sentence_count": len(sentences),
        })

    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


# ── Podcast helpers ─────────────────────────────────────────────────────

def _is_direct_audio_url(url: str) -> bool:
    """Check if the URL points directly to an audio file."""
    from urllib.parse import urlparse
    path = urlparse(url).path.lower()
    # Strip query params — some CDN URLs have ?token=... after the extension
    return any(path.endswith(ext) for ext in ('.mp3', '.m4a', '.ogg', '.wav', '.aac', '.opus', '.flac'))


def download_podcast_audio(url: str, podcast_id: str) -> tuple[Path, str]:
    """Download podcast audio into the persistent cache dir.
    Returns (mp3_path, title).
    If the file already exists, returns immediately (cache hit).
    """
    output_path = _mp3_path(podcast_id)
    meta_file = _meta_path(podcast_id)

    if output_path.exists():
        print(f"  ✓ Podcast cache hit: {output_path.name}")
        title = podcast_id
        if meta_file.exists():
            try:
                title = json.loads(meta_file.read_text(encoding='utf-8')).get('title', podcast_id)
            except Exception:
                pass
        return output_path, title

    if _is_direct_audio_url(url):
        # ── Strategy 1: Direct HTTP download ────────────────────────────
        import requests as http_requests
        from urllib.parse import urlparse, unquote

        print(f"  ⬇ Direct download: {url}")
        resp = http_requests.get(url, stream=True, timeout=120,
                                 headers={'User-Agent': 'Mozilla/5.0'})
        resp.raise_for_status()

        # Determine a title from the filename in the URL
        url_path = unquote(urlparse(url).path)
        raw_name = os.path.splitext(os.path.basename(url_path))[0] or podcast_id
        title = raw_name.replace('_', ' ').replace('-', ' ').strip()

        ext = os.path.splitext(urlparse(url).path)[1].lower() or '.mp3'
        tmp_raw = TEMP_DIR / f"{podcast_id}_raw{ext}"
        with open(tmp_raw, 'wb') as f:
            for chunk in resp.iter_content(chunk_size=1024 * 64):
                f.write(chunk)

        if ext == '.mp3':
            shutil.move(str(tmp_raw), str(output_path))
        else:
            # Convert to MP3 via pydub
            from pydub import AudioSegment
            audio_seg = AudioSegment.from_file(str(tmp_raw))
            audio_seg.export(str(output_path), format='mp3', bitrate='192k')
            tmp_raw.unlink(missing_ok=True)
    else:
        # ── Strategy 2: yt-dlp (supports many podcast platforms) ────────
        import yt_dlp
        print(f"  ⬇ yt-dlp download: {url}")
        tmp_output = TEMP_DIR / f"{podcast_id}.%(ext)s"
        ydl_opts = {
            'format': 'bestaudio/best',
            'outtmpl': str(tmp_output),
            'postprocessors': [{
                'key': 'FFmpegExtractAudio',
                'preferredcodec': 'mp3',
                'preferredquality': '192',
            }],
            'quiet': True,
            'no_warnings': True,
        }
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=True)
            title = info.get('title', podcast_id)

        tmp_mp3 = TEMP_DIR / f"{podcast_id}.mp3"
        if tmp_mp3.exists():
            shutil.move(str(tmp_mp3), str(output_path))
        else:
            # yt-dlp may have saved with a different extension — find & convert
            for f in TEMP_DIR.glob(f"{podcast_id}.*"):
                if f.suffix.lower() in ('.mp3', '.m4a', '.webm', '.opus', '.ogg'):
                    if f.suffix.lower() == '.mp3':
                        shutil.move(str(f), str(output_path))
                    else:
                        from pydub import AudioSegment
                        audio_seg = AudioSegment.from_file(str(f))
                        audio_seg.export(str(output_path), format='mp3', bitrate='192k')
                        f.unlink(missing_ok=True)
                    break

    if not output_path.exists():
        raise RuntimeError(f"Failed to download audio from: {url}")

    # Write sidecar metadata
    meta = {'title': title, 'url': url, 'source': 'podcast'}
    meta_file.write_text(json.dumps(meta, ensure_ascii=False), encoding='utf-8')

    return output_path, title


@app.route('/api/process-podcast', methods=['POST'])
def process_podcast():
    data = request.get_json()
    url = data.get('url', '').strip()
    model_name = data.get('model', 'base')
    enable_volume = data.get("enable_volume_adjustment", True)

    if not url:
        return jsonify({'error': 'No URL provided'}), 400
    if model_name not in ('base', 'small', 'medium'):
        return jsonify({'error': 'Invalid model. Choose base, small, or medium.'}), 400

    podcast_id = get_video_id(url)

    try:
        # 1. Download
        cached = _mp3_path(podcast_id).exists()
        print(f"[1/4] {'Cache hit — skipping download' if cached else 'Downloading podcast audio from'}: {url}")
        mp3_path, title = download_podcast_audio(url, podcast_id)
        safe_title = re.sub(r'[^\w\s-]', '', title).strip().replace(' ', '_')[:60]

        # 2. Slice
        print(f"[2/4] Slicing audio if needed ...")
        chunks = slice_audio(mp3_path, podcast_id)
        chunk_durations = get_chunk_durations(chunks) if len(chunks) > 1 else [0.0]
        print(f"       → {len(chunks)} chunk(s)")

        # 3. Transcribe
        print(f"[3/4] Transcribing with Whisper ({model_name}) ...")
        results = transcribe_chunks(chunks, podcast_id, model_name)

        # 4. Merge & build SRT
        print(f"[4/4] Building SRT ...")
        if len(chunks) == 1:
            chunk_durations = [0.0]
        sentences = merge_and_build_sentences(results, chunk_durations)
        srt_content = sentences_to_srt(sentences)

        # 4b. Volume-refined SRT
        if enable_volume:
            print(f"[4b/4] Refining end-times by silence ...")
            sentences_adjusted = refine_end_times_by_silence(sentences, mp3_path)
            srt_content_adjusted = sentences_to_srt(sentences_adjusted)
        else:
            print(f"[4b/4] Skipping volume refinement ...")
            srt_content_adjusted = ""

        # Read the full MP3 for the frontend
        with open(mp3_path, 'rb') as f:
            audio_b64 = base64.b64encode(f.read()).decode('ascii')

        cleanup_temp_files(podcast_id)

        print(f"Done! {len(sentences)} sentences generated.")

        return jsonify({
            'audio_base64': audio_b64,
            'audio_filename': f"{safe_title or podcast_id}.mp3",
            'srt_content': srt_content,
            'srt_content_adjusted': srt_content_adjusted,
            'sentence_count': len(sentences),
        })

    except Exception as e:
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500


@app.route("/api/transcribe-upload", methods=["POST", "OPTIONS"])
def transcribe_upload():
    if request.method == "OPTIONS":
        return "", 204

    if "file" not in request.files:
        return jsonify({"error": "No file uploaded"}), 400

    audio_file = request.files["file"]
    model_name = request.form.get("model", "base")
    enable_volume_str = request.form.get("enable_volume_adjustment", "true").lower()
    enable_volume = enable_volume_str == "true"

    if model_name not in ("base", "small", "medium"):
        return jsonify({"error": "Invalid model. Choose base, small, or medium."}), 400

    if not audio_file.filename:
        return jsonify({"error": "Empty filename"}), 400

    # Derive a stable ID from the original filename so we can cache/recover
    file_id = hashlib.md5(audio_file.filename.encode()).hexdigest()[:12]
    mp3_path = TEMP_DIR / f"{file_id}.mp3"

    try:
        # Save uploaded file once (idempotent)
        if not mp3_path.exists():
            audio_file.save(str(mp3_path))

        safe_name = re.sub(r'[^\w\s-]', '', audio_file.filename).strip().replace(' ', '_')[:60]
        if not safe_name.endswith('.mp3'):
            safe_name = safe_name.rsplit('.', 1)[0] + '.mp3'

        # Slice if needed
        print(f"[1/3] Slicing audio if needed …")
        chunks = slice_audio(mp3_path, file_id)
        chunk_durations = get_chunk_durations(chunks) if len(chunks) > 1 else [0.0]
        print(f"       → {len(chunks)} chunk(s)")

        # Transcribe
        print(f"[2/3] Transcribing with Whisper ({model_name}) …")
        results = transcribe_chunks(chunks, file_id, model_name)

        # Build SRT
        print(f"[3/3] Building SRT …")
        if len(chunks) == 1:
            chunk_durations = [0.0]
        sentences = merge_and_build_sentences(results, chunk_durations)
        srt_content = sentences_to_srt(sentences)

        # Volume-refined SRT
        if enable_volume:
            print(f"[3b/3] Refining end-times by silence …")
            sentences_adjusted = refine_end_times_by_silence(sentences, mp3_path)
            srt_content_adjusted = sentences_to_srt(sentences_adjusted)
        else:
            print(f"[3b/3] Skipping volume refinement …")
            srt_content_adjusted = ""

        # Return the original MP3 as base64
        with open(mp3_path, "rb") as f:
            audio_b64 = base64.b64encode(f.read()).decode("ascii")

        cleanup_temp_files(file_id)

        print(f"\u2705 Done! {len(sentences)} sentences generated.")

        return jsonify({
            "audio_base64": audio_b64,
            "audio_filename": safe_name,
            "srt_content": srt_content,
            "srt_content_adjusted": srt_content_adjusted,
            "sentence_count": len(sentences),
        })

    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


@app.route("/api/cache-list", methods=["GET"])
def cache_list():
    """List all cached MP3s with their metadata."""
    items = []
    for mp3 in sorted(MP3_CACHE_DIR.glob("*.mp3")):
        video_id = mp3.stem
        meta_file = _meta_path(video_id)
        meta = {}
        if meta_file.exists():
            try:
                meta = json.loads(meta_file.read_text(encoding="utf-8"))
            except Exception:
                pass
        size_mb = round(mp3.stat().st_size / (1024 * 1024), 2)
        items.append({
            "video_id": video_id,
            "title": meta.get("title", video_id),
            "url": meta.get("url", ""),
            "duration": meta.get("duration", 0),
            "size_mb": size_mb,
        })
    return jsonify({"cached": items, "count": len(items), "cache_dir": str(MP3_CACHE_DIR)})


@app.route("/api/cache-delete", methods=["POST"])
def cache_delete():
    """Delete a specific cached MP3 and its sidecar by video_id."""
    data = request.get_json()
    video_id = data.get("video_id", "").strip()
    if not video_id or not re.match(r'^[a-f0-9]{12}$', video_id):
        return jsonify({"error": "Invalid video_id"}), 400
    _mp3_path(video_id).unlink(missing_ok=True)
    _meta_path(video_id).unlink(missing_ok=True)
    return jsonify({"deleted": video_id})


@app.route("/api/refine-srt", methods=["POST", "OPTIONS"])
def refine_srt():
    """
    Accept an MP3 file + SRT text and return a volume-adjusted SRT.
    Used when the user uploads MP3 + SRT manually (no Whisper transcription).

    Expects multipart/form-data with:
      - file: the MP3 audio file
      - srt_content: the raw SRT text
    Returns JSON: { srt_content_adjusted: str }
    """
    if request.method == "OPTIONS":
        return "", 204

    if "file" not in request.files:
        return jsonify({"error": "No audio file uploaded"}), 400

    srt_text = request.form.get("srt_content", "").strip()
    if not srt_text:
        return jsonify({"error": "No srt_content provided"}), 400

    audio_file = request.files["file"]
    if not audio_file.filename:
        return jsonify({"error": "Empty filename"}), 400

    # Save the MP3 to a temp path keyed on filename
    file_id = hashlib.md5(audio_file.filename.encode()).hexdigest()[:12]
    mp3_path = TEMP_DIR / f"refine_{file_id}.mp3"

    try:
        if not mp3_path.exists():
            audio_file.save(str(mp3_path))

        # ── Parse SRT into sentences list ──────────────────────────────────
        def srt_time_to_seconds(ts: str) -> float:
            ts = ts.replace(",", ".")
            parts = ts.split(":")
            h, m, rest = int(parts[0]), int(parts[1]), parts[2]
            s_parts = rest.split(".")
            s = int(s_parts[0])
            ms = int(s_parts[1]) if len(s_parts) > 1 else 0
            return h * 3600 + m * 60 + s + ms / 1000.0

        sentences = []
        for block in re.split(r"\n\n+", srt_text.replace("\r\n", "\n").replace("\r", "\n")):
            block = block.strip()
            if not block:
                continue
            lines = block.split("\n")
            time_line_idx = next((i for i, l in enumerate(lines) if "-->" in l), None)
            if time_line_idx is None:
                continue
            time_match = re.match(
                r"(\d{1,2}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[,.]\d{3})",
                lines[time_line_idx],
            )
            if not time_match:
                continue
            start_s = srt_time_to_seconds(time_match.group(1))
            end_s   = srt_time_to_seconds(time_match.group(2))
            text    = " ".join(lines[time_line_idx + 1:]).strip()
            if text:
                sentences.append({"start": start_s, "end": end_s, "text": text})

        if not sentences:
            return jsonify({"error": "Could not parse any subtitles from srt_content"}), 400

        # ── Refine end-times ───────────────────────────────────────────────
        print(f"[refine-srt] Refining {len(sentences)} subtitles …")
        refined = refine_end_times_by_silence(sentences, mp3_path)
        srt_adjusted = sentences_to_srt(refined)

        return jsonify({"srt_content_adjusted": srt_adjusted})

    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500
    finally:
        # Clean up temp MP3 (it was saved just for this call)
        mp3_path.unlink(missing_ok=True)


@app.route("/api/export-sentence-mp3", methods=["POST", "OPTIONS"])
def export_sentence_mp3():
    """
    Slice a region from an uploaded MP3 and return it as an MP3 file.

    Expects multipart/form-data with:
      - file: the full MP3 audio file
      - start_ms: start of the slice in milliseconds
      - end_ms:   end   of the slice in milliseconds
      - filename: desired output filename (e.g. "FRE0004.mp3")
    Returns: the sliced MP3 as a downloadable file.
    """
    if request.method == "OPTIONS":
        return "", 204

    if "file" not in request.files:
        return jsonify({"error": "No audio file uploaded"}), 400

    audio_file = request.files["file"]
    start_ms = request.form.get("start_ms")
    end_ms = request.form.get("end_ms")
    filename = request.form.get("filename", "export.mp3")

    if start_ms is None or end_ms is None:
        return jsonify({"error": "start_ms and end_ms are required"}), 400

    try:
        start_ms = int(float(start_ms))
        end_ms = int(float(end_ms))
    except (ValueError, TypeError):
        return jsonify({"error": "start_ms and end_ms must be numbers"}), 400

    # Save uploaded file to temp
    file_id = hashlib.md5(
        f"{audio_file.filename}_{start_ms}_{end_ms}".encode()
    ).hexdigest()[:12]
    mp3_path = TEMP_DIR / f"export_src_{file_id}.mp3"

    try:
        from pydub import AudioSegment
        import io

        if not mp3_path.exists():
            audio_file.save(str(mp3_path))

        audio = AudioSegment.from_mp3(str(mp3_path))
        segment = audio[start_ms:end_ms]

        # Normalize volume to -17 dBFS
        TARGET_DBFS = -15.0
        if segment.dBFS != float('-inf') and len(segment) > 0:
            gain = TARGET_DBFS - segment.dBFS
            segment = segment.apply_gain(gain)

        # Export to in-memory buffer
        buf = io.BytesIO()
        segment.export(buf, format="mp3", bitrate="192k")
        buf.seek(0)

        return send_file(
            buf,
            mimetype="audio/mpeg",
            as_attachment=True,
            download_name=filename,
        )

    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500
    finally:
        mp3_path.unlink(missing_ok=True)


if __name__ == "__main__":
    print("🎵 LinguaPlayer Backend — YouTube / Podcast to SRT + MP3 Upload")
    print(f"   MP3 cache  : {MP3_CACHE_DIR}")
    print(f"   Temp dir   : {TEMP_DIR}")
    app.run(host="0.0.0.0", port=5000, debug=False, use_reloader=False)
