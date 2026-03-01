# Lingua Player - Feature Proposal

## 1. Objective

This document outlines the specific functionality for the core interactive features of the Lingua Player. The goal is to define the expected behavior for sentence playback, subtitle management, and keyboard controls to ensure a smooth and intuitive user experience.

---

## 2. Feature Breakdown

### 2.1. Core Playback Controls (Buttons)

The player will have three primary control buttons:

- **Previous (`<Rewind>` icon):**
  - **Action:** Immediately stops current playback and moves the *highlight* to the previous sentence in the visible list.
  - **Does not** automatically play the new sentence.

- **Play/Pause (Large central button):**
  - **Action:** Toggles playback for the *currently highlighted* sentence.
    - If paused, it starts playing from the beginning of the sentence.
    - If playing, it pauses at the current position.
  - If the end of a sentence is reached, it will pause automatically. Pressing play again will start the *next* sentence.

- **Next (`<FastForward>` icon):**
  - **Action:** Immediately stops current playback and moves the *highlight* to the next sentence in the visible list.
  - **Does not** automatically play the new sentence.

### 2.2. Starring Sentences & Filtering

This feature allows users to bookmark important sentences.

- **Star Icon:**
  - A star icon (initially an outline) appears next to each sentence number.
  - **Clicking the star:** Toggles its state between *un-starred* (outline) and *starred* (solid fill).
  - **Important:** Clicking the star **only** changes its state and does not trigger sentence playback or change the current highlight.

- **"Show Starred Only" Toggle:**
  - This `Switch` component appears **only if at least one sentence is starred**.
  - **Toggling ON:**
    - The subtitle list is filtered to show *only* the starred sentences.
    - The highlight automatically jumps to the **first sentence** in this new, filtered list.
  - **Toggling OFF:**
    - The subtitle list reverts to showing *all* sentences.
    - The highlight returns to the sentence that was highlighted *just before* the toggle was turned on.
  - **Special Case:** If the user un-stars all sentences while the toggle is ON, the app will behave as if the toggle was switched OFF, reverting the list to show all sentences.

### 2.3. Keyboard Shortcuts

Shortcuts provide a "headless" way to interact with the player. They are active when the main interface is in focus.

- **`Spacebar`:**
  - **Action:** Functions identically to the **Play/Pause** button. Toggles playback for the highlighted sentence.

- **`ArrowLeft`:**
  - **Action:** Functions identically to the **Previous** button. Moves the highlight to the previous sentence.

- **`ArrowRight`:**
  - **Action:** Functions identically to the **Next** button. Moves the highlight to the next sentence.

- **`ArrowUp` / `ArrowDown`:**
  - **Action:** Navigates the highlight up or down the list of *visible* sentences one by one.
  - **Does not** trigger playback. The scroll area will automatically adjust to keep the highlighted sentence in view.

- **`Enter`:**
  - **Action:** Immediately starts playing the *currently highlighted* sentence from the beginning.

---

Please review this proposal. If it aligns with your expectations, I can proceed with implementing the necessary code changes. If you'd like any adjustments, let me know!