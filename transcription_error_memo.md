# Memo: Avoiding the "Unknown error" in Transcription
Date: 2026-03-21

## Key Mistakes to Avoid:

### 1. Double CORS Headers
- **Error:** Using both \lask_cors\ and a manual \fter_request\ handler adding \Access-Control-Allow-Origin: *\.
- **Fix:** Use only \lask_cors\ and remove manual header manipulation.

### 2. Corrupted File Reuse
- **Error:** Checking \if not exists()\ before saving an uploaded file.
- **Fix:** Always overwrite uploaded files (or use unique IDs) to ensure we rotate away from corrupted or truncated versions.

### 3. Vague Error Reporting
- **Error:** Defaulting to "Unknown error" on JSON parse failure.
- **Fix:** Always capture \es.text()\ and show a snippet of it alongside the status code in the UI.

### 4. Payload Limits
- **Error:** Relying on default \MAX_CONTENT_LENGTH\.
- **Fix:** Explicitly set large enough limits for audio files (e.g. 200MB).
