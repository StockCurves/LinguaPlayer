"use client";

import { useState, useRef, useEffect, ChangeEvent, DragEvent } from 'react';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { Rewind, FastForward, UploadCloud, FileAudio, FileText, CheckCircle2, Play, Pause, Star, Check, X, Download, FileCode, Coffee } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useToast } from '@/hooks/use-toast';
import { VolumeDisplay } from '@/components/ui/volume-display';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';


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
  const [srtContent, setSrtContent] = useState<string>("");
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [subtitles, setSubtitles] = useState<Subtitle[]>([]);
  const [currentSentenceIndex, setCurrentSentenceIndex] = useState(-1);
  const [isPlaying, setIsPlaying] = useState(false);
  const [sentenceProgress, setSentenceProgress] = useState(0);
  const [isDragging, setIsDragging] = useState<'audio' | 'srt' | null>(null);
  const [showOnlyStarred, setShowOnlyStarred] = useState(false);
  const [editingSubtitleId, setEditingSubtitleId] = useState<number | null>(null);
  const [editingText, setEditingText] = useState('');

  const audioRef = useRef<HTMLAudioElement>(null);
  const sentenceScrollRef = useRef<(HTMLDivElement | null)[]>([]);
  const mainContainerRef = useRef<HTMLDivElement>(null);
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
        // When generating SRT for a filtered list, we need to re-number the IDs.
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
      sentenceScrollRef.current = sentenceScrollRef.current.slice(0, subs.length);
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

    const currentVisibleIndex = visibleSubtitles.findIndex(s => s.id === currentSubInFullList.id);
    const currentSubInVisibleList = visibleSubtitles[currentVisibleIndex];
    
    if (!currentSubInVisibleList) return;

    if (audio.paused) {
      if (audio.currentTime >= currentSubInVisibleList.endTime - 0.1) {
        // If at the end of a sentence, find the next one in the visible list
        if (currentVisibleIndex < visibleSubtitles.length - 1) {
          const nextVisibleSub = visibleSubtitles[currentVisibleIndex + 1];
          const nextOriginalIndex = subtitles.findIndex(s => s.id === nextVisibleSub.id);
          if (nextOriginalIndex !== -1) playSentence(nextOriginalIndex);
        }
      } else {
        // Otherwise, resume or start playing the currently highlighted sentence
        playSentence(currentSentenceIndex);
      }
    } else {
      audio.pause();
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
      if(newOriginalIndex !== -1) {
        setCurrentSentenceIndex(newOriginalIndex);
      }
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
      if(newOriginalIndex !== -1) {
        setCurrentSentenceIndex(newOriginalIndex);
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
      
      if (visibleIndex !== -1 && !editingSubtitleId) {
        sentenceScrollRef.current[visibleIndex]?.scrollIntoView({
          behavior: 'smooth',
          block: 'center'
        });
      }
    }
  }, [currentSentenceIndex, audioFile, srtFile, subtitles, showOnlyStarred, visibleSubtitles, editingSubtitleId]);


  useEffect(() => {
    const handleKeyDown = (e: globalThis.KeyboardEvent) => {
      if (editingSubtitleId) return;
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
  }, [audioFile, srtFile, currentSentenceIndex, subtitles, showOnlyStarred, visibleSubtitles, editingSubtitleId]);

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
              <Progress value={sentenceProgress} className="w-full h-2 [&>div]:bg-accent" />
              
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
                  {isPlaying ? <Pause className="h-7 w-7 sm:h-8 sm:w-8" /> : <Play className="h-7 w-7 sm:h-8 sm-w-8" />}
                  <span className="sr-only">{isPlaying ? 'Pause' : 'Play'}</span>
                </Button>
                <Button onClick={handleNext} variant="ghost" size="lg" disabled={!visibleSubtitles.length || visibleSubtitles.findIndex(s => s.id === subtitles[currentSentenceIndex]?.id) >= visibleSubtitles.length - 1}>
                  <FastForward className="h-6 w-6" />
                  <span className="sr-only">Next sentence</span>
                </Button>
              </div>

            </div>
          )}
        </CardContent>
        <CardFooter className="flex flex-col gap-4 items-center justify-center text-sm text-muted-foreground pt-4">
            { audioFile && srtFile && visibleSubtitles.length > 0 && currentSentenceIndex !== -1 && (
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
      </Card>
      <audio ref={audioRef} src={audioUrl ?? undefined} onEnded={() => {
        setIsPlaying(false)
      }} />
    </main>
  );
}

    