# Memo: Avoiding "Internal Server Error" & 500 HTML Crashes

## Date: 2026-03-21
## System: Windows 11 / Flask + Next.js

---

### 1. The "Unicode Logging" Death (Critical for Windows)
*   **Mistake:** Using `print()` with raw non-ASCII data (like filenames with Chinese characters or emojis 🎵) in a Windows terminal that defaults to `cp1252` encoding.
*   **Symptom:** Silent thread crash or `UnicodeEncodeError`. Flask returns a standard HTML 500 page because the route handler crashes mid-execution.
*   **Fix:** 
    *   Set `PYTHONUTF8=1` in the environment.
    *   Avoid printing raw `filename` directly; use `repr(filename)` or sanitize it.
    *   Remove all emojis and special characters from log messages.

### 2. The "localhost" vs "127.0.0.1" Trap
*   **Mistake:** Using `http://localhost:5000` in the frontend.
*   **Symptom:** Browsers often resolve `localhost` to `[::1]` (IPv6), while Flask typically listens on `0.0.0.0` (IPv4). This causes the request to either hang, fail, or hit a different service entirely.
*   **Fix:** **Always** use `http://127.0.0.1:5000` for the `BACKEND_URL` in development to ensure consistent IPv4 routing.

### 3. Zombie Process Hijacking
*   **Mistake:** Not killing existing Python processes before restart.
*   **Symptom:** Multiple processes listening on port 5000. New code changes don't take effect because requests hit the old "zombie" process still running in the background.
*   **Fix:** Use `Get-Process python* | Stop-Process -Force` (PowerShell) before every restart to clear all stale handlers.

### 4. Mandatory JSON Error Handlers
*   **Mistake:** Relying on default Flask error pages.
*   **Symptom:** Frontend receives `<!doctype html>...` which crashes JSON parsers like `res.json()`, leading to "Unknown error" messages in the UI.
*   **Fix:** Implement global error handlers in `app.py`:
    ```python
    @app.errorhandler(500)
    def handle_500(e):
        return jsonify({"error": f"Internal server error: {str(e)}"}), 500
    
    @app.errorhandler(413) # Payload Too Large
    def handle_413(e):
        return jsonify({"error": "File too large (Max 200MB)"}), 413
    ```

### 5. Proper CORS Placement
*   **Mistake:** Manual header injection in `@after_request` conflicting with `flask_cors`.
*   **Fix:** Use `flask_cors` for the basic setup and ensure `OPTIONS` requests (preflight) are handled directly in the route or the global CORS config.
