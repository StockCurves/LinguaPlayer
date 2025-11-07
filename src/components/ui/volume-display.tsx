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
        const lineHeight = Math.max(1, (max - min) * (height / 2)); // Ensure at least 1px height
        const yTop = middleY - (lineHeight / 2);
        
        ctx.moveTo(x, yTop);
        ctx.lineTo(x, yTop + lineHeight);
    }
    ctx.stroke();
};

export function VolumeDisplay({ subtitles, currentSentenceIndex, audioElement, audioFile, isTimingEditing, setIsTimingEditing, onSave }: VolumeDisplayProps) {
  const [waveformBuffer, setWaveformBuffer] = useState<AudioBuffer | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const waveformCanvasRef = useRef<HTMLCanvasElement>(null);
  const [themePrimaryColor, setThemePrimaryColor] = useState('hsl(208 26% 64%)');
  
  const currentSub = subtitles[currentSentenceIndex];
  const [tempStartTime, setTempStartTime] = useState(currentSub?.startTime);
  const [tempEndTime, setTempEndTime] = useState(currentSub?.endTime);
  const [draggingHandle, setDraggingHandle] = useState<'start' | 'end' | null>(null);

  const sentencesInView = 5;

  // Determine the view window
  let startIdx = Math.max(0, currentSentenceIndex - Math.floor(sentencesInView / 2));
  let endIdx = Math.min(subtitles.length - 1, startIdx + sentencesInView - 1);
  
  if (endIdx - startIdx + 1 < sentencesInView && subtitles.length >= sentencesInView) {
      startIdx = Math.max(0, endIdx - sentencesInView + 1);
  }

  const viewStartTime = subtitles[startIdx]?.startTime ?? 0;
  const viewEndTime = subtitles[endIdx]?.endTime ?? (audioElement?.duration || 1);
  const viewDuration = viewEndTime - viewStartTime;
  
  const currentTime = audioElement?.currentTime ?? 0;

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
  
  const handleDoubleClick = () => {
    if (audioElement) {
        audioElement.pause();
    }
    setIsTimingEditing(true);
  }

  const handleCancel = () => {
    setIsTimingEditing(false);
  };

  const handleSave = () => {
    if (tempStartTime !== undefined && tempEndTime !== undefined) {
      onSave(tempStartTime, tempEndTime);
    }
  };
  
  const handlePointerDown = (e: React.PointerEvent, handle: 'start' | 'end') => {
    if (!isTimingEditing) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDraggingHandle(handle);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!draggingHandle || !containerRef.current) return;
    e.preventDefault();

    const rect = containerRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const percent = Math.max(0, Math.min(1, x / rect.width));
    const newTime = viewStartTime + (percent * viewDuration);

    const prevSentenceEndTime = currentSentenceIndex > 0 ? subtitles[currentSentenceIndex - 1].endTime : 0;
    const nextSentenceStartTime = currentSentenceIndex < subtitles.length - 1 ? subtitles[currentSentenceIndex + 1].startTime : audioElement?.duration ?? Infinity;
    const minDuration = 2;

    if (draggingHandle === 'start') {
      const clampedTime = Math.max(prevSentenceEndTime, Math.min(newTime, (tempEndTime ?? 0) - minDuration));
      setTempStartTime(clampedTime);
    } else if (draggingHandle === 'end') {
      const clampedTime = Math.min(nextSentenceStartTime, Math.max(newTime, (tempStartTime ?? 0) + minDuration));
      setTempEndTime(clampedTime);
    }
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    if (!draggingHandle) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    setDraggingHandle(null);
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
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
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
        
        <div className="absolute top-0 bottom-0 bg-primary/20" style={{ left: `${startPercent}%`, width: `${Math.max(0, endPercent - startPercent)}%`}}>
            {/* Start Handle */}
            <div
                onPointerDown={(e) => handlePointerDown(e, 'start')}
                className={cn("absolute top-0 bottom-0 w-1.5 cursor-ew-resize", isTimingEditing ? "bg-red-500" : "bg-primary")}
                style={{ left: 0 }}
            >
              <div className={cn("absolute top-1/2 -translate-y-1/2 -left-1 w-3 h-6 rounded-sm", isTimingEditing ? "bg-red-500" : "bg-primary")}/>
            </div>
            {/* End Handle */}
            <div
                onPointerDown={(e) => handlePointerDown(e, 'end')}
                className={cn("absolute top-0 bottom-0 w-1.5 cursor-ew-resize", isTimingEditing ? "bg-red-500" : "bg-primary")}
                style={{ right: 0 }}
            >
               <div className={cn("absolute top-1/2 -translate-y-1/2 -right-1 w-3 h-6 rounded-sm", isTimingEditing ? "bg-red-500" : "bg-primary")}/>
            </div>
        </div>

        {!isTimingEditing && (
            <div 
                className="absolute top-0 bottom-0 w-0.5 bg-red-500"
                style={{ left: `${((currentTime - viewStartTime) / viewDuration) * 100}%` }}
            >
                <div className="absolute -top-1 -left-1 w-3 h-3 bg-red-500 rounded-full"></div>
            </div>
        )}
        </div>
         {isTimingEditing && (
            <div className="flex justify-center gap-2 animate-in fade-in">
                <Button onClick={handleSave} size="sm">
                    <Check className="w-4 h-4 mr-2" /> Save Timestamps
                </Button>
                <Button onClick={handleCancel} variant="ghost" size="sm">
                    <X className="w-4 h-4 mr-2" /> Cancel
                </Button>
            </div>
        )}
    </div>
  );
}
