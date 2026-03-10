"use client";

import React, { useState, useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';
import type { Subtitle } from '@/app/page';
import { Button } from './button';
import { Check, X } from 'lucide-react';

interface VolumeDisplayProps {
  subtitles: Subtitle[];
  currentSentenceIndex: number;
  audioElement: HTMLAudioElement | null;
  audioFile: File | null;
  showWaveform: boolean;
  isTimingEditing: boolean;
  setIsTimingEditing: (isEditing: boolean) => void;
  onSave: (newStartTime: number, newEndTime: number) => void;
  onPlaySentence: (index: number) => void;
  onNavigateToSentence: (index: number) => void;
}

const drawWaveform = (
  canvas: HTMLCanvasElement,
  audioBuffer: AudioBuffer,
  color: string,
  viewStartTime: number,
  viewEndTime: number
) => {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const dpr = window.devicePixelRatio || 1;
  const { width, height } = canvas.getBoundingClientRect();
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  ctx.scale(dpr, dpr);

  ctx.clearRect(0, 0, width, height);

  const totalDuration = audioBuffer.duration;
  const startIndex = Math.floor((viewStartTime / totalDuration) * audioBuffer.length);
  const endIndex = Math.ceil((viewEndTime / totalDuration) * audioBuffer.length);
  const viewLength = endIndex - startIndex;

  if (viewLength <= 0) return;

  const channelData = audioBuffer.getChannelData(0).slice(startIndex, endIndex);

  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();

  const middleY = height / 2;
  const step = Math.ceil(channelData.length / width);

  for (let i = 0; i < width; i++) {
    let min = 1.0;
    let max = -1.0;
    const start = i * step;

    for (let j = 0; j < step; j++) {
      const datum = channelData[start + j];
      if (datum < min) min = datum;
      if (datum > max) max = datum;
    }

    const x = i;
    const lineHeight = Math.max(1, (max - min) * (height / 2));
    const yTop = middleY - (lineHeight / 2);

    ctx.moveTo(x, yTop);
    ctx.lineTo(x, yTop + lineHeight);
  }
  ctx.stroke();
};

const formatTime = (seconds: number): string => {
  const m = Math.floor(seconds / 60);
  const s = (seconds % 60).toFixed(2).padStart(5, '0');
  return `${m}:${s}`;
};

export function VolumeDisplay({ subtitles, currentSentenceIndex, audioElement, audioFile, showWaveform, isTimingEditing, setIsTimingEditing, onSave, onPlaySentence, onNavigateToSentence }: VolumeDisplayProps) {
  const [waveformBuffer, setWaveformBuffer] = useState<AudioBuffer | null>(null);
  const [panTick, setPanTick] = useState(0); // incremented by RAF to force re-renders during pan
  const containerRef = useRef<HTMLDivElement>(null);
  const waveformCanvasRef = useRef<HTMLCanvasElement>(null);
  const [themePrimaryColor, setThemePrimaryColor] = useState('hsl(208 26% 64%)');

  const currentSub = subtitles[currentSentenceIndex];
  const [tempStartTime, setTempStartTime] = useState(currentSub?.startTime);
  const [tempEndTime, setTempEndTime] = useState(currentSub?.endTime);

  // Use refs for drag/keyboard state to avoid stale closures in document listeners
  const draggingHandleRef = useRef<'start' | 'end' | null>(null);
  const tempStartTimeRef = useRef(tempStartTime);
  const tempEndTimeRef = useRef(tempEndTime);
  const viewStartTimeRef = useRef(0);
  const viewDurationRef = useRef(1);
  const currentSentenceIndexRef = useRef(currentSentenceIndex);
  const subtitlesRef = useRef(subtitles);
  const audioElementRef = useRef(audioElement);
  const isTimingEditingRef = useRef(isTimingEditing);
  const setIsTimingEditingRef = useRef(setIsTimingEditing);
  const onSaveRef = useRef(onSave);
  const onPlaySentenceRef = useRef(onPlaySentence);
  const onNavigateToSentenceRef = useRef(onNavigateToSentence);
  const backgroundDraggingRef = useRef(false);
  // Blocks the click handler from firing after a drag or handle-mousedown
  const clickBlockedRef = useRef(false);
  // Tracks a handle mousedown that hasn't started dragging yet (pending intent)
  const pendingEditHandleRef = useRef<'start' | 'end' | null>(null);
  // Continuous pan-drag state
  const dragRafRef = useRef<number | null>(null);
  const lastDragXRef = useRef<number>(0);
  const dragStartXRef = useRef<number>(0);
  const panViewStartRef = useRef<number | null>(null); // null = not panning
  const startDragRafRef = useRef<(() => void) | null>(null); // set by useEffect, called by onMouseDown
  // Stable view duration (computed once per render, used during pan)
  const stableViewDurationRef = useRef<number>(1);

  // Keep refs in sync
  useEffect(() => { tempStartTimeRef.current = tempStartTime; }, [tempStartTime]);
  useEffect(() => { tempEndTimeRef.current = tempEndTime; }, [tempEndTime]);
  useEffect(() => { currentSentenceIndexRef.current = currentSentenceIndex; }, [currentSentenceIndex]);
  useEffect(() => { subtitlesRef.current = subtitles; }, [subtitles]);
  useEffect(() => { audioElementRef.current = audioElement; }, [audioElement]);
  useEffect(() => { isTimingEditingRef.current = isTimingEditing; }, [isTimingEditing]);
  useEffect(() => { setIsTimingEditingRef.current = setIsTimingEditing; }, [setIsTimingEditing]);
  useEffect(() => { onSaveRef.current = onSave; }, [onSave]);
  useEffect(() => { onPlaySentenceRef.current = onPlaySentence; }, [onPlaySentence]);
  useEffect(() => { onNavigateToSentenceRef.current = onNavigateToSentence; }, [onNavigateToSentence]);

  const sentencesInView = 5;

  // Determine the subtitle-centered view window
  let startIdx = Math.max(0, currentSentenceIndex - 1);
  let endIdx = Math.min(subtitles.length - 1, startIdx + sentencesInView - 1);

  if (endIdx - startIdx + 1 < sentencesInView && subtitles.length >= sentencesInView) {
    startIdx = Math.max(0, endIdx - sentencesInView + 1);
  }

  const subViewStartTime = subtitles[startIdx]?.startTime ?? 0;
  const subViewEndTime = subtitles[endIdx]?.endTime ?? (audioElement?.duration || 1);
  const subViewDuration = subViewEndTime - subViewStartTime;

  // While panning, override the view with the pan position
  const isPanning = panViewStartRef.current !== null;
  const viewStartTime = isPanning ? panViewStartRef.current! : subViewStartTime;
  const viewDuration = isPanning ? stableViewDurationRef.current : subViewDuration;
  const viewEndTime = viewStartTime + viewDuration;

  // Keep stable duration up to date when NOT panning
  if (!isPanning) stableViewDurationRef.current = subViewDuration;

  // Keep view refs in sync (during pan these are updated directly by the RAF loop)
  // Only sync subtitle-based values when NOT panning
  useEffect(() => {
    if (panViewStartRef.current === null) {
      viewStartTimeRef.current = subViewStartTime;
      viewDurationRef.current = subViewDuration;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subViewStartTime, subViewDuration]);

  // Clamp to [startTime, endTime] so the red line never overshoots the blue end handle.
  const rawCurrentTime = audioElement?.currentTime ?? 0;
  const currentTime = Math.min(
    Math.max(rawCurrentTime, currentSub?.startTime ?? 0),
    currentSub?.endTime ?? rawCurrentTime
  );

  useEffect(() => {
    if (currentSub) {
      setTempStartTime(currentSub.startTime);
      setTempEndTime(currentSub.endTime);
    }
  }, [currentSentenceIndex, currentSub, isTimingEditing]);

  useEffect(() => {
    const color = getComputedStyle(document.documentElement).getPropertyValue('--primary').trim();
    if (color) {
      const hslValues = color.split(' ').map(parseFloat);
      setThemePrimaryColor(`hsl(${hslValues[0]} ${hslValues[1]}% ${hslValues[2]}%)`);
    }

    if (audioFile && !waveformBuffer && showWaveform) {
      const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
      const reader = new FileReader();
      reader.onload = (event) => {
        if (event.target?.result) {
          audioContext.decodeAudioData(event.target.result as ArrayBuffer)
            .then(buffer => setWaveformBuffer(buffer))
            .catch(e => console.error("Error decoding audio data", e));
        }
      };
      reader.readAsArrayBuffer(audioFile);
    }
  }, [audioFile, waveformBuffer, showWaveform]);

  useEffect(() => {
    const canvas = waveformCanvasRef.current;
    if (canvas) {
      const redraw = () => {
        if (showWaveform && waveformBuffer && viewDuration > 0) {
          drawWaveform(canvas, waveformBuffer, themePrimaryColor, viewStartTime, viewEndTime);
        } else {
          // Clear canvas when not showing waveform
          const ctx = canvas.getContext('2d');
          if (ctx) {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
          }
        }
      };
      const resizeObserver = new ResizeObserver(redraw);
      resizeObserver.observe(canvas);
      redraw();
      return () => resizeObserver.disconnect();
    }
  }, [waveformBuffer, themePrimaryColor, viewStartTime, viewEndTime, viewDuration, showWaveform]);

  // ─── Helper: find which subtitle index a given time falls into ───────────────
  const findSubtitleAtTime = (time: number): number => {
    const subs = subtitlesRef.current;
    for (let i = 0; i < subs.length; i++) {
      if (time >= subs[i].startTime && time <= subs[i].endTime) return i;
    }
    // If in a gap between subtitles, find the nearest one
    let closest = -1;
    let minDist = Infinity;
    for (let i = 0; i < subs.length; i++) {
      const d = Math.min(Math.abs(time - subs[i].startTime), Math.abs(time - subs[i].endTime));
      if (d < minDist) { minDist = d; closest = i; }
    }
    return closest;
  };

  // (edge-scroll removed — pan is now continuous; no discrete edge-stepping needed)

  // ─── Mouse drag listeners (attached once, uses refs) ────────────────────────
  useEffect(() => {
    // Continuous-pan RAF loop: slides the view left/right with mouse delta
    const rafPan = () => {
      if (!backgroundDraggingRef.current || !containerRef.current) return;

      const rect = containerRef.current.getBoundingClientRect();
      const deltaX = lastDragXRef.current - dragStartXRef.current; // pixels moved since mousedown
      const viewDur = viewDurationRef.current;
      // pixels→time: dragging one full canvas width pans by viewDuration
      const timeDelta = -(deltaX / rect.width) * viewDur;
      const audioDuration = audioElementRef.current?.duration ?? viewDur;

      // Compute new view start: pan delta added to the baseline captured at mousedown
      const baseStart = (window as any).__dragBaseViewStart as number ?? viewStartTimeRef.current;
      const newStart = Math.max(0, Math.min(baseStart + timeDelta, audioDuration - viewDur));

      // Update refs so the NEXT render picks up the new view window
      panViewStartRef.current = newStart;
      viewStartTimeRef.current = newStart;
      // viewDurationRef stays unchanged

      // Force a re-render so the canvas redraws
      setPanTick(t => t + 1);

      dragRafRef.current = requestAnimationFrame(rafPan);
    };

    // Expose starter to onMouseDown
    startDragRafRef.current = () => {
      if (dragRafRef.current !== null) cancelAnimationFrame(dragRafRef.current);
      dragRafRef.current = requestAnimationFrame(rafPan);
    };

    const onMouseMove = (e: MouseEvent) => {
      if (!containerRef.current) return;

      // ── Handle drag (adjusting timestamp handles) ──
      if (draggingHandleRef.current) {
        if (!isTimingEditingRef.current) {
          if (audioElementRef.current) audioElementRef.current.pause();
          setIsTimingEditingRef.current(true);
          isTimingEditingRef.current = true;
        }
        const rect = containerRef.current.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const percent = Math.max(0, Math.min(1, x / rect.width));
        const newTime = viewStartTimeRef.current + (percent * viewDurationRef.current);
        const snappedTime = Math.round(newTime * 20) / 20;
        const audioDuration = audioElementRef.current?.duration ?? Infinity;
        const MIN_DUR = 0.1;
        if (draggingHandleRef.current === 'start') {
          setTempStartTime(Math.max(0, Math.min(snappedTime, (tempEndTimeRef.current ?? 0) - MIN_DUR)));
        } else {
          setTempEndTime(Math.min(audioDuration, Math.max(snappedTime, (tempStartTimeRef.current ?? 0) + MIN_DUR)));
        }
        return;
      }

      // ── Background drag: track current mouse X (RAF loop does the panning) ──
      if (backgroundDraggingRef.current) {
        lastDragXRef.current = e.clientX;
      }
    };

    const onMouseUp = () => {
      const wasDragging = draggingHandleRef.current && isTimingEditingRef.current;
      pendingEditHandleRef.current = null;
      draggingHandleRef.current = null;

      if (backgroundDraggingRef.current) {
        // Cancel RAF
        if (dragRafRef.current !== null) {
          cancelAnimationFrame(dragRafRef.current);
          dragRafRef.current = null;
        }
        // Snap to the subtitle at the center of the final pan position
        if (panViewStartRef.current !== null) {
          const centerTime = panViewStartRef.current + viewDurationRef.current / 2;
          const idx = findSubtitleAtTime(centerTime);
          if (idx !== -1) onNavigateToSentenceRef.current(idx);
        }
        // Clear pan override — subtitle-centered view takes over again
        panViewStartRef.current = null;
        delete (window as any).__dragBaseViewStart;
      }

      backgroundDraggingRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';

      if (wasDragging) {
        clickBlockedRef.current = true;
        setTimeout(() => { clickBlockedRef.current = false; }, 50);
      }
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    return () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      if (dragRafRef.current !== null) cancelAnimationFrame(dragRafRef.current);
    };
  }, []); // empty deps — uses refs only

  // ─── Keyboard nudge listener ─────────────────────────────────────────────────
  // Arrow key behaviour (only active when timing editing is on):
  //   ←  / →              nudge START time  by ±50 ms
  //   Shift+← / Shift+→  nudge END   time  by ±50 ms
  //   Enter               save
  //   Escape              cancel
  useEffect(() => {
    const STEP = 0.05; // 50 ms

    const onKeyDown = (e: KeyboardEvent) => {
      if (!isTimingEditingRef.current) return;
      // Don't steal typing in other inputs
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      const audioDuration = audioElementRef.current?.duration ?? Infinity;
      const MIN_DUR = 0.1;

      if (['ArrowLeft', 'ArrowRight'].includes(e.key)) {
        e.preventDefault();
        e.stopPropagation();
        const dir = e.key === 'ArrowLeft' ? -1 : 1;

        if (!e.shiftKey) {
          // nudge START — only bounded by 0 and (endTime - MIN_DUR)
          setTempStartTime(prev => {
            if (prev === undefined) return prev;
            const next = prev + dir * STEP;
            return Math.max(0, Math.min(next, (tempEndTimeRef.current ?? 0) - MIN_DUR));
          });
        } else {
          // nudge END — only bounded by audioDuration and (startTime + MIN_DUR)
          setTempEndTime(prev => {
            if (prev === undefined) return prev;
            const next = prev + dir * STEP;
            return Math.min(audioDuration, Math.max(next, (tempStartTimeRef.current ?? 0) + MIN_DUR));
          });
        }
      } else if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        const s = tempStartTimeRef.current;
        const en = tempEndTimeRef.current;
        if (s !== undefined && en !== undefined) onSaveRef.current(s, en);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setIsTimingEditingRef.current(false);
      }
    };

    document.addEventListener('keydown', onKeyDown, { capture: true });
    return () => document.removeEventListener('keydown', onKeyDown, { capture: true });
  }, []); // empty deps — uses refs only

  // ─── Single click: select/navigate to clicked subtitle (NO play) ────────────────
  const handleClick = (e: React.MouseEvent) => {
    if (isTimingEditing) return;          // ignore clicks in edit mode
    if (clickBlockedRef.current) return;  // ignore clicks that follow a drag
    if (!containerRef.current) return;

    const rect = containerRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const percent = Math.max(0, Math.min(1, x / rect.width));
    const clickTime = viewStartTime + (percent * viewDuration);
    const clickedIdx = findSubtitleAtTime(clickTime);
    if (clickedIdx !== -1) onNavigateToSentence(clickedIdx); // select only, no play
  };

  // ─── Double click: ALWAYS play the clicked subtitle ───────────────────────────
  const handleDoubleClick = (e: React.MouseEvent) => {
    if (isTimingEditing) return;
    if (!containerRef.current) return;

    const rect = containerRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const percent = Math.max(0, Math.min(1, x / rect.width));
    const clickTime = viewStartTime + (percent * viewDuration);
    const clickedIdx = findSubtitleAtTime(clickTime);
    if (clickedIdx !== -1) onPlaySentence(clickedIdx);
  };

  const handleCancel = () => setIsTimingEditing(false);

  const handleSave = () => {
    if (tempStartTime !== undefined && tempEndTime !== undefined) {
      onSave(tempStartTime, tempEndTime);
    }
  };

  // ─── mousedown on a handle: mark as candidate for drag — DON'T enter edit yet ──
  const handleMouseDown = (e: React.MouseEvent, handle: 'start' | 'end') => {
    e.preventDefault();
    e.stopPropagation(); // don't let click/dblclick bubble to background handlers

    // Block the click event that will fire after this mousedown
    // (so single click on a handle doesn't also play)
    clickBlockedRef.current = true;
    setTimeout(() => { clickBlockedRef.current = false; }, 50);

    // Record drag intent but DON'T enter edit mode yet —
    // edit mode activates lazily on first mousemove (see onMouseMove above)
    pendingEditHandleRef.current = handle;
    draggingHandleRef.current = handle;
    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';
  };

  if (subtitles.length === 0 || !audioElement || !currentSub || viewDuration <= 0) return null;

  const startTime = isTimingEditing ? tempStartTime : currentSub.startTime;
  const endTime = isTimingEditing ? tempEndTime : currentSub.endTime;

  if (startTime === undefined || endTime === undefined) return null;

  const startPercent = ((startTime - viewStartTime) / viewDuration) * 100;
  const endPercent = ((endTime - viewStartTime) / viewDuration) * 100;

  return (
    <div className='flex flex-col gap-2'>
      <div
        ref={containerRef}
        className={cn(
          "relative w-full h-20 bg-secondary/30 rounded-lg flex items-end overflow-hidden",
          !isTimingEditing && "cursor-grab active:cursor-grabbing"
        )}
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        onMouseDown={(e) => {
          if (isTimingEditing) return;
          if (draggingHandleRef.current) return;
          // Capture the drag baseline: where in time does the left edge sit right now?
          const baseStart = viewStartTimeRef.current;
          (window as any).__dragBaseViewStart = baseStart;
          dragStartXRef.current = e.clientX;
          lastDragXRef.current = e.clientX;
          // Set pan to current position (non-null = panning mode)
          panViewStartRef.current = baseStart;
          backgroundDraggingRef.current = true;
          document.body.style.userSelect = 'none';
          document.body.style.cursor = 'grabbing';
          // Kick off the RAF pan loop
          startDragRafRef.current?.();
        }}
        title={isTimingEditing ? undefined : "Click or double-click to play · Drag edge handles to adjust timing · Drag background to scrub"}
      >
        <div className="absolute inset-0 w-full h-full">
          <canvas
            ref={waveformCanvasRef}
            className="absolute w-full h-full"
          />
        </div>

        {subtitles.slice(startIdx, endIdx + 1).map((sub) => {
          if (sub.id === currentSub.id) return null;
          const subStartPercent = ((sub.startTime - viewStartTime) / viewDuration) * 100;
          const subEndPercent = ((sub.endTime - viewStartTime) / viewDuration) * 100;

          return (
            <React.Fragment key={sub.id}>
              <div
                className="absolute top-0 bottom-0 border-r border-primary/50 border-dashed"
                style={{ left: `${subStartPercent}%` }}
              />
              <div
                className="absolute top-0 bottom-0 border-r border-primary/50 border-dashed"
                style={{ left: `${subEndPercent}%` }}
              />
            </React.Fragment>
          );
        })}

        {/* Highlighted region between start and end handles */}
        <div
          className="absolute top-0 bottom-0 bg-primary/20"
          style={{ left: `${startPercent}%`, width: `${Math.max(0, endPercent - startPercent)}%` }}
        >
          {/* Start Handle — wider grab zone for easy clicking */}
          <div
            onMouseDown={(e) => handleMouseDown(e, 'start')}
            className={cn(
              "absolute top-0 bottom-0 flex items-center justify-center cursor-ew-resize group",
              "w-5 -left-2.5" // wide invisible hit area centred on the 2px line
            )}
            title="Drag or use ← → to adjust start time"
          >
            {/* Visual bar */}
            <div className={cn(
              "absolute top-0 bottom-0 w-1 transition-colors",
              isTimingEditing ? "bg-blue-500 group-hover:bg-blue-400" : "bg-primary group-hover:bg-blue-400"
            )} />
            {/* Grip nub */}
            <div className={cn(
              "relative z-10 w-1 h-6 rounded-sm transition-colors",
              isTimingEditing ? "bg-blue-300 group-hover:bg-white" : "bg-primary/70 group-hover:bg-blue-300"
            )} />
            {/* Time label shown in edit mode */}
            {isTimingEditing && (
              <span className="absolute -bottom-5 left-1/2 -translate-x-1/2 text-[10px] font-mono text-blue-400 whitespace-nowrap select-none pointer-events-none">
                {formatTime(tempStartTime ?? 0)}
              </span>
            )}
          </div>

          {/* End Handle — wider grab zone */}
          <div
            onMouseDown={(e) => handleMouseDown(e, 'end')}
            className={cn(
              "absolute top-0 bottom-0 flex items-center justify-center cursor-ew-resize group",
              "w-5 -right-2.5"
            )}
            title="Drag or use Shift+← Shift+→ to adjust end time"
          >
            {/* Visual bar */}
            <div className={cn(
              "absolute top-0 bottom-0 w-1 transition-colors",
              isTimingEditing ? "bg-blue-500 group-hover:bg-blue-400" : "bg-primary group-hover:bg-blue-400"
            )} />
            {/* Grip nub */}
            <div className={cn(
              "relative z-10 w-1 h-6 rounded-sm transition-colors",
              isTimingEditing ? "bg-blue-300 group-hover:bg-white" : "bg-primary/70 group-hover:bg-blue-300"
            )} />
            {/* Time label shown in edit mode */}
            {isTimingEditing && (
              <span className="absolute -bottom-5 left-1/2 -translate-x-1/2 text-[10px] font-mono text-blue-400 whitespace-nowrap select-none pointer-events-none">
                {formatTime(tempEndTime ?? 0)}
              </span>
            )}
          </div>
        </div>

        {/* Playhead (hidden during edit so it doesn't obscure handles) */}
        {!isTimingEditing && (
          <div
            className="absolute top-0 bottom-0 w-0.5 bg-red-500 pointer-events-none"
            style={{ left: `${((currentTime - viewStartTime) / viewDuration) * 100}%` }}
          >
            <div className="absolute -top-1 -left-1 w-3 h-3 bg-red-500 rounded-full" />
          </div>
        )}
      </div>

      {/* Hint text removed — waveform handles are self-evident */}

      {/* Edit mode controls */}
      {isTimingEditing && (
        <div className="flex flex-col items-center gap-1 animate-in fade-in">
          <p className="text-[11px] text-muted-foreground/70 select-none">
            <span className="font-semibold text-blue-400">← →</span> start &nbsp;|&nbsp;
            <span className="font-semibold text-blue-400">Shift+← →</span> end &nbsp;|&nbsp;
            <span className="font-semibold text-blue-400">Enter</span> save &nbsp;|&nbsp;
            <span className="font-semibold text-blue-400">Esc</span> cancel
          </p>
          <div className="flex justify-center gap-2">
            <Button onClick={handleSave} size="sm">
              <Check className="w-4 h-4 mr-2" /> Save Timestamps
            </Button>
            <Button onClick={handleCancel} variant="ghost" size="sm">
              <X className="w-4 h-4 mr-2" /> Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
