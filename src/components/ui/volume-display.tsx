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
  isTimingEditing: boolean;
  setIsTimingEditing: (isEditing: boolean) => void;
  onSave: (newStartTime: number, newEndTime: number) => void;
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

export function VolumeDisplay({ subtitles, currentSentenceIndex, audioElement, audioFile, isTimingEditing, setIsTimingEditing, onSave }: VolumeDisplayProps) {
  const [waveformBuffer, setWaveformBuffer] = useState<AudioBuffer | null>(null);
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

  // Keep refs in sync
  useEffect(() => { tempStartTimeRef.current = tempStartTime; }, [tempStartTime]);
  useEffect(() => { tempEndTimeRef.current = tempEndTime; }, [tempEndTime]);
  useEffect(() => { currentSentenceIndexRef.current = currentSentenceIndex; }, [currentSentenceIndex]);
  useEffect(() => { subtitlesRef.current = subtitles; }, [subtitles]);
  useEffect(() => { audioElementRef.current = audioElement; }, [audioElement]);
  useEffect(() => { isTimingEditingRef.current = isTimingEditing; }, [isTimingEditing]);
  useEffect(() => { setIsTimingEditingRef.current = setIsTimingEditing; }, [setIsTimingEditing]);
  useEffect(() => { onSaveRef.current = onSave; }, [onSave]);

  const sentencesInView = 5;

  // Determine the view window
  let startIdx = Math.max(0, currentSentenceIndex - 1); // current subtitle in 2nd row
  let endIdx = Math.min(subtitles.length - 1, startIdx + sentencesInView - 1);

  if (endIdx - startIdx + 1 < sentencesInView && subtitles.length >= sentencesInView) {
    startIdx = Math.max(0, endIdx - sentencesInView + 1);
  }

  const viewStartTime = subtitles[startIdx]?.startTime ?? 0;
  const viewEndTime = subtitles[endIdx]?.endTime ?? (audioElement?.duration || 1);
  const viewDuration = viewEndTime - viewStartTime;

  // Keep view refs in sync
  useEffect(() => { viewStartTimeRef.current = viewStartTime; }, [viewStartTime]);
  useEffect(() => { viewDurationRef.current = viewDuration; }, [viewDuration]);

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

    if (audioFile && !waveformBuffer) {
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
  }, [audioFile, waveformBuffer]);

  useEffect(() => {
    const canvas = waveformCanvasRef.current;
    if (canvas && waveformBuffer && viewDuration > 0) {
      const redraw = () => {
        drawWaveform(canvas, waveformBuffer, themePrimaryColor, viewStartTime, viewEndTime);
      };
      const resizeObserver = new ResizeObserver(redraw);
      resizeObserver.observe(canvas);
      redraw();
      return () => resizeObserver.disconnect();
    }
  }, [waveformBuffer, themePrimaryColor, viewStartTime, viewEndTime, viewDuration]);

  // ─── Mouse drag listeners (attached once, uses refs) ────────────────────────
  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!draggingHandleRef.current || !containerRef.current) return;

      const rect = containerRef.current.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const percent = Math.max(0, Math.min(1, x / rect.width));
      const newTime = viewStartTimeRef.current + (percent * viewDurationRef.current);

      const audioDuration = audioElementRef.current?.duration ?? Infinity;
      const MIN_DUR = 0.1;

      if (draggingHandleRef.current === 'start') {
        // Only constrain: can't go below 0, can't cross end handle
        const clamped = Math.max(0, Math.min(newTime, (tempEndTimeRef.current ?? 0) - MIN_DUR));
        setTempStartTime(clamped);
      } else {
        // Only constrain: can't exceed audio duration, can't cross start handle
        const clamped = Math.min(audioDuration, Math.max(newTime, (tempStartTimeRef.current ?? 0) + MIN_DUR));
        setTempEndTime(clamped);
      }
    };

    const onMouseUp = () => {
      draggingHandleRef.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    return () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
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

  const handleDoubleClick = () => {
    if (audioElement) audioElement.pause();
    setIsTimingEditing(true);
  };

  const handleCancel = () => setIsTimingEditing(false);

  const handleSave = () => {
    if (tempStartTime !== undefined && tempEndTime !== undefined) {
      onSave(tempStartTime, tempEndTime);
    }
  };

  // ─── mousedown on a handle: auto-enter edit mode and begin drag immediately ──
  const handleMouseDown = (e: React.MouseEvent, handle: 'start' | 'end') => {
    e.preventDefault();
    e.stopPropagation(); // don't let it bubble to the double-click handler

    // Auto-enter timing edit mode if not already in it
    if (!isTimingEditingRef.current) {
      if (audioElementRef.current) audioElementRef.current.pause();
      setIsTimingEditing(true);
      isTimingEditingRef.current = true; // mirror immediately for drag to work
    }

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
        className="relative w-full h-20 bg-secondary/30 rounded-lg flex items-end overflow-hidden"
        onDoubleClick={handleDoubleClick}
        title={isTimingEditing ? undefined : "Double-click or drag the blue handles to edit timestamps"}
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

      {/* Hint text */}
      {!isTimingEditing && (
        <p className="text-center text-[11px] text-muted-foreground/60 select-none">
          Drag blue handles or double-click to edit timestamps
        </p>
      )}

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
