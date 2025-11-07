"use client";

import { useState, useRef, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Rewind, FastForward, Play, Pause, Star, Check, X, Download, FileText, FileCode } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useToast } from '@/hooks/use-toast';
import { VolumeDisplay } from '@/components/ui/volume-display';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import type { Subtitle } from '@/app/page';

interface PlayerViewProps {
  audioRef: React.RefObject<HTMLAudioElement>;
  audioFile: File;
  srtFile: File;
  subtitles: Subtitle[];
  setSubtitles: React.Dispatch<React.SetStateAction<Subtitle[]>>;
  currentSentenceIndex: number;
  setCurrentSentenceIndex: React.Dispatch<React.SetStateAction<number>>;
  isPlaying: boolean;
  sentenceProgress: number;
  playSentence: (index: number) => void;
  srtContent: string;
  setSrtContent: (content: string) => void;
}

export function PlayerView({
  audioRef,
  audioFile,
  srtFile,
  subtitles,
  setSubtitles,
  currentSentenceIndex,
  setCurrentSentenceIndex,
  isPlaying,
  sentenceProgress,
  playSentence,
  srtContent,
  setSrtContent,
}: PlayerViewProps) {
  const [showOnlyStarred, setShowOnlyStarred] = useState(false);
  const [editingSubtitleId, setEditingSubtitleId] = useState<number | null>(null);
  const [editingText, setEditingText] = useState('');
  const [isTimingEditing, setIsTimingEditing] = useState(false);

  const sentenceScrollRef = useRef<(HTMLDivElement | null)[]>([]);
  const lastUnfilteredIndexRef = useRef(0);
  const { toast } = useToast();
  
  const hasStarredSentences = subtitles.some(sub => sub.isStarred);
  const visibleSubtitles = showOnlyStarred && hasStarredSentences ? subtitles.filter(sub => sub.isStarred) : subtitles;

  const secondsToSrtTime = (seconds: number): string => {
    const date = new Date(0);
    date.setSeconds(seconds);
    const time = date.toISOString().substr(11, 12);
    return time.replace('.', ',');
  };

  const generateSrtContent = (subs: Subtitle[]) => {
    let content = '';
    subs.forEach((sub, index) => {
        // Use original subtitle ID for numbering if it makes sense, or just index.
        // For simplicity and consistency, we'll use array index + 1 for numbering in the file.
        content += `${index + 1}\n`;
        content += `${secondsToSrtTime(sub.startTime)} --> ${secondsToSrtTime(sub.endTime)}\n`;
        content += `${sub.text}\n\n`;
    });
    return content;
  }

  const updateSrtContent = (updatedSubtitles: Subtitle[]) => {
    const newSrtContent = generateSrtContent(updatedSubtitles);
    setSrtContent(newSrtContent);
  };

  const handleTimingSave = (newStartTime: number, newEndTime: number) => {
    const currentSub = subtitles[currentSentenceIndex];
    if (!currentSub) return;

    const newSubtitles = subtitles.map((sub) =>
      sub.id === currentSub.id ? { ...sub, startTime: newStartTime, endTime: newEndTime } : sub
    );
    setSubtitles(newSubtitles);
    updateSrtContent(newSubtitles);
    setIsTimingEditing(false);
    toast({
        title: "Timestamps Saved",
        description: "The sentence timing has been updated.",
    });
  };
  
  const togglePlayPause = () => {
    const audio = audioRef.current;
    if (!audio) return;
  
    const currentSubInFullList = subtitles[currentSentenceIndex];
    if (!currentSubInFullList) {
        if (visibleSubtitles.length > 0) {
            const firstVisibleSubId = visibleSubtitles[0].id;
            const originalIndex = subtitles.findIndex(s => s.id === firstVisibleSubId);
            if (originalIndex !== -1) playSentence(originalIndex);
        }
        return;
    }

    if (audio.paused) {
      // If playback is at the end of the sentence or very close, replay it.
      if (audio.currentTime >= currentSubInFullList.endTime - 0.1) {
        playSentence(currentSentenceIndex);
      } else {
        // Otherwise, just resume playback.
        audio.play().catch(e => console.error("Audio play failed:", e));
      }
    } else {
      audio.pause();
    }
  };

  const handlePrevious = () => {
    const currentSub = subtitles[currentSentenceIndex];
    if (!currentSub) return;

    const currentVisibleIndex = visibleSubtitles.findIndex(sub => sub.id === currentSub.id);
    if (currentVisibleIndex > 0) {
      const newVisibleIndex = currentVisibleIndex - 1;
      const newOriginalIndex = subtitles.findIndex(s => s.id === visibleSubtitles[newVisibleIndex].id);
      if(newOriginalIndex !== -1) {
        playSentence(newOriginalIndex);
      }
    }
  };

  const handleNext = () => {
    const currentSub = subtitles[currentSentenceIndex];
    if (!currentSub) return;
    
    const currentVisibleIndex = visibleSubtitles.findIndex(sub => sub.id === currentSub.id);
    if (currentVisibleIndex < visibleSubtitles.length - 1) {
      const newVisibleIndex = currentVisibleIndex + 1;
      const newOriginalIndex = subtitles.findIndex(s => s.id === visibleSubtitles[newVisibleIndex].id);
      if(newOriginalIndex !== -1) {
        playSentence(newOriginalIndex);
      }
    }
  };

  const handleSentenceClick = (index: number) => {
    // index is from visibleSubtitles
    const sub = visibleSubtitles[index];
    if (sub) {
        const originalIndex = subtitles.findIndex(s => s.id === sub.id);
        if (originalIndex !== -1) {
          if (originalIndex !== currentSentenceIndex) {
              setCurrentSentenceIndex(originalIndex);
          }
          playSentence(originalIndex);
        }
    }
  };

  const handleSentenceDoubleClick = (sub: Subtitle) => {
    setEditingSubtitleId(sub.id);
    setEditingText(sub.text);
  };

  const handleSaveEdit = (id: number) => {
    const newSubtitles = subtitles.map(sub => 
      sub.id === id ? { ...sub, text: editingText } : sub
    );
    setSubtitles(newSubtitles);
    updateSrtContent(newSubtitles);
    setEditingSubtitleId(null);
    setEditingText('');
    toast({
      title: "Sentence Saved",
      description: "The subtitle has been updated.",
    });
  };

  const handleCancelEdit = () => {
    setEditingSubtitleId(null);
    setEditingText('');
  };

  const handleStarClick = (e: React.MouseEvent, id: number) => {
    e.stopPropagation();
    setSubtitles(prevSubtitles => {
      const newSubtitles = prevSubtitles.map(sub =>
        sub.id === id ? { ...sub, isStarred: !sub.isStarred } : sub
      );
      
      const anyStarred = newSubtitles.some(sub => sub.isStarred);
      if (!anyStarred && showOnlyStarred) {
        setShowOnlyStarred(false);
      }

      return newSubtitles;
    });
  };

  const handleShowStarredToggle = (checked: boolean) => {
    if (checked) {
      lastUnfilteredIndexRef.current = currentSentenceIndex;
      const firstStarredSub = subtitles.find(sub => sub.isStarred);
      if (firstStarredSub) {
        const firstStarredIndex = subtitles.findIndex(sub => sub.id === firstStarredSub.id);
        setCurrentSentenceIndex(firstStarredIndex);
      } else {
        // if no starred sentences, don't change index
        setCurrentSentenceIndex(currentSentenceIndex);
      }
    } else {
      setCurrentSentenceIndex(lastUnfilteredIndexRef.current);
    }
    setShowOnlyStarred(checked);
  };

  const downloadFile = (content: string, fileName: string, mimeType: string) => {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleDownloadSrt = () => {
    if (!srtFile) return;

    const subsToDownload = showOnlyStarred ? visibleSubtitles : subtitles;
    const content = generateSrtContent(subsToDownload);

    const fileName = srtFile.name.replace('.srt', '_edited.srt');
    downloadFile(content, fileName, 'text/plain');
  };

  const handleDownloadTxt = () => {
    if (!srtFile) return;

    const subsToDownload = showOnlyStarred ? visibleSubtitles : subtitles;
    const textContent = subsToDownload.map(sub => sub.text).join('\n');
    
    const fileName = srtFile.name.replace('.srt', '.txt');
    downloadFile(textContent, fileName, 'text/plain');
  };
  
  const handleExportMd = () => {
    toast({
      title: "Coming Soon!",
      description: "Markdown export functionality is not yet implemented.",
    });
  };

  useEffect(() => {
    if (subtitles.length > 0 && currentSentenceIndex !== -1) {
      const currentSub = subtitles[currentSentenceIndex];
      const visibleIndex = visibleSubtitles.findIndex(sub => sub.id === currentSub?.id);
      
      if (visibleIndex !== -1 && !editingSubtitleId) {
        sentenceScrollRef.current[visibleIndex]?.scrollIntoView({
          behavior: 'smooth',
          block: 'center'
        });
      }
    }
  }, [currentSentenceIndex, subtitles, showOnlyStarred, visibleSubtitles, editingSubtitleId]);


  useEffect(() => {
    const handleKeyDown = (e: globalThis.KeyboardEvent) => {
      if (editingSubtitleId || isTimingEditing) return;
      if (currentSentenceIndex === -1) return;

      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }
      
      const currentSub = subtitles[currentSentenceIndex];
      if (!currentSub) return;
      
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter'].includes(e.code)) {
          e.preventDefault();
      }
      
      const currentVisibleIndex = visibleSubtitles.findIndex(sub => sub.id === currentSub.id);
      
      switch (e.code) {
        case 'Space':
          togglePlayPause();
          break;
        case 'ArrowLeft':
          handlePrevious();
          break;
        case 'ArrowRight':
          handleNext();
          break;
        case 'ArrowUp':
          if (currentVisibleIndex > 0) {
            const prevSub = visibleSubtitles[currentVisibleIndex - 1];
            const originalIndex = subtitles.findIndex(s => s.id === prevSub.id);
            if(originalIndex !== -1) setCurrentSentenceIndex(originalIndex);
          }
          break;
        case 'ArrowDown':
           if (currentVisibleIndex < visibleSubtitles.length - 1) {
            const nextSub = visibleSubtitles[currentVisibleIndex + 1];
            const originalIndex = subtitles.findIndex(s => s.id === nextSub.id);
            if(originalIndex !== -1) setCurrentSentenceIndex(originalIndex);
          }
          break;
        case 'Enter':
          {
            playSentence(currentSentenceIndex);
          }
          break;
      }
    };

    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [currentSentenceIndex, subtitles, showOnlyStarred, visibleSubtitles, editingSubtitleId, isTimingEditing]);

  return (
    <div className="flex flex-col gap-6 animate-in fade-in duration-500">
      <VolumeDisplay
        subtitles={subtitles}
        currentSentenceIndex={currentSentenceIndex}
        audioElement={audioRef.current}
        audioFile={audioFile}
        isTimingEditing={isTimingEditing}
        setIsTimingEditing={setIsTimingEditing}
        onSave={handleTimingSave}
      />
      
      {!isTimingEditing && (
        <>
          <Progress value={sentenceProgress} className="w-full h-2 [&>div]:bg-accent" />

          <ScrollArea className="h-48 w-full rounded-md border p-4">
            <div className="flex flex-col gap-2">
              {visibleSubtitles.map((sub, index) => {
                const originalIndex = subtitles.findIndex(s => s.id === sub.id);
                const isEditing = editingSubtitleId === sub.id;

                return (
                  <div
                    key={sub.id}
                    ref={el => sentenceScrollRef.current[index] = el}
                    onClick={() => !isEditing && handleSentenceClick(index)}
                    onDoubleClick={() => handleSentenceDoubleClick(sub)}
                    className={cn(
                      "cursor-pointer rounded-md p-2 transition-colors flex items-start gap-3",
                      !isEditing && (sub.id === subtitles[currentSentenceIndex]?.id
                        ? 'bg-accent/20'
                        : 'hover:bg-accent/10')
                    )}
                  >
                    <button onClick={(e) => handleStarClick(e, sub.id)} className="p-1 -ml-1 text-muted-foreground hover:text-amber-500 transition-colors">
                      <Star className={cn("w-4 h-4", sub.isStarred ? 'text-amber-400 fill-amber-400' : 'text-muted-foreground')}/>
                      <span className="sr-only">Star sentence</span>
                    </button>
                    
                    {isEditing ? (
                      <div className="flex-1 flex flex-col gap-2">
                        <Textarea
                          value={editingText}
                          onChange={(e) => setEditingText(e.target.value)}
                          className="w-full"
                          rows={2}
                          autoFocus
                        />
                        <div className="flex justify-end gap-2">
                          <Button onClick={() => handleSaveEdit(sub.id)} size="sm" variant="default">
                            <Check className="w-4 h-4 mr-1" /> Save
                          </Button>
                          <Button onClick={handleCancelEdit} size="sm" variant="ghost">
                            <X className="w-4 h-4 mr-1" /> Cancel
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <p
                        className={cn(
                          "flex-1",
                          sub.id === subtitles[currentSentenceIndex]?.id
                            ? 'font-bold text-foreground'
                            : 'text-muted-foreground'
                        )}
                      >
                        <span className={cn("mr-2", sub.id === subtitles[currentSentenceIndex]?.id ? 'text-primary' : '')}>{originalIndex + 1}.</span>
                        <span>{sub.text}</span>
                      </p>
                    )}
                  </div>
                )
              })}
            </div>
          </ScrollArea>
          
          <div className="flex justify-center items-center gap-2 sm:gap-4">
              <Button onClick={handlePrevious} variant="ghost" size="lg" disabled={!visibleSubtitles.length || visibleSubtitles.findIndex(s => s.id === subtitles[currentSentenceIndex]?.id) <= 0}>
                <Rewind className="h-6 w-6" />
                <span className="sr-only">Previous sentence</span>
              </Button>
              <Button onClick={togglePlayPause} variant="default" size="lg" className="w-16 h-16 sm:w-20 sm:h-20 rounded-full shadow-lg hover:scale-105 transition-transform" disabled={currentSentenceIndex === -1}>
                {isPlaying ? <Pause className="h-7 w-7 sm:h-8 sm:w-8" /> : <Play className="h-7 w-7 sm:h-8 sm:w-8" />}
                <span className="sr-only">{isPlaying ? 'Pause' : 'Play'}</span>
              </Button>
              <Button onClick={handleNext} variant="ghost" size="lg" disabled={!visibleSubtitles.length || visibleSubtitles.findIndex(s => s.id === subtitles[currentSentenceIndex]?.id) >= visibleSubtitles.length - 1}>
                <FastForward className="h-6 w-6" />
                <span className="sr-only">Next sentence</span>
              </Button>
          </div>
                
          {hasStarredSentences && (
            <div className="flex items-center justify-center space-x-2">
              <Switch
                id="show-starred"
                checked={showOnlyStarred}
                onCheckedChange={handleShowStarredToggle}
              />
              <Label htmlFor="show-starred">Show Starred Only</Label>
            </div>
          )}

          <div className="flex justify-center gap-2">
            <Button onClick={handleDownloadSrt} variant="outline" size="sm">
              <Download className="mr-2 h-4 w-4" />
              Download .srt
            </Button>
            <Button onClick={handleDownloadTxt} variant="outline" size="sm">
              <FileText className="mr-2 h-4 w-4" />
              Download .txt
            </Button>
            <Button onClick={handleExportMd} variant="outline" size="sm">
              <FileCode className="mr-2 h-4 w-4" />
              Export .md
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
