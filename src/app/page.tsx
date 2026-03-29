"use client";

import { useState, useRef, useEffect, ChangeEvent, DragEvent } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { UploadCloud, FileAudio, FileText, CheckCircle2, Coffee, Loader2, Wand2, Globe, Library, Clock, History, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useToast } from '@/hooks/use-toast';
import { PlayerView } from '@/components/player/PlayerView';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';

export type Subtitle = {
  id: number;
  startTime: number;
  endTime: number;
  text: string;
  isStarred: boolean;
};

const BACKEND_URL = "http://127.0.0.1:5000";

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

  // Dashboard state
  const [dashboardFiles, setDashboardFiles] = useState<{ id: string, title: string, filename: string, date: string, has_modified_srt: boolean }[]>([]);
  const [isLoadingDashboard, setIsLoadingDashboard] = useState(false);
  const [loadingFileId, setLoadingFileId] = useState<string | null>(null);
  const [existingFilePrompt, setExistingFilePrompt] = useState<{ show: boolean, file_id: string, original_srt: string, modified_srt: string, filename: string, audio_base64: string, starred_indices?: number[] } | null>(null);
  const [currentFileId, setCurrentFileId] = useState<string | null>(null);
  const [deleteConfirmDialog, setDeleteConfirmDialog] = useState<{ show: boolean, file_id: string, title: string } | null>(null);

  useEffect(() => {
    fetchDashboardFiles();
  }, []);

  const fetchDashboardFiles = async () => {
    setIsLoadingDashboard(true);
    try {
      const res = await fetch(`${BACKEND_URL}/api/dashboard-files`);
      if (res.ok) {
        const data = await res.json();
        setDashboardFiles(data.files || []);
      }
    } catch (e) {
      console.error("Failed to load dashboard files", e);
    } finally {
      setIsLoadingDashboard(false);
    }
  };

  const loadDashboardFile = async (file_id: string, fileName: string) => {
    setLoadingFileId(file_id);
    setIsProcessing(true);
    setProcessingStatus("Loading from Library...");
    try {
      const res = await fetch(`${BACKEND_URL}/api/load-dashboard-file/${file_id}`);
      if (!res.ok) throw new Error("Failed to load file");
      const data = await res.json();
      
      const audioBytes = Uint8Array.from(atob(data.audio_base64), c => c.charCodeAt(0));
      const audioBlob = new Blob([audioBytes], { type: "audio/mpeg" });
      const generatedAudioFile = new File([audioBlob], fileName || data.filename, { type: "audio/mpeg" });
      
      setCurrentFileId(file_id);
      setAudioFile(generatedAudioFile);
      setAudioUrl(URL.createObjectURL(audioBlob));
      
      if (data.original_srt) {
        const parsedSubs = parseSrtText(data.original_srt);
        if (data.starred_indices && Array.isArray(data.starred_indices)) {
          const starredIds = new Set(data.starred_indices);
          parsedSubs.forEach(sub => {
            if (starredIds.has(sub.id)) {
              sub.isStarred = true;
            }
          });
        }
        setSrtContent(data.original_srt);
        setSubtitles(parsedSubs);
        setCurrentSentenceIndex(0);
      }
      if (data.modified_srt) setSrtContentAdjusted(data.modified_srt);
      if (data.waveform_peaks) setWaveformPeaks(data.waveform_peaks);
      
      toast({ title: "Loaded from Library!" });
    } catch (e) {
      console.error("Load error:", e);
      toast({ variant: "destructive", title: "Load Failed", description: "Failed to load library item." });
    } finally {
      setLoadingFileId(null);
      setIsProcessing(false);
      setProcessingStatus("");
    }
  };

  const deleteDashboardFile = async (file_id: string) => {
    try {
      const res = await fetch(`${BACKEND_URL}/api/delete-dashboard-file/${file_id}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("Failed to delete file");
      
      toast({ title: "Deleted from Library" });
      fetchDashboardFiles();
      setDeleteConfirmDialog(null);
    } catch (e) {
      console.error("Delete error:", e);
      toast({ variant: "destructive", title: "Delete Failed", description: "Failed to delete library item." });
    }
  };

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

  const handleTranscribeUpload = async (force: boolean = false) => {
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
      formData.append("force_transcribe", force ? "true" : "false");

      const res = await fetch(`${BACKEND_URL}/api/transcribe-upload`, {
        method: "POST",
        body: formData,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "No response body");
        let err;
        try {
          err = JSON.parse(text);
        } catch (e) {
          throw new Error(`Server error ${res.status}: ${text.slice(0, 100)}${text.length > 100 ? '...' : ''}`);
        }
        throw new Error(err.error || `Server error ${res.status}`);
      }

      setProcessingStatus("Processing response…");
      const data = await res.json();

      if (data.exists && !force) {
        setExistingFilePrompt({
          show: true,
          file_id: data.file_id,
          original_srt: data.original_srt,
          modified_srt: data.modified_srt,
          filename: data.filename,
          audio_base64: data.audio_base64,
          starred_indices: data.starred_indices
        });
        setIsProcessing(false);
        setProcessingStatus("");
        return;
      }
      
      setCurrentFileId(data.file_id);

      // Keep the original audio file & URL — just set subtitles
      // (srtFile stays null; PlayerView handles null gracefully)
      parseSrt(data.srt_content);
      if (data.srt_content_adjusted) setSrtContentAdjusted(data.srt_content_adjusted);
      if (data.waveform_peaks) setWaveformPeaks(data.waveform_peaks);

      toast({
        title: "Transcription Complete!",
        description: `${data.sentence_count} sentences generated.`,
      });
      fetchDashboardFiles(); // refresh dashboard
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

  // ── URL Processing (auto-detects YouTube vs Podcast on server) ───────

  const handleProcessUrl = async () => {
    if (!mediaUrl.trim()) {
      toast({ variant: "destructive", title: "No URL", description: "Please enter a URL." });
      return;
    }

    const url = mediaUrl.trim();
    setIsProcessing(true);
    setProcessingStatus("Connecting…");

    try {
      const res = await fetch(`${BACKEND_URL}/api/process-url-stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, model: whisperModel, enable_volume_adjustment: false }),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "No response body");
        let err;
        try { err = JSON.parse(text); } catch { /* ignore */ }
        throw new Error(err?.error || `Server error ${res.status}: ${text.slice(0, 200)}`);
      }

      // Read the SSE stream
      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      if (!reader) throw new Error("No response stream");

      let buffer = "";
      let finalData: Record<string, unknown> | null = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Parse complete SSE events from the buffer
        const events = buffer.split("\n\n");
        buffer = events.pop() || ""; // keep the incomplete tail

        for (const eventBlock of events) {
          if (!eventBlock.trim()) continue;
          const lines = eventBlock.split("\n");
          let eventType = "";
          let eventData = "";
          for (const line of lines) {
            if (line.startsWith("event: ")) eventType = line.slice(7).trim();
            if (line.startsWith("data: ")) eventData = line.slice(6);
          }

          if (!eventType || !eventData) continue;
          const parsed = JSON.parse(eventData);

          if (eventType === "progress") {
            setProcessingStatus(parsed.message || "Processing…");
          } else if (eventType === "done") {
            finalData = parsed;
          } else if (eventType === "error") {
            throw new Error(parsed.error || "Server error during processing");
          }
        }
      }

      if (!finalData) throw new Error("Stream ended without result");

      // Decode base64 audio to a File object
      const audioBytes = Uint8Array.from(atob(finalData.audio_base64 as string), c => c.charCodeAt(0));
      const audioBlob = new Blob([audioBytes], { type: "audio/mpeg" });
      const generatedAudioFile = new File([audioBlob], finalData.audio_filename as string, { type: "audio/mpeg" });

      // Create a virtual SRT file
      const srtBlob = new Blob([finalData.srt_content as string], { type: "text/plain" });
      const generatedSrtFile = new File([srtBlob], (finalData.audio_filename as string).replace('.mp3', '.srt'), { type: "text/plain" });

      // Set all state — triggers the PlayerView to render
      setCurrentFileId(finalData.file_id as string);
      setAudioFile(generatedAudioFile);
      setAudioUrl(URL.createObjectURL(audioBlob));
      setSrtFile(generatedSrtFile);
      parseSrt(finalData.srt_content as string);
      if (finalData.srt_content_adjusted) setSrtContentAdjusted(finalData.srt_content_adjusted as string);
      if (finalData.waveform_peaks) setWaveformPeaks(finalData.waveform_peaks as number[]);

      toast({
        title: "Processing Complete!",
        description: `${finalData.sentence_count} sentences transcribed.`,
      });
      fetchDashboardFiles(); // refresh library
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
        const text = await res.text().catch(() => "No response body");
        let err;
        try {
          err = JSON.parse(text);
        } catch (e) {
          throw new Error(`Server error ${res.status}: ${text.slice(0, 100)}${text.length > 100 ? '...' : ''}`);
        }
        throw new Error(err.error || `Server error ${res.status}`);
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

  const renderUploadBox = (type: 'audio' | 'srt') => {
    const file = type === 'audio' ? audioFile : srtFile;
    const Icon = type === 'audio' ? FileAudio : FileText;
    const title = type === 'audio' ? 'Audio File' : 'Subtitle File';
    const accept = type === 'audio' ? 'audio/*' : '.srt';

    return (
      <div
        className={cn(
          "relative flex flex-col items-center justify-center p-4 border-2 border-dashed rounded-[1.5rem] text-center cursor-pointer transition-all duration-300 group",
          isDragging === type 
            ? 'border-primary bg-primary/10 scale-[1.02]' 
            : 'border-secondary bg-secondary/20 hover:border-primary/50 hover:bg-secondary/40'
        )}
        onDragEnter={(e) => { e.preventDefault(); e.stopPropagation(); setIsDragging(type); }}
        onDragLeave={(e) => { e.preventDefault(); e.stopPropagation(); setIsDragging(null); }}
        onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
        onDrop={(e) => handleDrop(e, type)}
      >
        <div className={cn(
          "mb-3 p-3 rounded-2xl transition-all duration-300 group-hover:scale-110",
          file ? "bg-green-500/10 text-green-500" : "bg-background/50 text-muted-foreground"
        )}>
          {file ? (
            type === 'audio' && isExtractingWaveform ? (
              <Loader2 className="w-6 h-6 animate-spin text-primary" />
            ) : (
              <CheckCircle2 className="w-6 h-6" />
            )
          ) : (
            <Icon className="w-6 h-6" />
          )}
        </div>

        {file ? (
          <div className="flex flex-col items-center gap-1 px-2">
            <span className="font-bold text-xs text-foreground line-clamp-1">
              {type === 'audio' && isExtractingWaveform ? "Extracting..." : file.name}
            </span>
            <span className="text-[10px] text-muted-foreground uppercase font-bold tracking-tighter">Ready</span>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-1">
            <h3 className="font-bold text-sm tracking-tight">{title}</h3>
          </div>
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
    setCurrentFileId(null);
    fetchDashboardFiles(); // refresh context
  };

  // ── Existing File Prompt Dialog Accept ────────────────────────────
  const handleAcceptExistingFiles = () => {
    if (!existingFilePrompt) return;
    
    setIsProcessing(true);
    setProcessingStatus("Extracting audio...");
    setTimeout(() => {
      try {
        if (existingFilePrompt.audio_base64 && existingFilePrompt.audio_base64.length > 0) {
           const audioBytes = Uint8Array.from(atob(existingFilePrompt.audio_base64), c => c.charCodeAt(0));
           const audioBlob = new Blob([audioBytes], { type: "audio/mpeg" });
           const generatedAudioFile = new File([audioBlob], existingFilePrompt.filename, { type: "audio/mpeg" });
           setAudioFile(generatedAudioFile);
           setAudioUrl(URL.createObjectURL(audioBlob));
        }
      
        setCurrentFileId(existingFilePrompt.file_id);
        if (existingFilePrompt.original_srt) {
          const parsedSubs = parseSrtText(existingFilePrompt.original_srt);
          if (existingFilePrompt.starred_indices && Array.isArray(existingFilePrompt.starred_indices)) {
            const starredIds = new Set(existingFilePrompt.starred_indices);
            parsedSubs.forEach(sub => {
              if (starredIds.has(sub.id)) {
                sub.isStarred = true;
              }
            });
          }
          setSrtContent(existingFilePrompt.original_srt);
          setSubtitles(parsedSubs);
          setCurrentSentenceIndex(0);
        }
        if (existingFilePrompt.modified_srt) setSrtContentAdjusted(existingFilePrompt.modified_srt);
        
        toast({ title: "Loaded Existing Sentences!" });
      } catch (e) {
        console.error(e);
      } finally {
        setIsProcessing(false);
        setProcessingStatus("");
        setExistingFilePrompt(null);
      }
    }, 100);
  };

  // Show upload view when there's no audio, or audio is present but subtitles haven't been loaded yet
  const showUploadView = !audioFile || subtitles.length === 0;

  return (
    <main ref={mainContainerRef} tabIndex={-1} className={cn(
      "flex w-full flex-col items-center bg-background font-body focus:outline-none transition-colors duration-500",
      showUploadView
        ? "min-h-dvh justify-center p-2 sm:p-4 premium-gradient"
        : "h-dvh p-2 sm:p-3"
    )}>
      {/* Background Decorative Elements */}
      {showUploadView && (
        <div className="fixed inset-0 overflow-hidden pointer-events-none">
          <div className="absolute -top-[10%] -left-[10%] w-[40%] h-[40%] bg-primary/20 rounded-full blur-[120px] animate-pulse" />
          <div className="absolute -bottom-[10%] -right-[10%] w-[40%] h-[40%] bg-accent/20 rounded-full blur-[120px] animate-pulse" style={{ animationDelay: '2s' }} />
        </div>
      )}
      <Card className={cn(
        "w-full shadow-2xl transition-all duration-700",
        showUploadView
          ? "max-w-3xl glass-panel border-white/20 rounded-[2rem] p-1 sm:p-2 anim-slide-up"
          : "max-w-5xl rounded-2xl flex flex-col overflow-hidden border-none shadow-none",
        !showUploadView && "flex-1 min-h-0"
      )}>
        <CardHeader className={cn("text-center space-y-1", showUploadView ? "pb-2" : "py-1")}>

          <CardTitle
            className={cn(
              showUploadView ? "text-3xl sm:text-4xl" : "text-lg cursor-pointer hover:text-primary transition-colors",
              "font-headline tracking-tight font-bold bg-clip-text text-transparent bg-gradient-to-r from-primary to-primary/60"
            )}
            onClick={!showUploadView ? handleBackToUpload : undefined}
            title={!showUploadView ? 'Back to upload page' : undefined}
          >
            Lingua Player
          </CardTitle>
          {showUploadView && (
            <CardDescription className="text-base sm:text-lg text-muted-foreground/80 max-w-none mx-auto">
              Master any language with interactive, sentence-by-sentence playback.
            </CardDescription>
          )}
        </CardHeader>
        <CardContent className={cn(!showUploadView && "flex-1 min-h-0 flex flex-col p-3 sm:p-4")}>
          {showUploadView ? (
            <div className="flex flex-col gap-4 py-2 sm:py-4">
              {/* ── URL Section (YouTube / Podcast) ─────────────── */}
              <div className="flex flex-col gap-3 p-4 rounded-2xl bg-secondary/30 border border-secondary/50 shadow-inner group transition-all hover:bg-secondary/40">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="rounded-full bg-blue-500/10 p-2 text-blue-500">
                      <Globe className="w-5 h-5" />
                    </div>
                    <h3 className="font-bold text-lg">Import from URL</h3>
                  </div>
                  <span className="text-[10px] font-bold uppercase tracking-widest text-primary/60">Automated</span>
                </div>
                
                <p className="text-muted-foreground text-sm leading-relaxed">
                  Paste a link to a YouTube video or podcast. We'll handle the download and generate precise subtitles for you.
                </p>

                <div className="flex flex-col gap-3">
                  <div className="flex flex-col sm:flex-row gap-3">
                    <div className="relative flex-1 group/input">
                      <Input
                        type="url"
                        placeholder="Paste link here..."
                        value={mediaUrl}
                        onChange={(e) => setMediaUrl(e.target.value)}
                        disabled={isProcessing}
                        className="h-10 bg-background/50 border-secondary focus-visible:ring-primary pl-4 pr-4 transition-all"
                        id="media-url-input"
                      />
                    </div>
                    <Select value={whisperModel} onValueChange={setWhisperModel} disabled={isProcessing}>
                      <SelectTrigger className="w-full sm:w-[130px] h-10 bg-background/50 border-secondary" id="model-select">
                        <SelectValue placeholder="Model" />
                      </SelectTrigger>
                      <SelectContent className="glass-panel-heavy">
                        <SelectItem value="base" className="cursor-pointer">Base (Fast)</SelectItem>
                        <SelectItem value="small" className="cursor-pointer">Small</SelectItem>
                        <SelectItem value="medium" className="cursor-pointer">Medium (Pro)</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <Button
                    onClick={handleProcessUrl}
                    disabled={isProcessing || !mediaUrl.trim()}
                    className="w-full h-10 font-bold text-base shadow-lg shadow-primary/20 transition-all hover:scale-[1.01] active:scale-[0.99] rounded-xl overflow-hidden relative"
                    id="process-url-btn"
                  >
                    {isProcessing ? (
                      <div className="flex items-center justify-center gap-3">
                        <Loader2 className="w-5 h-5 animate-spin" />
                        <span className="font-medium">Processing…</span>
                      </div>
                    ) : (
                      <span className="flex items-center gap-2">
                        Get Started <Wand2 className="w-4 h-4" />
                      </span>
                    )}
                  </Button>
                  {isProcessing && processingStatus && (
                    <div className="flex items-center gap-3 p-3 rounded-xl bg-primary/5 border border-primary/15 anim-slide-up">
                      <div className="w-2 h-2 rounded-full bg-primary animate-pulse shrink-0" />
                      <span className="text-sm text-foreground/80 font-medium truncate">{processingStatus}</span>
                    </div>
                  )}
                </div>
              </div>

              {/* ── Divider ─────────────────────────────────────── */}
              <div className="flex items-center gap-3 px-2">
                <div className="flex-1 h-px bg-gradient-to-r from-transparent via-border to-transparent" />
                <span className="text-[10px] text-muted-foreground font-bold uppercase tracking-[0.2em]">Local Files</span>
                <div className="flex-1 h-px bg-gradient-to-r from-transparent via-border to-transparent" />
              </div>

              {/* ── Manual Upload Section ───────────────────────── */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {renderUploadBox('audio')}
                {renderUploadBox('srt')}
              </div>

              {/* ── MP3-only Transcribe Section ── */}
              {audioFile && subtitles.length === 0 && (
                <div className="flex flex-col gap-3 p-4 rounded-2xl bg-primary/5 border border-primary/20 anim-slide-up">
                  <div className="flex items-center gap-3">
                    <div className="rounded-full bg-primary/10 p-2 text-primary">
                      <Wand2 className="w-5 h-5" />
                    </div>
                    <h3 className="font-bold text-lg">No Subtitles Found</h3>
                  </div>
                  <p className="text-muted-foreground text-sm leading-relaxed">
                    We've loaded <span className="font-bold text-foreground">{audioFile.name}</span>. Would you like us to generate subtitles automatically?
                  </p>
                  <div className="flex flex-col sm:flex-row gap-3">
                    <Select value={whisperModel} onValueChange={setWhisperModel} disabled={isProcessing}>
                      <SelectTrigger className="w-full sm:w-[150px] h-11 bg-background/50 border-primary/20" id="upload-model-select">
                        <SelectValue placeholder="Model" />
                      </SelectTrigger>
                      <SelectContent className="glass-panel-heavy">
                        <SelectItem value="base">Base (Fast)</SelectItem>
                        <SelectItem value="small">Small</SelectItem>
                        <SelectItem value="medium">Medium (Accurate)</SelectItem>
                      </SelectContent>
                    </Select>
                    <Button
                      onClick={() => handleTranscribeUpload(false)}
                      disabled={isProcessing}
                      className="flex-1 h-11 font-bold shadow-md shadow-primary/10 transition-all hover:scale-[1.02]"
                      id="transcribe-upload-btn"
                    >
                      {isProcessing ? (
                        <div className="flex items-center gap-2">
                          <Loader2 className="w-4 h-4 animate-spin" />
                          <span>{processingStatus || "Transcribing…"}</span>
                        </div>
                      ) : (
                        <span className="flex items-center gap-2">
                          <Wand2 className="w-4 h-4" /> Start AI Transcription
                        </span>
                      )}
                    </Button>
                  </div>
                </div>
              )}

              {/* ── Dashboard / Library Section ── */}
              <div className="mt-8 flex flex-col gap-4">
                <div className="flex items-center gap-3 px-2">
                  <div className="flex-1 h-px bg-gradient-to-r from-transparent via-border to-transparent" />
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-muted-foreground font-bold uppercase tracking-[0.2em] flex items-center gap-2">
                      <Library className="w-3 h-3" /> Library
                    </span>
                    <Button 
                      variant="ghost" 
                      size="icon" 
                      className="w-5 h-5 rounded-full hover:bg-primary/10 hover:text-primary transition-colors"
                      onClick={(e) => { e.stopPropagation(); fetchDashboardFiles(); }}
                      disabled={isLoadingDashboard}
                    >
                      <History className={cn("w-3 h-3", isLoadingDashboard && "animate-spin")} />
                    </Button>
                  </div>
                  <div className="flex-1 h-px bg-gradient-to-r from-transparent via-border to-transparent" />
                </div>
                
                {isLoadingDashboard ? (
                  <div className="flex justify-center p-8">
                    <Loader2 className="w-6 h-6 animate-spin text-primary/40" />
                  </div>
                ) : dashboardFiles.length > 0 ? (
                  <>
                  {/* Loading banner shown when a file is being fetched */}
                  {loadingFileId && (
                    <div className="flex items-center gap-3 p-3 rounded-xl bg-primary/10 border border-primary/20 anim-slide-up mb-1">
                      <Loader2 className="w-4 h-4 animate-spin text-primary shrink-0" />
                      <span className="text-sm font-medium text-foreground/80">Loading audio from library…</span>
                      <span className="ml-auto text-[10px] text-muted-foreground font-bold uppercase tracking-widest">Please wait</span>
                    </div>
                  )}
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                    {dashboardFiles.map(file => {
                      const isThisLoading = loadingFileId === file.id;
                      return (
                        <div key={file.id}
                             className={cn(
                               "relative flex flex-col p-3 rounded-2xl border transition-all group overflow-hidden",
                               isThisLoading
                                 ? "bg-primary/10 border-primary/40 cursor-wait scale-[0.98]"
                                 : loadingFileId
                                   ? "bg-secondary/20 border-secondary/50 opacity-50 cursor-not-allowed"
                                   : "bg-secondary/20 border-secondary/50 hover:bg-secondary/40 cursor-pointer"
                             )}
                             onClick={() => !loadingFileId && loadDashboardFile(file.id, file.filename)}>
                          {/* Spinner overlay for the card being loaded */}
                          {isThisLoading && (
                            <div className="absolute inset-0 flex flex-col items-center justify-center bg-background/60 backdrop-blur-sm rounded-2xl z-10 gap-2">
                              <Loader2 className="w-6 h-6 animate-spin text-primary" />
                              <span className="text-[10px] font-bold uppercase tracking-widest text-primary">Loading…</span>
                            </div>
                          )}
                          <div className="flex justify-between items-start mb-2">
                            <div className={cn(
                              "w-8 h-8 rounded-full flex items-center justify-center shrink-0 transition-colors",
                              isThisLoading ? "bg-primary/20 text-primary" : "bg-primary/10 text-primary"
                            )}>
                              <FileAudio className="w-4 h-4" />
                            </div>
                            <div className="flex gap-1 items-center">
                              <span title="Original SRT" className="w-5 h-5 rounded-md bg-secondary flex items-center justify-center text-muted-foreground"><History className="w-3 h-3" /></span>
                              {file.has_modified_srt && (
                                <span title="Modified SRT" className="w-5 h-5 rounded-md bg-emerald-500/10 text-emerald-500 flex items-center justify-center"><CheckCircle2 className="w-3 h-3" /></span>
                              )}
                              <Button
                                variant="ghost"
                                size="icon"
                                className="w-6 h-6 rounded-md hover:bg-destructive/10 hover:text-destructive transition-colors ml-1"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setDeleteConfirmDialog({ show: true, file_id: file.id, title: file.title || file.filename });
                                }}
                                disabled={!!loadingFileId}
                              >
                                <Trash2 className="w-3 h-3" />
                              </Button>
                            </div>
                          </div>
                          <h4 className="font-bold text-sm line-clamp-2 leading-tight mb-1 group-hover:text-primary transition-colors">{file.title || file.filename}</h4>
                          <div className="mt-auto flex items-center gap-1 text-[10px] text-muted-foreground mt-2 font-medium">
                            <Clock className="w-3 h-3" />
                            <span>{new Date(file.date).toLocaleDateString()}</span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  </>
                ) : (
                  <div className="flex flex-col items-center justify-center p-12 border-2 border-dashed border-secondary/30 rounded-[2rem] bg-secondary/5 transition-all hover:bg-secondary/10 group">
                    <div className="w-12 h-12 rounded-full bg-secondary/20 flex items-center justify-center mb-3 group-hover:scale-110 transition-transform">
                      <Library className="w-6 h-6 text-muted-foreground/30" />
                    </div>
                    <p className="text-sm text-muted-foreground/60 font-bold tracking-tight">Your library is empty</p>
                    <p className="text-[10px] text-muted-foreground/40 mt-1 uppercase font-bold tracking-widest">Upload files to get started</p>
                  </div>
                )}
              </div>
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
              currentFileId={currentFileId}
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

      {/* Existing File Prompt Dialog */}
      <Dialog open={existingFilePrompt !== null} onOpenChange={(open) => {
        if (!open) setExistingFilePrompt(null);
      }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><History className="w-5 h-5 text-primary" /> Already in Library</DialogTitle>
            <DialogDescription>
              We found existing transcriptions for <strong>{existingFilePrompt?.filename}</strong> in your library.
              What would you like to do?
            </DialogDescription>
          </DialogHeader>
          
          <div className="flex flex-col gap-3 py-4">
            <div className="flex p-3 rounded-lg border bg-secondary/20 items-center justify-between">
              <span className="text-sm font-medium">Original Transcription</span>
              <CheckCircle2 className="w-4 h-4 text-emerald-500" />
            </div>
            {existingFilePrompt?.modified_srt && (
              <div className="flex p-3 rounded-lg border bg-secondary/20 items-center justify-between">
                <span className="text-sm font-medium">Volume-Adjusted (Modified)</span>
                <CheckCircle2 className="w-4 h-4 text-emerald-500" />
              </div>
            )}
          </div>

          <DialogFooter className="flex-col sm:flex-row gap-2 sm:justify-between">
            <Button variant="outline" onClick={() => handleTranscribeUpload(true)} className="flex-1">
              Re-transcribe
            </Button>
            <Button onClick={handleAcceptExistingFiles} className="flex-1">
              Load Existing
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      
      {/* Delete Confirmation Dialog */}
      <Dialog open={deleteConfirmDialog !== null} onOpenChange={(open) => {
        if (!open) setDeleteConfirmDialog(null);
      }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive"><Trash2 className="w-5 h-5" /> Delete from Library?</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete <strong>{deleteConfirmDialog?.title}</strong>? 
              This will permanently remove the audio and all transcription data.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex-col sm:flex-row gap-2 mt-4">
            <Button variant="outline" onClick={() => setDeleteConfirmDialog(null)} className="flex-1">
              Cancel
            </Button>
            <Button 
              variant="destructive" 
              onClick={() => deleteConfirmDialog && deleteDashboardFile(deleteConfirmDialog.file_id)} 
              className="flex-1"
            >
              Delete Permanently
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  );
}
