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
    const { width, height } = canvas.getBoundingClientRect(); // Use bounding rect for actual display size
    const dpr = window.devicePixelRatio || 1;
    
    // Set canvas physical size to match display size scaled by DPR
    canvas.width = width * dpr;
    canvas.height = height * dpr;

    // Scale context to match DPR
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
        // Calculate line height based on amplitude, centered vertically
        const lineHeight = (max - min) * (height / 2);
        const y_top = middleY - (lineHeight / 2);
        const y_bottom = middleY + (lineHeight / 2);

        ctx.moveTo(x, y_top);
        ctx.lineTo(x, y_bottom);
    }
    ctx.stroke();
};


export function VolumeDisplay({ subtitles, currentSentenceIndex, audioElement, audioFile }: VolumeDisplayProps) {
  const [waveformBuffer, setWaveformBuffer] = useState<AudioBuffer | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const waveformCanvasRef = useRef<HTMLCanvasElement>(null);
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
        // Redraw on window resize
        const resizeObserver = new ResizeObserver(() => {
            drawWaveform(canvas, waveformBuffer, themePrimaryColor);
        });
        resizeObserver.observe(canvas);
        
        drawWaveform(canvas, waveformBuffer, themePrimaryColor);

        return () => resizeObserver.disconnect();
    }
  }, [waveformBuffer, themePrimaryColor]);


  const totalDuration = audioElement?.duration || (subtitles.length > 0 ? subtitles[subtitles.length - 1].endTime : 1);
  const currentTime = audioElement?.currentTime ?? 0;

  if (subtitles.length === 0 || !audioElement) return null;

  return (
    <div ref={containerRef} className="relative w-full h-20 bg-secondary/30 rounded-lg flex items-end overflow-hidden">
      <div className="absolute inset-0 w-full h-full">
        <canvas 
            ref={waveformCanvasRef} 
            className="absolute w-full h-full"
            style={{ imageRendering: 'pixelated' }}
        />
      </div>
      
      {subtitles.map((sub) => {
        const startPercent = (sub.startTime / totalDuration) * 100;
        const endPercent = (sub.endTime / totalDuration) * 100;

        return (
          <React.Fragment key={sub.id}>
            <div
              className="absolute top-0 bottom-0 border-r border-primary/50 border-dashed"
              style={{ left: `${startPercent}%` }}
              title={sub.text}
            />
             <div
              className="absolute top-0 bottom-0 border-r border-primary/50 border-dashed"
              style={{ left: `${endPercent}%` }}
              title={sub.text}
            />
          </React.Fragment>
        );
      })}
      
      {(() => {
        const currentSub = subtitles[currentSentenceIndex];
        if (!currentSub) return null;
        const startPercent = (currentSub.startTime / totalDuration) * 100;
        const endPercent = (currentSub.endTime / totalDuration) * 100;
        return (
          <div className="absolute top-0 bottom-0 bg-primary/20" style={{ left: `${startPercent}%`, width: `${endPercent - startPercent}%`}}>
             <div
              className="absolute top-0 bottom-0 border-r-2 border-primary"
              style={{ left: `0%` }}
            />
             <div
              className="absolute top-0 bottom-0 border-r-2 border-primary"
              style={{ right: `0%` }}
            />
          </div>
        )
      })()}


      <div 
        className="absolute top-0 bottom-0 w-0.5 bg-red-500"
        style={{ left: `${(currentTime / totalDuration) * 100}%` }}
      >
        <div className="absolute -top-1 -left-1 w-3 h-3 bg-red-500 rounded-full"></div>
      </div>
    </div>
  );
}
