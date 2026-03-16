"use client";

import { useState, useRef, useEffect, ChangeEvent, DragEvent } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { UploadCloud, FileAudio, FileText, CheckCircle2, Coffee, Loader2, Wand2, Globe } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useToast } from '@/hooks/use-toast';
import { PlayerView } from '@/components/player/PlayerView';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';

export type Subtitle = {
  id: number;
  startTime: number;
  endTime: number;
  text: string;
  isStarred: boolean;
};

const BACKEND_URL = "http://localhost:5000";

export default function LinguaPlayerPage() {
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [srtFile, setSrtFile] = useState<File | null>(null);
  const [srtContent, setSrtContent] = useState<string>("");
  const [srtContentAdjusted, setSrtContentAdjusted] = useState<string>("");
  const [activeSrtMode, setActiveSrtMode] = useState<'original' | 'adjusted'>('original');
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [waveformPeaks, setWaveformPeaks] = useState<number[] | null>(null);
  const [subtitles, setSubtitles] = useState<Subtitle[]>([]);
  const [currentSentenceIndex, setCurrentSentenceIndex] = useState(-1);
  const [isPlaying, setIsPlaying] = useState(false);
  const [sentenceProgress, setSentenceProgress] = useState(0);
  const [isDragging, setIsDragging] = useState<'audio' | 'srt' | null>(null);

  // URL processing state (YouTube or podcast)
  const [mediaUrl, setMediaUrl] = useState('');
  const [whisperModel, setWhisperModel] = useState('base');
  const [isProcessing, setIsProcessing] = useState(false);
  const [processingStatus, setProcessingStatus] = useState('');
  const [isGeneratingAdjustedSrt, setIsGeneratingAdjustedSrt] = useState(false);
  const [isExtractingWaveform, setIsExtractingWaveform] = useState(false);

  const audioRef = useRef<HTMLAudioElement>(null);
  const mainContainerRef = useRef<HTMLDivElement>(null);
  // Track the last audio+srt pair we already sent for refinement to avoid duplicate calls
  const lastRefinedKeyRef = useRef<string>('');

  const { toast } = useToast();

  // ── Pure SRT parser (no state side-effects) ────────────────────────────
  // Shared by parseSrt() and handleSrtModeChange() to avoid duplicating logic.
  const parseSrtText = (srtText: string): Subtitle[] => {
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

    const subs = srtText
      .replace(/\r/g, '')
      .split('\n\n')
      .filter(part => part.trim())
      .map((part, index) => {
        const lines = part.trim().split('\n');
        if (lines.length < 2) return null;
        let id = index + 1;
        let timeLineIndex = -1;
        let textStartIndex = -1;
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].includes('-->')) { timeLineIndex = i; break; }
        }
        if (timeLineIndex === -1) return null;
        if (timeLineIndex > 0 && !isNaN(parseInt(lines[timeLineIndex - 1], 10))) {
          id = parseInt(lines[timeLineIndex - 1], 10);
          textStartIndex = timeLineIndex + 1;
        } else {
          if (timeLineIndex === 0) return null;
          if (isNaN(parseInt(lines[0], 10))) {
            textStartIndex = timeLineIndex + 1;
          } else {
            id = parseInt(lines[0], 10);
            textStartIndex = timeLineIndex + 1;
          }
        }
        if (textStartIndex === -1) {
          textStartIndex = 1;
          if (lines[0].match(/^\d+$/)) { textStartIndex = 1; } else { textStartIndex = 0; }
          if (lines[textStartIndex].includes('-->')) { textStartIndex++; }
        }
        const timeMatch = lines[timeLineIndex].match(/(\d{1,2}:\d{2}:\d{2}[,.]\d{3})\s-->\s(\d{1,2}:\d{2}:\d{2}[,.]\d{3})/);
        if (!timeMatch) return null;
        const [, startTimeStr, endTimeStr] = timeMatch;
        const text = lines.slice(textStartIndex).join(' ').trim();
        if (!isNaN(id) && startTimeStr && endTimeStr && text) {
          return { id, startTime: timeToSeconds(startTimeStr), endTime: timeToSeconds(endTimeStr), text, isStarred: false as boolean };
        }
        return null;
      })
      .filter((sub): sub is Subtitle => sub !== null);

    if (subs.length === 0) throw new Error("No subtitles found in the file. Please check the SRT format.");
    return subs;
  };

  const parseSrt = (srtText: string) => {
    try {
      setSrtContent(srtText);
      const subs = parseSrtText(srtText);
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

  // ── Switch playback between Original / Volume-Adjusted SRT ──────────────
  const handleSrtModeChange = (mode: 'original' | 'adjusted') => {
    if (mode === activeSrtMode) return;
    const targetSrt = mode === 'adjusted' ? srtContentAdjusted : srtContent;
    if (!targetSrt) return;

    try {
      const newSubs = parseSrtText(targetSrt);

      setSubtitles(prev => {
        // If the structure matches (same number of sentences), preserve the 
        // current text and star status, only updating the timestamps.
        if (prev.length === newSubs.length) {
          return prev.map((oldSub, i) => ({
            ...oldSub,
            startTime: newSubs[i].startTime,
            endTime: newSubs[i].endTime
          }));
        }
        // Fallback: full replacement if structure changed (e.g. after split/merge)
        return newSubs;
      });

      setActiveSrtMode(mode);
      // We don't reset currentSentenceIndex here to keep user's place
    } catch (e) {
      console.error('Failed to switch SRT mode:', e);
      toast({
        variant: "destructive",
        title: "Mode Switch Failed",
        description: "Could not parse timestamps for the selected mode."
      });
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
      setWaveformPeaks(null);             // reset on new audio
      setSrtContentAdjusted('');          // reset so refinement re-runs for new pair
      lastRefinedKeyRef.current = '';
      setActiveSrtMode('original');       // always start in original mode on new upload
      
      setIsExtractingWaveform(true);
      const formData = new FormData();
      formData.append("file", file);
      fetch(`${BACKEND_URL}/api/extract-peaks`, {
        method: "POST",
        body: formData,
      })
        .then(res => {
          if (!res.ok) throw new Error(`Server returned ${res.status}`);
          return res.json();
        })
        .then(data => { 
          if (data?.waveform_peaks) setWaveformPeaks(data.waveform_peaks); 
        })
        .catch(e => {
          console.error("Failed to extract peaks:", e);
          toast({
            title: "Peak Extraction Failed",
            description: "Falling back to slow client-side decoding.",
            variant: "destructive"
          });
        })
        .finally(() => setIsExtractingWaveform(false));
    } else if (type === 'srt') {
      if (!file.name.endsWith('.srt')) {
        toast({ variant: "destructive", title: "Invalid File", description: "Please upload a .srt file." });
        return;
      }
      setSrtFile(file);
      setSrtContentAdjusted('');          // reset so refinement re-runs for new pair
      lastRefinedKeyRef.current = '';
      setActiveSrtMode('original');       // always start in original mode on new upload
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

  // ── MP3-only Transcription ──────────────────────────────────────────

  const handleTranscribeUpload = async () => {
    if (!audioFile) {
      toast({ variant: "destructive", title: "No Audio", description: "Please upload an MP3 first." });
      return;
    }

    setIsProcessing(true);
    setProcessingStatus("Uploading & transcribing with Whisper…");

    try {
      const formData = new FormData();
      formData.append("file", audioFile);
      formData.append("model", whisperModel);
      formData.append("enable_volume_adjustment", "false");

      const res = await fetch(`${BACKEND_URL}/api/transcribe-upload`, {
        method: "POST",
        body: formData,
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Unknown error" }));
        throw new Error(err.error || `Server error ${res.status}`);
      }

      setProcessingStatus("Processing response…");
      const data = await res.json();

      // Keep the original audio file & URL — just set subtitles
      // (srtFile stays null; PlayerView handles null gracefully)
      parseSrt(data.srt_content);
      if (data.srt_content_adjusted) setSrtContentAdjusted(data.srt_content_adjusted);
      if (data.waveform_peaks) setWaveformPeaks(data.waveform_peaks);

      toast({
        title: "Transcription Complete!",
        description: `${data.sentence_count} sentences generated.`,
      });
    } catch (error) {
      console.error("Transcription error:", error);
      toast({
        variant: "destructive",
        title: "Transcription Failed",
        description: error instanceof Error ? error.message : "An unknown error occurred.",
      });
    } finally {
      setIsProcessing(false);
      setProcessingStatus("");
    }
  };

  // ── URL Processing (auto-detects YouTube vs Podcast) ────────────────

  const isYoutubeUrl = (url: string): boolean => {
    return /(?:youtube\.com|youtu\.be)/i.test(url);
  };

  const handleProcessUrl = async () => {
    if (!mediaUrl.trim()) {
      toast({ variant: "destructive", title: "No URL", description: "Please enter a URL." });
      return;
    }

    const url = mediaUrl.trim();
    const isYT = isYoutubeUrl(url);
    const endpoint = isYT ? '/api/process-youtube' : '/api/process-podcast';

    setIsProcessing(true);
    setProcessingStatus(isYT ? "Downloading YouTube audio & transcribing…" : "Downloading podcast audio & transcribing…");

    try {
      const res = await fetch(`${BACKEND_URL}${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, model: whisperModel, enable_volume_adjustment: false }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Unknown error" }));
        throw new Error(err.error || `Server error ${res.status}`);
      }

      setProcessingStatus("Processing response…");
      const data = await res.json();

      // Decode base64 audio to a File object
      const audioBytes = Uint8Array.from(atob(data.audio_base64), c => c.charCodeAt(0));
      const audioBlob = new Blob([audioBytes], { type: "audio/mpeg" });
      const generatedAudioFile = new File([audioBlob], data.audio_filename, { type: "audio/mpeg" });

      // Create a virtual SRT file
      const srtBlob = new Blob([data.srt_content], { type: "text/plain" });
      const generatedSrtFile = new File([srtBlob], data.audio_filename.replace('.mp3', '.srt'), { type: "text/plain" });

      // Set all state — this triggers the PlayerView to render
      setAudioFile(generatedAudioFile);
      setAudioUrl(URL.createObjectURL(audioBlob));
      setSrtFile(generatedSrtFile);
      parseSrt(data.srt_content);
      if (data.srt_content_adjusted) setSrtContentAdjusted(data.srt_content_adjusted);
      if (data.waveform_peaks) setWaveformPeaks(data.waveform_peaks);

      toast({
        title: "Processing Complete!",
        description: `${data.sentence_count} sentences transcribed.`,
      });
    } catch (error) {
      console.error("URL processing error:", error);
      toast({
        variant: "destructive",
        title: "Processing Failed",
        description: error instanceof Error ? error.message : "An unknown error occurred.",
      });
    } finally {
      setIsProcessing(false);
      setProcessingStatus("");
    }
  };

  // ── Manual generation of volume-adjusted SRT ───────────────────────
  const handleGenerateAdjustedSrt = async () => {
    if (!audioFile || !srtContent) return;

    setIsGeneratingAdjustedSrt(true);
    try {
      const form = new FormData();
      form.append('file', audioFile);
      form.append('srt_content', srtContent);
      const res = await fetch(`${BACKEND_URL}/api/refine-srt`, {
        method: 'POST',
        body: form,
      });

      if (!res.ok) {
        throw new Error("Failed to generate adjusted subtitles");
      }

      const data = await res.json();
      if (data.srt_content_adjusted) {
        setSrtContentAdjusted(data.srt_content_adjusted);
        handleSrtModeChange('adjusted');
        toast({
          title: "Generation Complete",
          description: "Volume-adjusted subtitles are now active.",
        });
      }
    } catch (error) {
      console.error("Failed to generate adjusted SRT:", error);
      toast({
        variant: "destructive",
        title: "Generation Failed",
        description: error instanceof Error ? error.message : "An unknown error occurred.",
      });
    } finally {
      setIsGeneratingAdjustedSrt(false);
    }
  };

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

      // Pause as soon as we reach (or pass) the sentence end.
      // No `isPlaying` guard — the stale closure made it unreliable.
      if (audio.currentTime >= sub.endTime) {
        audio.pause();
        // Snap progress to 100 so the red playhead lands exactly on the blue end handle.
        setSentenceProgress(100);
        return;
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

  const UploadBox = ({ type }: { type: 'audio' | 'srt' }) => {
    const file = type === 'audio' ? audioFile : srtFile;
    const Icon = type === 'audio' ? FileAudio : FileText;
    const title = type === 'audio' ? 'Upload Audio' : 'Upload Subtitle';
    const accept = type === 'audio' ? 'audio/*' : '.srt';

    return (
      <div
        className={cn(
          "relative flex flex-col items-center justify-center p-4 sm:p-6 border-2 border-dashed rounded-lg text-center cursor-pointer transition-colors",
          isDragging === type ? 'border-primary bg-primary/10' : 'border-border hover:border-primary hover:bg-accent/10'
        )}
        onDragEnter={(e) => { e.preventDefault(); e.stopPropagation(); setIsDragging(type); }}
        onDragLeave={(e) => { e.preventDefault(); e.stopPropagation(); setIsDragging(null); }}
        onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
        onDrop={(e) => handleDrop(e, type)}
      >
        {file ? (
          <div className="flex flex-col items-center gap-2 py-2 text-green-600 dark:text-green-400">
            {type === 'audio' && isExtractingWaveform ? (
              <Loader2 className="w-8 h-8 animate-spin text-primary" />
            ) : (
              <CheckCircle2 className="w-8 h-8" />
            )}
            <span className="font-medium text-xs text-center break-all line-clamp-2">
              {type === 'audio' && isExtractingWaveform ? "Extracting waveform..." : file.name}
            </span>
          </div>
        ) : (
          <>
            <UploadCloud className="w-8 h-8 text-muted-foreground mb-2" />
            <h3 className="font-semibold text-sm">{title}</h3>
            <p className="text-muted-foreground text-xs">Click or drag & drop</p>
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

  // ── Reset to upload page ──────────────────────────────────────────────
  const handleBackToUpload = () => {
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.currentTime = 0;
    }
    setAudioFile(null);
    setSrtFile(null);
    setSrtContent('');
    setSrtContentAdjusted('');
    setActiveSrtMode('original');
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    setAudioUrl(null);
    setWaveformPeaks(null);
    setSubtitles([]);
    setCurrentSentenceIndex(-1);
    setIsPlaying(false);
    setSentenceProgress(0);
    lastRefinedKeyRef.current = '';
  };

  // Show upload view when there's no audio, or audio is present but subtitles haven't been loaded yet
  const showUploadView = !audioFile || subtitles.length === 0;

  return (
    <main ref={mainContainerRef} tabIndex={-1} className={cn(
      "flex w-full flex-col items-center bg-background font-body focus:outline-none",
      showUploadView
        ? "min-h-dvh justify-center p-4 sm:p-6 md:p-8"
        : "h-dvh p-2 sm:p-3"
    )}>
      <Card className={cn(
        "w-full shadow-xl animate-in fade-in zoom-in-95 duration-500",
        showUploadView
          ? "max-w-2xl rounded-2xl"
          : "max-w-4xl rounded-xl flex flex-col overflow-hidden",
        !showUploadView && "flex-1 min-h-0"
      )}>
        <CardHeader className={cn("text-center", !showUploadView && "py-1")}>
          <CardTitle
            className={cn(
              showUploadView ? "text-3xl" : "text-base cursor-pointer hover:text-primary transition-colors",
              "font-headline tracking-tight"
            )}
            onClick={!showUploadView ? handleBackToUpload : undefined}
            title={!showUploadView ? 'Back to upload page' : undefined}
          >
            Lingua Player
          </CardTitle>
          {showUploadView && <CardDescription>Practice listening sentence by sentence.</CardDescription>}
        </CardHeader>
        <CardContent className={cn(!showUploadView && "flex-1 min-h-0 flex flex-col p-3 sm:p-4")}>
          {showUploadView ? (
            <div className="flex flex-col gap-6">
              {/* ── URL Section (YouTube / Podcast) ─────────────── */}
              <div className="flex flex-col gap-3 p-4 sm:p-6 border-2 border-dashed rounded-lg border-border bg-accent/5">
                <div className="flex items-center gap-2 text-foreground">
                  <Globe className="w-5 h-5 text-blue-500" />
                  <h3 className="font-semibold">From URL</h3>
                </div>
                <p className="text-muted-foreground text-sm">
                  Paste a YouTube video URL, podcast episode link, or direct MP3 URL to auto-download audio &amp; generate subtitles with Whisper.
                </p>
                <div className="flex flex-col sm:flex-row gap-2">
                  <Input
                    type="url"
                    placeholder="YouTube URL, podcast URL, or direct .mp3 link"
                    value={mediaUrl}
                    onChange={(e) => setMediaUrl(e.target.value)}
                    disabled={isProcessing}
                    className="flex-1"
                    id="media-url-input"
                  />
                  <Select value={whisperModel} onValueChange={setWhisperModel} disabled={isProcessing}>
                    <SelectTrigger className="w-full sm:w-[120px]" id="model-select">
                      <SelectValue placeholder="Model" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="base">Base</SelectItem>
                      <SelectItem value="small">Small</SelectItem>
                      <SelectItem value="medium">Medium</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <Button
                  onClick={handleProcessUrl}
                  disabled={isProcessing || !mediaUrl.trim()}
                  className="w-full"
                  id="process-url-btn"
                >
                  {isProcessing ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      {processingStatus || "Processing…"}
                    </>
                  ) : (
                    "Download & Transcribe"
                  )}
                </Button>
              </div>

              {/* ── Divider ─────────────────────────────────────── */}
              <div className="flex items-center gap-3">
                <div className="flex-1 h-px bg-border" />
                <span className="text-xs text-muted-foreground font-medium uppercase tracking-wider">or upload files</span>
                <div className="flex-1 h-px bg-border" />
              </div>

              {/* ── Manual Upload Section ───────────────────────── */}
              <div className="grid grid-cols-2 gap-3">
                <UploadBox type="audio" />
                <UploadBox type="srt" />
              </div>

              {/* ── MP3-only Transcribe Section (shown when audio is loaded but no subtitles yet) ── */}
              {audioFile && subtitles.length === 0 && (
                <div className="flex flex-col gap-3 p-4 sm:p-5 border-2 border-dashed rounded-lg border-primary/40 bg-primary/5 animate-in fade-in slide-in-from-bottom-2 duration-300">
                  <div className="flex items-center gap-2 text-foreground">
                    <Wand2 className="w-5 h-5 text-primary" />
                    <h3 className="font-semibold">Auto-Transcribe with Whisper</h3>
                  </div>
                  <p className="text-muted-foreground text-sm">
                    No SRT file? Generate subtitles automatically from <span className="font-medium text-foreground">{audioFile.name}</span>.
                  </p>
                  <div className="flex flex-col sm:flex-row gap-2">
                    <Select value={whisperModel} onValueChange={setWhisperModel} disabled={isProcessing}>
                      <SelectTrigger className="w-full sm:w-[140px]" id="upload-model-select">
                        <SelectValue placeholder="Model" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="base">Base (fast)</SelectItem>
                        <SelectItem value="small">Small</SelectItem>
                        <SelectItem value="medium">Medium (accurate)</SelectItem>
                      </SelectContent>
                    </Select>
                    <Button
                      onClick={handleTranscribeUpload}
                      disabled={isProcessing}
                      className="flex-1"
                      id="transcribe-upload-btn"
                    >
                      {isProcessing ? (
                        <>
                          <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                          {processingStatus || "Transcribing…"}
                        </>
                      ) : (
                        <>
                          <Wand2 className="w-4 h-4 mr-2" />
                          Transcribe
                        </>
                      )}
                    </Button>
                  </div>
                </div>
              )}
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
              srtContentAdjusted={srtContentAdjusted}
              activeSrtMode={activeSrtMode}
              onSrtModeChange={handleSrtModeChange}
              waveformPeaks={waveformPeaks}
              isGeneratingAdjustedSrt={isGeneratingAdjustedSrt}
              onGenerateAdjustedSrt={handleGenerateAdjustedSrt}
              isExtractingWaveform={isExtractingWaveform}
            />
          )}
        </CardContent>
        {audioFile && subtitles.length > 0 && (
          <CardFooter className="flex items-center justify-center text-sm text-muted-foreground py-2">
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
