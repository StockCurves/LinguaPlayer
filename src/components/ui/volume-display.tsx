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
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);
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
        const y_max = (Math.abs(max) * height) / 2 + middleY;
        const y_min = middleY - (Math.abs(min) * height) / 2;

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
  const [themePrimaryColor, setThemePrimaryColor] = useState('hsl(208 26% 64%)');

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
    if (canvas && waveformBuffer) {
        drawWaveform(canvas, waveformBuffer, themePrimaryColor);
    }
  }, [waveformBuffer, themePrimaryColor, subtitles]);


  const totalDuration = subtitles.length > 0 ? subtitles[subtitles.length - 1].endTime : 1;

  useEffect(() => {
    const updateCursor = () => {
      if (!audioElement || !containerRef.current) {
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

  const displayWindow = 2; 
  const startIndex = Math.max(0, currentSentenceIndex - displayWindow);
  const endIndex = Math.min(subtitles.length -1, currentSentenceIndex + displayWindow);

  const displayedSubtitles = subtitles.slice(startIndex, endIndex + 1);

  const windowStartTime = subtitles[startIndex].startTime;
  const windowEndTime = subtitles[endIndex].endTime;
  const windowDuration = windowEndTime - windowStartTime;
  
  if (windowDuration <= 0) return null;


  return (
    <div ref={containerRef} className="relative w-full h-20 bg-secondary/30 rounded-lg flex items-end overflow-hidden">
      <div className="absolute inset-0 w-full h-full">
        <canvas 
            ref={waveformCanvasRef} 
            className="absolute w-full h-full"
            style={{
                imageRendering: 'pixelated',
                left: `-${(windowStartTime / totalDuration) * 100}%`,
                width: `${(totalDuration / windowDuration) * 100}%`,
            }}
        />
      </div>
      
      {displayedSubtitles.map((sub, index) => {
        const localIndex = startIndex + index;
        const isCurrent = localIndex === currentSentenceIndex;
        const startPercent = ((sub.startTime - windowStartTime) / windowDuration) * 100;
        const endPercent = ((sub.endTime - windowStartTime) / windowDuration) * 100;

        return (
          <React.Fragment key={sub.id}>
            <div
              className={cn("absolute top-0 bottom-0 border-r", isCurrent ? "border-primary" : "border-primary/50 border-dashed" )}
              style={{ left: `${startPercent}%` }}
              title={sub.text}
            />
             <div
              className={cn("absolute top-0 bottom-0 border-r", isCurrent ? "border-primary" : "border-primary/50 border-dashed" )}
              style={{ left: `${endPercent}%` }}
              title={sub.text}
            />
          </React.Fragment>
        );
      })}
      
      {(() => {
        const currentSub = subtitles[currentSentenceIndex];
        if (!currentSub) return null;
        const startPercent = ((currentSub.startTime - windowStartTime) / windowDuration) * 100;
        const endPercent = ((currentSub.endTime - windowStartTime) / windowDuration) * 100;
        return (
          <div className="absolute top-0 bottom-0 bg-primary/20" style={{ left: `${startPercent}%`, width: `${endPercent - startPercent}%`}}>
          </div>
        )
      })()}


      <div 
        className="absolute top-0 bottom-0 w-0.5 bg-red-500"
        style={{ left: `${((audioElement?.currentTime ?? 0) - windowStartTime) / windowDuration * 100}%` }}
      >
        <div className="absolute -top-1 -left-1 w-3 h-3 bg-red-500 rounded-full"></div>
      </div>
    </div>
  );
}

    