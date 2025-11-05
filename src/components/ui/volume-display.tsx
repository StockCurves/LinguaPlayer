"use client";

import React, { useState, useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';

type Subtitle = {
  id: number;
  startTime: number;
  endTime: number;
  text: string;
};

interface VolumeDisplayProps {
  subtitles: Subtitle[];
  currentSentenceIndex: number;
  audioElement: HTMLAudioElement | null;
  audioFile: File | null;
}

const drawWaveform = (canvas: HTMLCanvasElement, audioBuffer: AudioBuffer, color: string) => {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const channelData = audioBuffer.getChannelData(0);
    const { width, height } = canvas;
    ctx.clearRect(0, 0, width, height);

    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();

    const middleY = height / 2;
    const step = Math.ceil(channelData.length / width);

    for (let i = 0; i < width; i++) {
        let min = 1.0;
        let max = -1.0;

        for (let j = 0; j < step; j++) {
            const datum = channelData[(i * step) + j];
            if (datum < min) min = datum;
            if (datum > max) max = datum;
        }
        
        const x = i;
        const y_max = (max * middleY) + middleY;
        const y_min = (min * middleY) + middleY;

        ctx.moveTo(x, y_max);
        ctx.lineTo(x, y_min);
    }
    ctx.stroke();
};


export function VolumeDisplay({ subtitles, currentSentenceIndex, audioElement, audioFile }: VolumeDisplayProps) {
  const [cursorPosition, setCursorPosition] = useState(0);
  const [waveformBuffer, setWaveformBuffer] = useState<AudioBuffer | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const waveformCanvasRef = useRef<HTMLCanvasElement>(null);
  const animationFrameRef = useRef<number>();

  useEffect(() => {
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
    if (canvas && waveformBuffer) {
        // Set canvas rendering size based on display size
        const { width, height } = canvas.getBoundingClientRect();
        canvas.width = width;
        canvas.height = height;
        drawWaveform(canvas, waveformBuffer, 'hsl(var(--primary))');
    }
  }, [waveformBuffer, subtitles]); // Rerender waveform if subtitles (and thus total duration) change.


  const totalDuration = subtitles.length > 0 ? subtitles[subtitles.length - 1].endTime : 0;

  useEffect(() => {
    const updateCursor = () => {
      if (!audioElement || !containerRef.current || totalDuration === 0) {
        animationFrameRef.current = requestAnimationFrame(updateCursor);
        return;
      }

      let newPosition = (audioElement.currentTime / totalDuration) * 100;
      newPosition = Math.max(0, Math.min(100, newPosition));

      setCursorPosition(newPosition);
      animationFrameRef.current = requestAnimationFrame(updateCursor);
    };

    animationFrameRef.current = requestAnimationFrame(updateCursor);

    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, [audioElement, totalDuration]);
  

  if (subtitles.length === 0) return null;

  return (
    <div ref={containerRef} className="relative w-full h-20 bg-secondary/30 rounded-lg flex items-end overflow-hidden">
      <canvas ref={waveformCanvasRef} className="absolute inset-0 w-full h-full" />
      
      {subtitles.map((sub, index) => {
        const startPercent = (sub.startTime / totalDuration) * 100;
        const endPercent = (sub.endTime / totalDuration) * 100;
        const isCurrent = index === currentSentenceIndex;

        return (
          <React.Fragment key={sub.id}>
            <div
              className={cn("absolute top-0 bottom-0 border-r", isCurrent ? 'border-primary' : 'border-primary/30')}
              style={{ left: `${startPercent}%` }}
            />
            <div
              className={cn("absolute top-0 bottom-0 border-r", isCurrent ? 'border-primary' : 'border-primary/30')}
              style={{ left: `${endPercent}%` }}
            />
          </React.Fragment>
        );
      })}

      <div 
        className="absolute top-0 bottom-0 w-0.5 bg-red-500"
        style={{ left: `${cursorPosition}%` }}
      >
        <div className="absolute -top-1 -left-1 w-3 h-3 bg-red-500 rounded-full"></div>
      </div>
    </div>
  );
}
