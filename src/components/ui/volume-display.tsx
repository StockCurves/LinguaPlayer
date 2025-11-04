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
}

export function VolumeDisplay({ subtitles, currentSentenceIndex, audioElement }: VolumeDisplayProps) {
  const [cursorPosition, setCursorPosition] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const animationFrameRef = useRef<number>();

  const sentencesToShow = 5;
  const half = Math.floor(sentencesToShow / 2);

  let start = Math.max(0, currentSentenceIndex - half);
  let end = start + sentencesToShow;

  if (end > subtitles.length) {
    end = subtitles.length;
    start = Math.max(0, end - sentencesToShow);
  }

  const visibleSubtitles = subtitles.slice(start, end);
  const totalDuration = visibleSubtitles.reduce((acc, sub) => acc + (sub.endTime - sub.startTime), 0);

  useEffect(() => {
    const updateCursor = () => {
      if (!audioElement || !containerRef.current || !visibleSubtitles.length) {
        animationFrameRef.current = requestAnimationFrame(updateCursor);
        return;
      }

      const currentVisibleIndex = visibleSubtitles.findIndex(sub => sub.id === subtitles[currentSentenceIndex].id);
      if (currentVisibleIndex === -1) {
        animationFrameRef.current = requestAnimationFrame(updateCursor);
        return;
      }
      
      const currentSub = subtitles[currentSentenceIndex];
      const elapsedInCurrentSub = audioElement.currentTime - currentSub.startTime;

      const durationBeforeCurrent = visibleSubtitles
        .slice(0, currentVisibleIndex)
        .reduce((acc, sub) => acc + (sub.endTime - sub.startTime), 0);

      const totalElapsed = durationBeforeCurrent + elapsedInCurrentSub;
      
      let newPosition = (totalElapsed / totalDuration) * 100;
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
  }, [audioElement, currentSentenceIndex, subtitles, visibleSubtitles, totalDuration]);
  

  if (!visibleSubtitles.length) return null;

  return (
    <div ref={containerRef} className="relative w-full h-20 bg-secondary/30 rounded-lg flex items-end overflow-hidden">
      {visibleSubtitles.map((sub, index) => {
        const subIndexInAll = subtitles.findIndex(s => s.id === sub.id);
        const duration = sub.endTime - sub.startTime;
        const widthPercent = (duration / totalDuration) * 100;
        const isCurrent = subIndexInAll === currentSentenceIndex;

        return (
          <div
            key={sub.id}
            className="h-full flex items-end"
            style={{ width: `${widthPercent}%` }}
          >
            <div className={cn(
              "w-full bg-blue-500/50",
              isCurrent ? "h-full" : "h-2/3"
            )} />
            <div className={cn(
                "h-full border-r",
                isCurrent ? "border-solid border-blue-500" : "border-dashed border-blue-500/50"
            )}></div>
          </div>
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