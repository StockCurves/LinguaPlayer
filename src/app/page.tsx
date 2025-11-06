"use client";

import { useState, useRef, useEffect, ChangeEvent, DragEvent } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { UploadCloud, FileAudio, FileText, CheckCircle2, Coffee } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useToast } from '@/hooks/use-toast';
import { PlayerView } from '@/components/player/PlayerView';

export type Subtitle = {
  id: number;
  startTime: number;
  endTime: number;
  text: string;
  isStarred?: boolean;
};

export default function LinguaPlayerPage() {
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [srtFile, setSrtFile] = useState<File | null>(null);
  const [srtContent, setSrtContent] = useState<string>("");
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [subtitles, setSubtitles] = useState<Subtitle[]>([]);
  const [currentSentenceIndex, setCurrentSentenceIndex] = useState(-1);
  const [isPlaying, setIsPlaying] = useState(false);
  const [sentenceProgress, setSentenceProgress] = useState(0);
  const [isDragging, setIsDragging] = useState<'audio' | 'srt' | null>(null);
  
  const audioRef = useRef<HTMLAudioElement>(null);
  const mainContainerRef = useRef<HTMLDivElement>(null);

  const { toast } = useToast();

  const parseSrt = (srtText: string) => {
    try {
      setSrtContent(srtText);
      const timeToSeconds = (time: string): number => {
        const timeString = time.replace(',', '.');
        const parts = timeString.split(':');
        if (parts.length !== 3) throw new Error('Invalid time format: ' + time);
        
        const secondsParts = parts[2].split('.');
        if (secondsParts.length !== 2) throw new Error('Invalid seconds format in time: ' + time);

        const hours = parseInt(parts[0], 10);
        const minutes = parseInt(parts[1], 10);
        const seconds = parseInt(secondsParts[0], 10);
        const milliseconds = parseInt(secondsParts[1], 10);
        return hours * 3600 + minutes * 60 + seconds + milliseconds / 1000;
      };

      const subs: Subtitle[] = srtText
        .replace(/\r/g, '')
        .split('\n\n')
        .filter(part => part.trim())
        .map((part, index) => {
          const lines = part.trim().split('\n');
          if (lines.length < 2) return null;
          
          let id = index + 1;
          let timeLineIndex = -1;
          let textStartIndex = -1;

          // Find the timeline
          for(let i = 0; i < lines.length; i++) {
              if (lines[i].includes('-->')) {
                  timeLineIndex = i;
                  break;
              }
          }
          if (timeLineIndex === -1) return null;
          
          // Try to parse an ID if it exists before the timeline
          if (timeLineIndex > 0 && !isNaN(parseInt(lines[timeLineIndex - 1], 10))) {
             id = parseInt(lines[timeLineIndex - 1], 10);
             textStartIndex = timeLineIndex + 1;
          } else {
             // If no numeric ID, the ID might be the first line, or we use index.
             if (timeLineIndex === 0) return null; // No room for text
             if(isNaN(parseInt(lines[0], 10))) {
                textStartIndex = timeLineIndex + 1;
             } else {
                id = parseInt(lines[0], 10);
                textStartIndex = timeLineIndex + 1;
             }
          }
           if (textStartIndex === -1) {
            textStartIndex = 1;
            if (lines[0].match(/^\d+$/)) {
              textStartIndex = 1;
            } else {
              textStartIndex = 0;
            }
            if (lines[textStartIndex].includes('-->')) {
                textStartIndex++;
            }
          }


          const timeMatch = lines[timeLineIndex].match(/(\d{1,2}:\d{2}:\d{2}[,.]\d{3})\s-->\s(\d{1,2}:\d{2}:\d{2}[,.]\d{3})/);
          if (!timeMatch) return null;

          const [, startTimeStr, endTimeStr] = timeMatch;
          const text = lines.slice(textStartIndex).join(' ').trim();
          
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
    } catch (error) {
      console.error("SRT Parsing Error:", error);
      toast({
        variant: "destructive",
        title: "SRT Parsing Failed",
        description: error instanceof Error ? error.message : "Could not parse the SRT file. Please ensure it's correctly formatted.",
      });
      setSrtFile(null);
      setSrtContent("");
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
    if (!audio || index < 0 || index >= subtitles.length) return;
    
    setCurrentSentenceIndex(index);
    audio.currentTime = subtitles[index].startTime;
    if (audio.paused) {
      audio.play().catch(e => console.error("Audio play failed:", e));
    }
  };

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !subtitles.length || currentSentenceIndex === -1) return;

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
            <PlayerView
              audioRef={audioRef}
              audioFile={audioFile}
              srtFile={srtFile}
              subtitles={subtitles}
              setSubtitles={setSubtitles}
              currentSentenceIndex={currentSentenceIndex}
              setCurrentSentenceIndex={setCurrentSentenceIndex}
              isPlaying={isPlaying}
              sentenceProgress={sentenceProgress}
              playSentence={playSentence}
              srtContent={srtContent}
              setSrtContent={setSrtContent}
            />
          )}
        </CardContent>
        {audioFile && srtFile && (
          <CardFooter className="flex flex-col gap-4 items-center justify-center text-sm text-muted-foreground pt-4">
              { subtitles.length > 0 && currentSentenceIndex !== -1 && (
                  <span>
                      Sentence {subtitles.findIndex(s => s.id === subtitles[currentSentenceIndex]?.id) + 1} of {subtitles.length}
                  </span>
              )}
              <a
                  href="https://buymeacoffee.com/stockcurves"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                  <Coffee className="w-4 h-4" />
                  <span>Buy me a coffee</span>
              </a>
          </CardFooter>
        )}
      </Card>
      <audio ref={audioRef} src={audioUrl ?? undefined} onEnded={() => setIsPlaying(false)} />
    </main>
  );
}
