"use client";

import { useState, useRef, useEffect, ChangeEvent, DragEvent } from 'react';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { Rewind, Repeat, FastForward, UploadCloud, FileAudio, FileText, CheckCircle2, Play, Pause } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useToast } from '@/hooks/use-toast';
import { VolumeDisplay } from '@/components/ui/volume-display';
import { ScrollArea } from '@/components/ui/scroll-area';


type Subtitle = {
  id: number;
  startTime: number;
  endTime: number;
  text: string;
};

export default function LinguaPlayerPage() {
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [srtFile, setSrtFile] = useState<File | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [subtitles, setSubtitles] = useState<Subtitle[]>([]);
  const [currentSentenceIndex, setCurrentSentenceIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [sentenceProgress, setSentenceProgress] = useState(0);
  const [isDragging, setIsDragging] = useState<'audio' | 'srt' | null>(null);

  const audioRef = useRef<HTMLAudioElement>(null);
  const sentenceScrollRef = useRef<(HTMLDivElement | null)[]>([]);
  const { toast } = useToast();

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
          
          // Allow for SRT files that don't have the number index for each entry
          const timeLineIndex = lines.length > 2 ? 1 : 0;
          if (!lines[timeLineIndex] || !lines[timeLineIndex].includes('-->')) return null;

          const id = lines.length > 2 ? parseInt(lines[0], 10) : (Math.random() * 1000);
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
    const sub = subtitles[index];
    if (audio && sub) {
      audio.currentTime = sub.startTime;
      audio.play().catch(e => console.error("Audio play failed:", e));
    }
  };
  
  const togglePlayPause = () => {
    const audio = audioRef.current;
    if (audio) {
      if (audio.paused) {
        playSentence(currentSentenceIndex);
      } else {
        audio.pause();
      }
    }
  };

  const handlePrevious = () => {
    const newIndex = Math.max(0, currentSentenceIndex - 1);
    setCurrentSentenceIndex(newIndex);
  };

  const handleReplay = () => playSentence(currentSentenceIndex);

  const handleNext = () => {
    const newIndex = Math.min(subtitles.length - 1, currentSentenceIndex + 1);
    setCurrentSentenceIndex(newIndex);
  };

  const handleSentenceClick = (index: number) => {
    setCurrentSentenceIndex(index);
  };

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !subtitles.length) return;

    const handleTimeUpdate = () => {
      const sub = subtitles[currentSentenceIndex];
      if (!sub) return;

      if (audio.currentTime >= sub.endTime) {
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
  }, [audioRef, subtitles, currentSentenceIndex]);
  
  // Auto-play sentence when index changes and scroll into view
  useEffect(() => {
    if (audioFile && srtFile) {
        playSentence(currentSentenceIndex);
    }
    sentenceScrollRef.current[currentSentenceIndex]?.scrollIntoView({
      behavior: 'smooth',
      block: 'center'
    });
  }, [currentSentenceIndex, audioFile, srtFile]);


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
    <main className="flex min-h-dvh w-full flex-col items-center justify-center bg-background p-4 sm:p-6 md:p-8 font-body">
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
                  {subtitles.length > 0 ? subtitles[currentSentenceIndex]?.text : "Loading subtitles..."}
                </p>
              </div>
              <Progress value={sentenceProgress} className="w-full h-2 [&>div]:bg-accent" />
              <div className="flex justify-center items-center gap-2 sm:gap-4">
                <Button onClick={handlePrevious} variant="ghost" size="lg" disabled={currentSentenceIndex === 0}>
                  <Rewind className="h-6 w-6" />
                  <span className="sr-only">Previous sentence</span>
                </Button>
                <Button onClick={handleReplay} variant="outline" size="lg">
                    <Repeat className="h-6 w-6" />
                    <span className="sr-only">Replay current sentence</span>
                </Button>
                <Button onClick={togglePlayPause} variant="primary" size="lg" className="w-16 h-16 sm:w-20 sm:h-20 rounded-full shadow-lg hover:scale-105 transition-transform">
                  {isPlaying ? <Pause className="h-7 w-7 sm:h-8 sm:w-8" /> : <Play className="h-7 w-7 sm:h-8 sm:w-8" />}
                  <span className="sr-only">{isPlaying ? 'Pause' : 'Play'}</span>
                </Button>
                <Button onClick={handleNext} variant="ghost" size="lg" disabled={!subtitles.length || currentSentenceIndex >= subtitles.length - 1}>
                  <FastForward className="h-6 w-6" />
                  <span className="sr-only">Next sentence</span>
                </Button>
              </div>

              <ScrollArea className="h-40 w-full rounded-md border p-4">
                <div className="flex flex-col gap-2">
                  {subtitles.map((sub, index) => (
                    <div
                      key={sub.id}
                      ref={el => sentenceScrollRef.current[index] = el}
                      onClick={() => handleSentenceClick(index)}
                      className={cn(
                        "cursor-pointer rounded-md p-2 transition-colors",
                        index === currentSentenceIndex
                          ? 'bg-accent/20'
                          : 'hover:bg-accent/10'
                      )}
                    >
                      <p
                        className={cn(
                          "flex items-start gap-3",
                          index === currentSentenceIndex
                            ? 'font-bold text-foreground'
                            : 'text-muted-foreground'
                        )}
                      >
                        <span className={cn(index === currentSentenceIndex ? 'text-primary' : '')}>{index + 1}.</span>
                        <span>{sub.text}</span>
                      </p>
                    </div>
                  ))}
                </div>
              </ScrollArea>
              
            </div>
          )}
        </CardContent>
        { audioFile && srtFile && subtitles.length > 0 && (
          <CardFooter className="flex justify-center text-sm text-muted-foreground pt-4">
            Sentence {currentSentenceIndex + 1} of {subtitles.length}
          </CardFooter>
        )}
      </Card>
      <audio ref={audioRef} src={audioUrl ?? undefined} onEnded={() => setIsPlaying(false)} />
    </main>
  );
}
