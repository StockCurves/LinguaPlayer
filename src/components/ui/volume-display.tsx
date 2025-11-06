"use client";

import React, { useState, useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';
import type { Subtitle } from '@/app/page';

interface VolumeDisplayProps {
  subtitles: Subtitle[];
  currentSentenceIndex: number;
  audioElement: HTMLAudioElement | null;
  audioFile: File | null;
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

    const { width, height } = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    const totalDuration = audioBuffer.duration;
    const startIndex = Math.floor((viewStartTime / totalDuration) * audioBuffer.length);
    const endIndex = Math.ceil((viewEndTime / totalDuration) * audioBuffer.length);
    const viewLength = endIndex - startIndex;
    const channelData = audioBuffer.getChannelData(0).slice(startIndex, endIndex);
    
    if (viewLength <= 0) return;

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
        const lineHeight = (max - min) * (height / 2);
        const yTop = middleY - (lineHeight / 2);
        const yBottom = middleY + (lineHeight / 2);

        ctx.moveTo(x, yTop);
        ctx.lineTo(x, yBottom);
    }
    ctx.stroke();
};

export function VolumeDisplay({ subtitles, currentSentenceIndex, audioElement, audioFile }: VolumeDisplayProps) {
  const [waveformBuffer, setWaveformBuffer] = useState<AudioBuffer | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const waveformCanvasRef = useRef<HTMLCanvasElement>(null);
  const [themePrimaryColor, setThemePrimaryColor] = useState('hsl(208 26% 64%)');

  const sentencesInView = 5;
  const currentSub = subtitles[currentSentenceIndex];

  // Determine the view window
  let startIdx = Math.max(0, currentSentenceIndex - Math.floor(sentencesInView / 2));
  let endIdx = Math.min(subtitles.length - 1, startIdx + sentencesInView - 1);
  
  if (endIdx - startIdx + 1 < sentencesInView) {
      startIdx = Math.max(0, endIdx - sentencesInView + 1);
  }

  const viewStartTime = subtitles[startIdx]?.startTime ?? 0;
  const viewEndTime = subtitles[endIdx]?.endTime ?? (audioElement?.duration || 1);
  const viewDuration = viewEndTime - viewStartTime;
  
  const currentTime = audioElement?.currentTime ?? 0;

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
  
  if (subtitles.length === 0 || !audioElement || !currentSub || viewDuration <= 0) return null;

  return (
    <div ref={containerRef} className="relative w-full h-20 bg-secondary/30 rounded-lg flex items-end overflow-hidden">
      <div className="absolute inset-0 w-full h-full">
        <canvas 
            ref={waveformCanvasRef} 
            className="absolute w-full h-full"
            style={{ imageRendering: 'pixelated' }}
        />
      </div>
      
      {subtitles.slice(startIdx, endIdx + 1).map((sub) => {
        const startPercent = ((sub.startTime - viewStartTime) / viewDuration) * 100;
        const endPercent = ((sub.endTime - viewStartTime) / viewDuration) * 100;

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
        const startPercent = ((currentSub.startTime - viewStartTime) / viewDuration) * 100;
        const endPercent = ((currentSub.endTime - viewStartTime) / viewDuration) * 100;
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
        style={{ left: `${((currentTime - viewStartTime) / viewDuration) * 100}%` }}
      >
        <div className="absolute -top-1 -left-1 w-3 h-3 bg-red-500 rounded-full"></div>
      </div>
    </div>
  );
}
