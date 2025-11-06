"use client";

import { useState, useRef, useEffect, ChangeEvent, DragEvent } from 'react';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { Rewind, FastForward, UploadCloud, FileAudio, FileText, CheckCircle2, Play, Pause, Star } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useToast } from '@/hooks/use-toast';
import { VolumeDisplay } from '@/components/ui/volume-display';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';


type Subtitle = {
  id: number;
  startTime: number;
  endTime: number;
  text: string;
  isStarred?: boolean;
};

export default function LinguaPlayerPage() {
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [srtFile, setSrtFile] = useState<File | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [subtitles, setSubtitles] = useState<Subtitle[]>([]);
  const [currentSentenceIndex, setCurrentSentenceIndex] = useState(-1);
  const [isPlaying, setIsPlaying] = useState(false);
  const [sentenceProgress, setSentenceProgress] = useState(0);
  const [isDragging, setIsDragging] = useState<'audio' | 'srt' | null>(null);
  const [showOnlyStarred, setShowOnlyStarred] = useState(false);

  const audioRef = useRef<HTMLAudioElement>(null);
  const sentenceScrollRef = useRef<(HTMLDivElement | null)[]>([]);
  const mainContainerRef = useRef<HTMLDivElement>(null);
  const lastUnfilteredIndexRef = useRef(0);
  const { toast } = useToast();
  
  const hasStarredSentences = subtitles.some(sub => sub.isStarred);
  const visibleSubtitles = showOnlyStarred && hasStarredSentences ? subtitles.filter(sub => sub.isStarred) : subtitles;

  const parseSrt = (srtText: string) => {
    try {
      const timeToSeconds = (time: string): number => {
        const parts = time.split(/[:,]/);
        if (parts.length !== 4) throw new Error(`Invalid time format: ${time}`);
        const hours = parseInt(parts[0], 10);
        const minutes = parseInt(parts[1], 10);
        const seconds = parseInt(parts[2], 10);
        const milliseconds = parseInt(parts[3], 10);
        return hours * 3600 + minutes * 60 + seconds + milliseconds / 1000;
      };

      const subs: Subtitle[] = srtText
        .replace(/\r/g, '')
        .split('\n\n')
        .filter(part => part.trim())
        .map(part => {
          const lines = part.trim().split('\n');
          if (lines.length < 2) return null;
          
          const timeLineIndex = lines.length > 2 && lines[1].includes('-->') ? 1 : lines.findIndex(l => l.includes('-->'));
          if (timeLineIndex === -1) return null;


          const id = lines.length > 2 && !isNaN(parseInt(lines[0], 10)) ? parseInt(lines[0], 10) : (Math.random() * 1000);
          const timeMatch = lines[timeLineIndex].match(/(\d{2}:\d{2}:\d{2},\d{3})\s-->\s(\d{2}:\d{2}:\d{2},\d{3})/);
          if (!timeMatch) return null;

          const [, startTimeStr, endTimeStr] = timeMatch;
          const text = lines.slice(timeLineIndex + 1).join(' ').trim();
          
          if (!isNaN(id) && startTimeStr && endTimeStr && text) {
            return {
              id,
              startTime: timeToSeconds(startTimeStr),
              endTime: timeToSeconds(endTimeStr),
              text,
              isStarred: false,
            };
          }
          return null;
        })
        .filter((sub): sub is Subtitle => sub !== null);

      if (subs.length === 0) {
        throw new Error("No subtitles found in the file. Please check the SRT format.");
      }

      setSubtitles(subs);
      setCurrentSentenceIndex(0);
      sentenceScrollRef.current = sentenceScrollRef.current.slice(0, subs.length);
    } catch (error) {
      console.error("SRT Parsing Error:", error);
      toast({
        variant: "destructive",
        title: "SRT Parsing Failed",
        description: error instanceof Error ? error.message : "Could not parse the SRT file. Please ensure it's correctly formatted.",
      });
      setSrtFile(null);
    }
  };

  const processFile = (file: File, type: 'audio' | 'srt') => {
    if (type === 'audio') {
      if (!file.type.startsWith('audio/')) {
        toast({ variant: "destructive", title: "Invalid File", description: "Please upload a valid audio file." });
        return;
      }
      setAudioFile(file);
      setAudioUrl(URL.createObjectURL(file));
    } else if (type === 'srt') {
       if (!file.name.endsWith('.srt')) {
        toast({ variant: "destructive", title: "Invalid File", description: "Please upload a .srt file." });
        return;
      }
      setSrtFile(file);
      const reader = new FileReader();
      reader.onload = (event) => {
        if (event.target?.result) {
          parseSrt(event.target.result as string);
        }
      };
      reader.readAsText(file);
    }
  };

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>, type: 'audio' | 'srt') => {
    const file = e.target.files?.[0];
    if (file) processFile(file, type);
    e.target.value = ''; // Reset input to allow re-uploading the same file
  };
  
  const handleDrop = (e: DragEvent<HTMLDivElement>, type: 'audio' | 'srt') => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(null);
    const file = e.dataTransfer.files?.[0];
    if (file) processFile(file, type);
  }

  const playSentence = (index: number) => {
    const audio = audioRef.current;
    if (!audio || !subtitles[index]) return;
    
    setCurrentSentenceIndex(index);
    audio.currentTime = subtitles[index].startTime;
    if (audio.paused) {
      audio.play().catch(e => console.error("Audio play failed:", e));
    }
  };
  
  const togglePlayPause = () => {
    const audio = audioRef.current;
    if (audio) {
      if (audio.paused && audioUrl && srtFile) {
        const currentSub = subtitles[currentSentenceIndex];
        const currentVisibleIndex = visibleSubtitles.findIndex(s => s.id === currentSub?.id);

        if (currentSub && audio.currentTime >= currentSub.endTime - 0.1) {
            // If at the end of a sentence, play the next one in the visible list
            if (currentVisibleIndex < visibleSubtitles.length - 1) {
                const nextVisibleSub = visibleSubtitles[currentVisibleIndex + 1];
                const nextOriginalIndex = subtitles.findIndex(s => s.id === nextVisibleSub.id);
                playSentence(nextOriginalIndex);
            }
        } else {
            // Otherwise, play the currently highlighted sentence
            playSentence(currentSentenceIndex);
        }
      } else {
        audio.pause();
      }
    }
  };

  const handlePrevious = () => {
    const audio = audioRef.current;
    if(!audio) return;
    audio.pause();

    const currentSub = subtitles[currentSentenceIndex];
    if (!currentSub) return;

    const currentVisibleIndex = visibleSubtitles.findIndex(sub => sub.id === currentSub.id);
    if (currentVisibleIndex > 0) {
      const newVisibleIndex = currentVisibleIndex - 1;
      const newOriginalIndex = subtitles.findIndex(s => s.id === visibleSubtitles[newVisibleIndex].id);
      playSentence(newOriginalIndex);
    }
  };

  const handleNext = () => {
    const audio = audioRef.current;
    if(!audio) return;
    audio.pause();

    const currentSub = subtitles[currentSentenceIndex];
    if (!currentSub) return;
    
    const currentVisibleIndex = visibleSubtitles.findIndex(sub => sub.id === currentSub.id);
    if (currentVisibleIndex < visibleSubtitles.length - 1) {
      const newVisibleIndex = currentVisibleIndex + 1;
      const newOriginalIndex = subtitles.findIndex(s => s.id === visibleSubtitles[newVisibleIndex].id);
      playSentence(newOriginalIndex);
    }
  };

  const handleSentenceClick = (index: number) => {
    // index is from visibleSubtitles
    const sub = visibleSubtitles[index];
    if (sub) {
        const originalIndex = subtitles.findIndex(s => s.id === sub.id);
        playSentence(originalIndex);
    }
  };

  const handleStarClick = (e: React.MouseEvent, id: number) => {
    e.stopPropagation();
    setSubtitles(prevSubtitles => {
      const newSubtitles = prevSubtitles.map(sub =>
        sub.id === id ? { ...sub, isStarred: !sub.isStarred } : sub
      );

      const newIndex = newSubtitles.findIndex(sub => sub.id === id);
      if (newIndex !== -1) {
        setCurrentSentenceIndex(newIndex);
      }
      
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
      }
    } else {
      setCurrentSentenceIndex(lastUnfilteredIndexRef.current);
    }
    setShowOnlyStarred(checked);
  };

  useEffect(() => {
    if (currentSentenceIndex === -1) return;
    const audio = audioRef.current;
    if (!audio || !subtitles.length) return;

    const handleTimeUpdate = () => {
      const sub = subtitles[currentSentenceIndex];
      if (!sub) return;

      if (isPlaying && audio.currentTime >= sub.endTime) {
        audio.pause();
      }
      
      const duration = sub.endTime - sub.startTime;
      const elapsed = audio.currentTime - sub.startTime;
      const progress = duration > 0 ? (elapsed / duration) * 100 : 0;
      setSentenceProgress(progress < 0 ? 0 : progress > 100 ? 100 : progress);
    };

    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);

    audio.addEventListener('timeupdate', handleTimeUpdate);
    audio.addEventListener('play', onPlay);
    audio.addEventListener('pause', onPause);

    return () => {
      audio.removeEventListener('timeupdate', handleTimeUpdate);
      audio.removeEventListener('play', onPlay);
      audio.removeEventListener('pause', onPause);
    };
  }, [audioRef, subtitles, currentSentenceIndex, isPlaying]);
  
  useEffect(() => {
    if (audioFile && srtFile && subtitles.length > 0 && currentSentenceIndex !== -1) {
      const currentSub = subtitles[currentSentenceIndex];
      const visibleIndex = visibleSubtitles.findIndex(sub => sub.id === currentSub?.id);
      
      if (visibleIndex !== -1) {
        sentenceScrollRef.current[visibleIndex]?.scrollIntoView({
          behavior: 'smooth',
          block: 'center'
        });
      }
    }
  }, [currentSentenceIndex, audioFile, srtFile, subtitles, showOnlyStarred, visibleSubtitles]);


  useEffect(() => {
    const handleKeyDown = (e: globalThis.KeyboardEvent) => {
      if (!audioFile || !srtFile || currentSentenceIndex === -1) return;

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
            setCurrentSentenceIndex(originalIndex);
          }
          break;
        case 'ArrowDown':
           if (currentVisibleIndex < visibleSubtitles.length - 1) {
            const nextSub = visibleSubtitles[currentVisibleIndex + 1];
            const originalIndex = subtitles.findIndex(s => s.id === nextSub.id);
            setCurrentSentenceIndex(originalIndex);
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
  }, [audioFile, srtFile, currentSentenceIndex, subtitles, showOnlyStarred, visibleSubtitles]);

  const UploadBox = ({ type }: { type: 'audio' | 'srt' }) => {
    const file = type === 'audio' ? audioFile : srtFile;
    const Icon = type === 'audio' ? FileAudio : FileText;
    const title = type === 'audio' ? 'Upload Audio File' : 'Upload Subtitle File';
    const accept = type === 'audio' ? 'audio/*' : '.srt';

    return (
      <div
        className={cn(
          "relative flex flex-col items-center justify-center p-6 sm:p-8 border-2 border-dashed rounded-lg text-center cursor-pointer transition-colors",
          isDragging === type ? 'border-primary bg-primary/10' : 'border-border hover:border-primary hover:bg-accent/10'
        )}
        onDragEnter={(e) => { e.preventDefault(); e.stopPropagation(); setIsDragging(type);}}
        onDragLeave={(e) => { e.preventDefault(); e.stopPropagation(); setIsDragging(null);}}
        onDragOver={(e) => { e.preventDefault(); e.stopPropagation();}}
        onDrop={(e) => handleDrop(e, type)}
      >
        {file ? (
          <div className="flex flex-col items-center gap-3 py-4 text-green-600 dark:text-green-400">
            <CheckCircle2 className="w-12 h-12" />
            <span className="font-medium text-sm text-center break-all">{file.name}</span>
          </div>
        ) : (
          <>
            <UploadCloud className="w-10 h-10 text-muted-foreground mb-3" />
            <h3 className="font-semibold">{title}</h3>
            <p className="text-muted-foreground text-sm">Click or drag & drop</p>
          </>
        )}
        <Input
          type="file"
          accept={accept}
          onChange={(e) => handleFileChange(e, type)}
          className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
          aria-label={title}
        />
      </div>
    );
  };


  return (
    <main ref={mainContainerRef} tabIndex={-1} className="flex min-h-dvh w-full flex-col items-center justify-center bg-background p-4 sm:p-6 md:p-8 font-body focus:outline-none">
      <Card className="w-full max-w-2xl shadow-xl rounded-2xl animate-in fade-in zoom-in-95 duration-500">
        <CardHeader className="text-center">
          <CardTitle className="text-3xl font-headline tracking-tight">Lingua Player</CardTitle>
          <CardDescription>Practice listening sentence by sentence.</CardDescription>
        </CardHeader>
        <CardContent>
          { !audioFile || !srtFile ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <UploadBox type="audio" />
              <UploadBox type="srt" />
            </div>
          ) : (
            <div className="flex flex-col gap-6 animate-in fade-in duration-500">
              <VolumeDisplay 
                subtitles={subtitles} 
                currentSentenceIndex={currentSentenceIndex} 
                audioElement={audioRef.current}
                audioFile={audioFile}
              />
              <div className="text-center p-4 sm:p-6 bg-secondary/50 rounded-lg min-h-[10rem] flex items-center justify-center border">
                <p className="text-xl sm:text-2xl font-medium text-foreground">
                  {subtitles.length > 0 && currentSentenceIndex !== -1 ? subtitles[currentSentenceIndex]?.text : "這裡要顯示 highlight 的句子"}
                </p>
              </div>
              <Progress value={sentenceProgress} className="w-full h-2 [&>div]:bg-accent" />
              <div className="flex justify-center items-center gap-2 sm:gap-4">
                <Button onClick={handlePrevious} variant="ghost" size="lg" disabled={!visibleSubtitles.length || visibleSubtitles.findIndex(s => s.id === subtitles[currentSentenceIndex]?.id) <= 0}>
                  <Rewind className="h-6 w-6" />
                  <span className="sr-only">Previous sentence</span>
                </Button>
                <Button onClick={togglePlayPause} variant="primary" size="lg" className="w-16 h-16 sm:w-20 sm:h-20 rounded-full shadow-lg hover:scale-105 transition-transform" disabled={currentSentenceIndex === -1}>
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

              <ScrollArea className="h-40 w-full rounded-md border p-4">
                <div className="flex flex-col gap-2">
                  {visibleSubtitles.map((sub, index) => {
                    const originalIndex = subtitles.findIndex(s => s.id === sub.id);
                    return (
                      <div
                        key={sub.id}
                        ref={el => sentenceScrollRef.current[index] = el}
                        onClick={() => handleSentenceClick(index)}
                        className={cn(
                          "cursor-pointer rounded-md p-2 transition-colors flex items-start gap-3",
                          sub.id === subtitles[currentSentenceIndex]?.id
                            ? 'bg-accent/20'
                            : 'hover:bg-accent/10'
                        )}
                      >
                        <button onClick={(e) => handleStarClick(e, sub.id)} className="p-1 -ml-1 text-muted-foreground hover:text-amber-500 transition-colors">
                          <Star className={cn("w-4 h-4", sub.isStarred ? 'text-amber-400 fill-amber-400' : 'text-muted-foreground')}/>
                          <span className="sr-only">Star sentence</span>
                        </button>
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
                      </div>
                    )
                  })}
                </div>
              </ScrollArea>
              
            </div>
          )}
        </CardContent>
        { audioFile && srtFile && visibleSubtitles.length > 0 && currentSentenceIndex !== -1 && (
          <CardFooter className="flex justify-center text-sm text-muted-foreground pt-4">
             Sentence {subtitles.findIndex(s => s.id === subtitles[currentSentenceIndex]?.id) + 1} of {subtitles.length}
          </CardFooter>
        )}
      </Card>
      <audio ref={audioRef} src={audioUrl ?? undefined} onEnded={() => {
        setIsPlaying(false)
      }} />
    </main>
  );
}
