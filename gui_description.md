# LinguaPlayer GUI Description

LinguaPlayer is a web-based tool for language learning and subtitle editing, featuring an automated transcription pipeline and a highly interactive playback interface.

## 1. Landing / Upload View
When no media is loaded, the application provides three primary paths to import content:

*   **From URL Section:** 
    *   **Input Field:** Paste YouTube links, podcast episode URLs, or direct MP3 links.
    *   **Whisper Model Selector:** Choose between `Base`, `Small`, or `Medium` models for transcription accuracy vs. speed.
    *   **Volume-Adjusted Toggle:** Option to generate subtitles with timestamps refined based on audio volume peaks.
    *   **Action Button:** "Download & Transcribe" starts the automated backend pipeline (audio download -> Whisper transcription -> SRT generation).

*   **Manual Upload Section:** 
    *   Two dedicated drag-and-drop zones for local files: **Audio (`.mp3`, `.wav`)** and **Subtitles (`.srt`)**.

*   **MP3 Auto-Transcribe Section:** 
    *   Appears dynamically if only an audio file is uploaded. It allows the user to trigger a Whisper transcription on the local file without needing a pre-existing SRT.

---

## 2. Pinned Player Section (Top)
Once media is loaded, the top of the interface stays pinned while the subtitle list scrolls below it.

*   **Interactive Waveform (`VolumeDisplay`):** 
    *   Visualizes audio amplitudes and peaks.
    *   **Selection Highlight:** The current sentence is highlighted with a shaded blue region.
    *   **Timing Handles:** Draggable blue vertical bars at the start and end of the highlight. Moving these enters "Timing Edit Mode."
    *   **Playhead:** A red vertical line with a circular top that tracks live playback.
    *   **Interactions:** 
        *   **Drag Background:** Continuous panning/scrubbing through the audio.
        *   **Single Click:** Selects the sentence at that timestamp.
        *   **Double Click:** Plays the sentence at that timestamp.

*   **Playback Controls:**
    *   **Pill Toggle:** Switch between "Original" and "Vol-Adjusted" (Volume Refined) timestamp modes.
    *   **Main Buttons:** Circular `Rewind`, `Play/Pause`, and `FastForward` icons.
    *   **Sentence Counter:** Displays `Current / Total` (e.g., `5/120`). Double-clicking this allows typing a number to jump directly to that sentence.

*   **Status Indicators:**
    *   **Progress Bar:** A thin horizontal bar showing the playback completion of the *current* sentence.

---

## 3. Subtitle Editor & List (Scrollable)
The bulk of the screen is a list of "Sentence Cards" that auto-scroll to keep the active sentence centered.

*   **Sentence Card Content:**
    *   **ID Badge:** Displays the sequence number.
    *   **Text Area:** Shows the transcribed text. Clicking the **Pencil icon** (or double-clicking the current sentence) enables inline text editing.
*   **Card Toolbar:**
    *   **Star (Favorite):** Mark sentences for later review or bulk export.
    *   **Tools:** **Merge** (joins with the next sentence), **Split** (divides sentence at its midpoint), and **Trash** (deletes the sentence).

---

## 4. Control Toolbar & Global Actions
Usually located at the bottom or as a floating menu:

*   **Undo:** Global button to revert the last subtitle structure change (Split/Merge/Delete).
*   **Filter (Starred Only):** A toggle to hide everything except your starred "favorite" sentences.
*   **Exports & Downloads:**
    *   **Export Starred MP3s:** Triggers the generation and download of individual audio clips for every starred sentence.
    *   **Download SRT:** Options to save the current edited original or volume-adjusted subtitle file.
    *   **Download TXT:** Exports the entire transcript as a plain text file.
