# Lingua Player - Change Log

This document summarizes the features and improvements implemented in the Lingua Player application.

---

## 1. User Interface & Layout

- **Waveform Visualization:** The prominent text display for the current sentence was replaced with a dynamic audio waveform visualizer (`VolumeDisplay`) to provide better visual context for the audio.
- **Layout Reorganization:** The scrollable subtitle list was moved to be above the main playback controls (`Previous`, `Play/Pause`, `Next`) for a more intuitive flow.
- **Taller Subtitle List:** The height of the subtitle scroll area was increased by 20% (from `h-40` to `h-48`) to display more sentences at once.

## 2. Core Functionality

### 2.1. Download & Export Buttons

Three new buttons have been added below the main progress bar:

- **Download .srt:**
  - Downloads an SRT file containing the subtitles.
  - If the "Show Starred Only" toggle is **ON**, it downloads only the starred sentences.
  - If the toggle is **OFF**, it downloads all sentences.
  - This includes any real-time edits made to the subtitle text.

- **Download .txt:**
  - Downloads a plain text file containing only the subtitle text, with no timestamps or numbering.
  - This also respects the "Show Starred Only" filter.

- **Export .md:**
  - This is a placeholder for a future feature. Currently, it shows a "Coming Soon!" notification.

### 2.2. "Buy Me a Coffee" Link

- A "Buy Me a Coffee" link has been added to the footer of the main player card to allow users to support the creator.
- The link directs to `https://buymeacoffee.com/stockcurves`.

## 3. Waveform Display Enhancements

The `VolumeDisplay` component has been significantly improved:

- **High-Fidelity Rendering:** The waveform drawing logic was updated to use the device's pixel ratio, resulting in a much sharper and crisper visual on all screens.
- **Zoomed-in View:** Instead of showing the entire audio waveform (which can be cluttered for long files), the display now focuses on a "view window" of approximately 5 sentences centered around the currently active sentence.
- **Corrected Alignment:** The positioning logic for sentence markers (vertical lines) and the highlighted region was fixed to align perfectly within the new zoomed-in view, ensuring what you see accurately represents the corresponding audio segment.
