"use client";

import { useState, useRef, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Rewind, FastForward, Play, Pause, Star, StarOff, Check, X, Download, FileText, FileCode, GitCompare, ChevronDown, ChevronUp, Undo2, Scissors, Merge, Trash2, Loader2, Music, Eye, EyeOff, Pencil } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useToast } from '@/hooks/use-toast';
import { VolumeDisplay } from '@/components/ui/volume-display';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import type { Subtitle } from '@/app/page';

interface PlayerViewProps {
  audioRef: React.RefObject<HTMLAudioElement>;
  audioFile: File;
  srtFile: File | null;
  subtitles: Subtitle[];
  setSubtitles: React.Dispatch<React.SetStateAction<Subtitle[]>>;
  currentSentenceIndex: number;
  setCurrentSentenceIndex: React.Dispatch<React.SetStateAction<number>>;
  isPlaying: boolean;
  sentenceProgress: number;
  playSentence: (index: number) => void;
  srtContent: string;
  setSrtContent: (content: string) => void;
  srtContentAdjusted?: string;         // volume-refined SRT (optional)
  setSrtContentAdjusted?: (s: string) => void;
  activeSrtMode?: 'original' | 'adjusted'; // which SRT is driving playback
  onSrtModeChange?: (mode: 'original' | 'adjusted') => void;
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
  srtContentAdjusted,
  setSrtContentAdjusted,
  activeSrtMode = 'original',
  onSrtModeChange,
}: PlayerViewProps) {
  const [showOnlyStarred, setShowOnlyStarred] = useState(false);
  const [editingSubtitleId, setEditingSubtitleId] = useState<number | null>(null);
  const [editingText, setEditingText] = useState('');
  const [isTimingEditing, setIsTimingEditing] = useState(false);
  const [showCompare, setShowCompare] = useState(false);
  const [showWaveform, setShowWaveform] = useState(false);
  const [undoStack, setUndoStack] = useState<Subtitle[][]>([]);

  // Load saved preference
  useEffect(() => {
    const saved = localStorage.getItem('lingua_show_waveform');
    if (saved !== null) {
      setShowWaveform(saved === 'true');
    }
  }, []);

  // Save preference whenever it changes
  useEffect(() => {
    localStorage.setItem('lingua_show_waveform', String(showWaveform));
  }, [showWaveform]);

  // ── Jump-to-subtitle input state ──────────────────────────────────────
  const [isJumpInputVisible, setIsJumpInputVisible] = useState(false);
  const [jumpInputValue, setJumpInputValue] = useState('');
  const jumpInputRef = useRef<HTMLInputElement>(null);

  // ── Export starred MP3s dialog state ───────────────────────────────────
  const [showExportDialog, setShowExportDialog] = useState(false);
  const [exportPrefix, setExportPrefix] = useState('');
  const [isExporting, setIsExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState({ current: 0, total: 0 });

  const sentenceScrollRef = useRef<(HTMLDivElement | null)[]>([]);
  const lastUnfilteredIndexRef = useRef(0);
  const { toast } = useToast();

  const hasStarredSentences = subtitles.some(sub => sub.isStarred);
  const visibleSubtitles = showOnlyStarred && hasStarredSentences ? subtitles.filter(sub => sub.isStarred) : subtitles;

  const secondsToSrtTime = (seconds: number): string => {
    const date = new Date(Math.round(seconds * 1000));
    const time = date.toISOString().substring(11, 23);
    return time.replace('.', ',');
  };

  const generateSrtContent = (subs: Subtitle[]) => {
    let content = '';
    subs.forEach((sub, index) => {
      content += `${sub.id}\n`;
      content += `${secondsToSrtTime(sub.startTime)} --> ${secondsToSrtTime(sub.endTime)}\n`;
      content += `${sub.text}\n\n`;
    });
    return content;
  }

  const updateSrtContent = (updatedSubtitles: Subtitle[]) => {
    const newContent = generateSrtContent(updatedSubtitles);
    // Route to the currently active SRT string
    if (activeSrtMode === 'adjusted' && setSrtContentAdjusted) {
      setSrtContentAdjusted(newContent);
    } else {
      setSrtContent(newContent);
    }
  };

  // ─── Undo helpers ──────────────────────────────────────────────────────────
  const MAX_UNDO = 20;

  /** Push current subtitles onto the undo stack before a destructive op. */
  const pushUndo = (prev: Subtitle[]) => {
    setUndoStack(stack => [...stack.slice(-MAX_UNDO + 1), prev]);
  };

  /** Apply new subtitles, renumber IDs, sync SRT content. */
  const applySubtitles = (newSubsOrFn: Subtitle[] | ((prev: Subtitle[]) => Subtitle[]), nextIndex?: number) => {
    setSubtitles(prev => {
      const nextSubs = typeof newSubsOrFn === 'function' ? newSubsOrFn(prev) : newSubsOrFn;
      // Re-number IDs sequentially so SRT stays valid
      const renumbered = nextSubs.map((s, i) => ({ ...s, id: i + 1 }));
      updateSrtContent(renumbered);
      return renumbered;
    });

    if (nextIndex !== undefined) {
      setCurrentSentenceIndex(prev => {
        // We'll need the length, but since setSubtitles is async, 
        // we'll just clamp to a reasonably safe upper bound or use another effect
        return nextIndex;
      });
    }
  };

  // ─── Remove current subtitle ───────────────────────────────────────────────
  const handleRemove = () => {
    if (subtitles.length === 0) return;
    const idx = currentSentenceIndex;
    const subId = subtitles[idx]?.id;
    if (subId === undefined) return;

    pushUndo(subtitles);
    applySubtitles(prev => prev.filter(s => s.id !== subId), Math.max(0, idx - 1));
    toast({ title: 'Subtitle Removed', description: `Subtitle deleted.` });
  };

  // ─── Merge current subtitle with the next one ──────────────────────────────
  const handleMerge = () => {
    const idx = currentSentenceIndex;
    if (idx < 0 || idx >= subtitles.length - 1) return;

    const curId = subtitles[idx].id;
    const nextId = subtitles[idx + 1].id;

    pushUndo(subtitles);
    applySubtitles(prev => {
      const curIdx = prev.findIndex(s => s.id === curId);
      const nextIdx = prev.findIndex(s => s.id === nextId);
      if (curIdx === -1 || nextIdx === -1) return prev;

      const curRow = prev[curIdx];
      const nextRow = prev[nextIdx];

      const merged: Subtitle = {
        ...curRow,
        endTime: nextRow.endTime,
        text: `${curRow.text} ${nextRow.text}`.trim(),
        isStarred: curRow.isStarred || nextRow.isStarred,
      };

      const result = [...prev];
      result.splice(curIdx, 2, merged);
      return result;
    }, idx);
    toast({ title: 'Subtitles Merged', description: `Subtitles merged.` });
  };

  // ─── Split current subtitle at midpoint ────────────────────────────────────
  const handleSplit = () => {
    const idx = currentSentenceIndex;
    const subToSplit = subtitles[idx];
    if (!subToSplit) return;
    const targetId = subToSplit.id;

    pushUndo(subtitles);
    applySubtitles(prev => {
      const sIdx = prev.findIndex(s => s.id === targetId);
      if (sIdx === -1) return prev;

      const sub = prev[sIdx];
      const midTime = (sub.startTime + sub.endTime) / 2;
      const words = sub.text.trim().split(/\s+/);
      const midWord = Math.max(1, Math.floor(words.length / 2));
      const textA = words.slice(0, midWord).join(' ');
      const textB = words.slice(midWord).join(' ') || textA;

      const partA: Subtitle = { ...sub, endTime: midTime, text: textA };
      const partB: Subtitle = { ...sub, id: sub.id + 0.5, startTime: midTime, text: textB, isStarred: false };

      const result = [...prev];
      result.splice(sIdx, 1, partA, partB);
      return result;
    }, idx);
    toast({ title: 'Subtitle Split', description: `Subtitle split in two.` });
  };

  // ─── Undo last operation ───────────────────────────────────────────────────
  const handleUndo = () => {
    if (undoStack.length === 0) return;
    const prev = undoStack[undoStack.length - 1];
    setUndoStack(stack => stack.slice(0, -1));
    setSubtitles(prev);
    updateSrtContent(prev);
    // Restore index within bounds
    setCurrentSentenceIndex(idx => Math.min(idx, prev.length - 1));
    toast({ title: 'Undone', description: 'Last subtitle change reverted.' });
  };

  const handleTimingSave = (newStartTime: number, newEndTime: number) => {
    // Determine which ID we are editing based on current total list
    const subToEdit = subtitles[currentSentenceIndex];
    if (!subToEdit) return;
    const targetId = subToEdit.id;

    // Round to nearest 1ms
    const roundedStart = Math.round(newStartTime * 1000) / 1000;
    const roundedEnd = Math.round(newEndTime * 1000) / 1000;

    pushUndo(subtitles);
    setSubtitles(prev => {
      const updated = prev.map(sub =>
        sub.id === targetId ? { ...sub, startTime: roundedStart, endTime: roundedEnd } : sub
      );
      // Update the SRT string source as well
      updateSrtContent(updated);
      return updated;
    });

    setIsTimingEditing(false);
    toast({
      title: "Timestamps Saved",
      description: `Saved to ${activeSrtMode === 'adjusted' ? 'Volume-Adjusted' : 'Original'} SRT.`,
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
      if (audio.currentTime >= currentSubInFullList.endTime - 0.1 || audio.currentTime < currentSubInFullList.startTime) {
        playSentence(currentSentenceIndex);
      } else {
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
      if (newOriginalIndex !== -1) {
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
      if (newOriginalIndex !== -1) {
        playSentence(newOriginalIndex);
      }
    } else if (isPlaying) {
      const audio = audioRef.current;
      if (audio) audio.pause();
    }
  };

  const handleSentenceClick = (index: number) => {
    const sub = visibleSubtitles[index];
    if (sub) {
      const originalIndex = subtitles.findIndex(s => s.id === sub.id);
      if (originalIndex !== -1) {
        setCurrentSentenceIndex(originalIndex); // select only, no play
      }
    }
  };

  const handleSentenceDoubleClick = (sub: Subtitle) => {
    // Double click plays the sentence
    const originalIndex = subtitles.findIndex(s => s.id === sub.id);
    if (originalIndex !== -1) playSentence(originalIndex);
  };

  const handleSaveEdit = (id: number) => {
    setSubtitles(prev => {
      const updated = prev.map(sub =>
        sub.id === id ? { ...sub, text: editingText } : sub
      );
      updateSrtContent(updated);
      return updated;
    });
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
    let newSubtitles: Subtitle[] = [];
    let starredIndex = -1;

    setSubtitles(prevSubtitles => {
      newSubtitles = prevSubtitles.map(sub =>
        sub.id === id ? { ...sub, isStarred: !sub.isStarred } : sub
      );

      starredIndex = newSubtitles.findIndex(sub => sub.id === id);
      if (starredIndex !== -1) {
        setCurrentSentenceIndex(starredIndex);
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
      const starredSubtitles = subtitles.filter(sub => sub.isStarred);
      if (starredSubtitles.length > 0) {
        let closestIndex = 0;
        let minDistance = Infinity;

        for (let i = 0; i < starredSubtitles.length; i++) {
          const originalIndexOfStarred = subtitles.findIndex(s => s.id === starredSubtitles[i].id);
          const distance = Math.abs(originalIndexOfStarred - currentSentenceIndex);
          if (distance < minDistance) {
            minDistance = distance;
            closestIndex = originalIndexOfStarred;
          }
        }
        setCurrentSentenceIndex(closestIndex);
      }
    } else {
      setCurrentSentenceIndex(lastUnfilteredIndexRef.current);
    }
    setShowOnlyStarred(checked);
  };

  const handleStarAll = () => {
    setSubtitles(prev => prev.map(sub => ({ ...sub, isStarred: true })));
  };

  const handleUnstarAll = () => {
    setSubtitles(prev => prev.map(sub => ({ ...sub, isStarred: false })));
    // Reset filter if it was active
    if (showOnlyStarred) {
      setShowOnlyStarred(false);
      setCurrentSentenceIndex(lastUnfilteredIndexRef.current);
    }
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
    const baseName = srtFile
      ? srtFile.name.replace(/\.srt$/i, '')
      : audioFile.name.replace(/\.[^.]+$/, '');

    if (activeSrtMode === 'original') {
      // Original mode: live subtitles ARE the original
      const subsToDownload = showOnlyStarred ? visibleSubtitles : subtitles;
      downloadFile(generateSrtContent(subsToDownload), `${baseName}_original.srt`, 'text/plain');
    } else {
      // Adjusted mode: original is the stored string (not the active subtitles)
      downloadFile(srtContent, `${baseName}_original.srt`, 'text/plain');
    }
  };

  const handleDownloadSrtAdjusted = () => {
    const baseName = srtFile
      ? srtFile.name.replace(/\.srt$/i, '')
      : audioFile.name.replace(/\.[^.]+$/, '');

    if (activeSrtMode === 'adjusted') {
      // Adjusted mode: live subtitles ARE the adjusted version
      const subsToDownload = showOnlyStarred ? visibleSubtitles : subtitles;
      downloadFile(generateSrtContent(subsToDownload), `${baseName}_volume_adjusted.srt`, 'text/plain');
    } else {
      // Original mode: adjusted is the stored string
      downloadFile(srtContentAdjusted ?? '', `${baseName}_volume_adjusted.srt`, 'text/plain');
    }
  };
  const handleDownloadTxt = () => {
    const baseName = srtFile
      ? srtFile.name.replace(/\.srt$/i, '')
      : audioFile.name.replace(/\.[^.]+$/, '');

    const subsToDownload = showOnlyStarred ? visibleSubtitles : subtitles;
    const textContent = subsToDownload.map(sub => sub.text).join('\n');
    downloadFile(textContent, `${baseName}.txt`, 'text/plain');
  };

  const handleDownloadMp3 = () => {
    const url = URL.createObjectURL(audioFile);
    const a = document.createElement('a');
    a.href = url;
    // Use the original file name but ensure a .mp3 extension
    const baseName = audioFile.name.replace(/\.[^.]+$/, '');
    a.download = baseName.endsWith('.mp3') ? audioFile.name : `${baseName}.mp3`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleExportMd = () => {
    toast({
      title: "Coming Soon!",
      description: "Markdown export functionality is not yet implemented.",
    });
  };

  // ── Export starred sentences as individual MP3s ──────────────────────────
  const BACKEND_URL = "http://localhost:5000";

  /**
   * Parse a filename prefix like "FRE0004" into { alpha: "FRE", startNum: 4, padding: 4 }
   * Also supports pure numeric like "0004" → { alpha: "", startNum: 4, padding: 4 }
   * Or plain text like "sentence" → { alpha: "sentence", startNum: 1, padding: 0 }
   */
  const parsePrefix = (input: string): { alpha: string; startNum: number; padding: number } => {
    const match = input.match(/^(.*?)(\d+)$/);
    if (match) {
      const alpha = match[1];
      const numStr = match[2];
      return { alpha, startNum: parseInt(numStr, 10), padding: numStr.length };
    }
    // No trailing number — default to sequential from 1 with no padding
    return { alpha: input || 'sentence_', startNum: 1, padding: 0 };
  };

  const generateFileName = (alpha: string, num: number, padding: number): string => {
    if (padding > 0) {
      return `${alpha}${String(num).padStart(padding, '0')}.mp3`;
    }
    return `${alpha}${num}.mp3`;
  };

  const handleExportStarredMp3s = async () => {
    const starred = subtitles.filter(sub => sub.isStarred);
    if (starred.length === 0) {
      toast({ variant: 'destructive', title: 'No Starred Sentences', description: 'Star some sentences first.' });
      return;
    }

    const { alpha, startNum, padding } = parsePrefix(exportPrefix.trim());
    setIsExporting(true);
    setExportProgress({ current: 0, total: starred.length });

    let successCount = 0;

    for (let i = 0; i < starred.length; i++) {
      const sub = starred[i];
      const fileName = generateFileName(alpha, startNum + i, padding);
      setExportProgress({ current: i + 1, total: starred.length });

      try {
        const formData = new FormData();
        formData.append('file', audioFile);
        formData.append('start_ms', String(Math.round(sub.startTime * 1000)));
        formData.append('end_ms', String(Math.round(sub.endTime * 1000)));
        formData.append('filename', fileName);

        const res = await fetch(`${BACKEND_URL}/api/export-sentence-mp3`, {
          method: 'POST',
          body: formData,
        });

        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: 'Unknown error' }));
          console.error(`Failed to export ${fileName}:`, err);
          continue;
        }

        // Download the returned MP3
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        successCount++;

        // Small delay between downloads to avoid browser throttling
        if (i < starred.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 300));
        }
      } catch (err) {
        console.error(`Failed to export ${fileName}:`, err);
      }
    }

    setIsExporting(false);
    setShowExportDialog(false);
    toast({
      title: 'Export Complete!',
      description: `${successCount} of ${starred.length} MP3 files exported.`,
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
            if (originalIndex !== -1) setCurrentSentenceIndex(originalIndex);
          }
          break;
        case 'ArrowDown':
          if (currentVisibleIndex < visibleSubtitles.length - 1) {
            const nextSub = visibleSubtitles[currentVisibleIndex + 1];
            const originalIndex = subtitles.findIndex(s => s.id === nextSub.id);
            if (originalIndex !== -1) setCurrentSentenceIndex(originalIndex);
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
  }, [currentSentenceIndex, subtitles, showOnlyStarred, visibleSubtitles, editingSubtitleId, isTimingEditing, isPlaying]);

  // ─── Helpers to parse the adjusted SRT for the comparison view ──────────────
  const parseSrtToRows = (srt: string): { id: number; start: string; end: string; text: string }[] => {
    if (!srt) return [];
    return srt.trim().split(/\n\n+/).filter(Boolean).map((block, i) => {
      const lines = block.trim().split('\n');
      const timeMatch = lines.find(l => l.includes('-->'))?.match(/(\S+)\s-->\s(\S+)/);
      const text = lines.slice(lines.findIndex(l => l.includes('-->')) + 1).join(' ').trim();
      return {
        id: i + 1,
        start: timeMatch?.[1] ?? '',
        end: timeMatch?.[2] ?? '',
        text,
      };
    });
  };

  const srtRowsOrig = parseSrtToRows(srtContent);
  const srtRowsAdj = parseSrtToRows(srtContentAdjusted ?? '');

  // Compute end-time delta in ms for each subtitle (positive = adjusted is earlier)
  const deltas: number[] = srtRowsOrig.map((row, i) => {
    const adj = srtRowsAdj[i];
    if (!adj) return 0;
    const toMs = (ts: string) => {
      const [hms, ms] = ts.split(',');
      const [h, m, s] = hms.split(':').map(Number);
      return ((h * 3600 + m * 60 + s) * 1000) + Number(ms);
    };
    return toMs(row.end) - toMs(adj.end); // positive: adjusted is shorter (earlier end)
  });

  const [showActions, setShowActions] = useState(false);
  const [showControls, setShowControls] = useState(false);

  return (
    <div className="flex flex-col flex-1 min-h-0 animate-in fade-in duration-500">
      {/* ═══════════════════════════════════════════════════════════════════════
         PINNED TOP SECTION — always visible: waveform, controls, edit toolbar
         ═══════════════════════════════════════════════════════════════════════ */}
      <div className="flex-shrink-0 flex flex-col gap-2 pb-2 border-b">
        <VolumeDisplay
          subtitles={subtitles}
          currentSentenceIndex={currentSentenceIndex}
          audioElement={audioRef.current}
          audioFile={audioFile}
          showWaveform={showWaveform}
          isTimingEditing={isTimingEditing}
          setIsTimingEditing={setIsTimingEditing}
          onSave={handleTimingSave}
          onPlaySentence={playSentence}
          onNavigateToSentence={setCurrentSentenceIndex}
        />

        {/* ── Playback buttons (hideable) ─────────────────────────────────── */}
        {showControls && !isTimingEditing && (
          <div className="flex items-center justify-center gap-2 px-1">
            <Button onClick={handlePrevious} variant="ghost" size="icon" className="h-8 w-8" disabled={!visibleSubtitles.length || visibleSubtitles.findIndex(s => s.id === subtitles[currentSentenceIndex]?.id) <= 0}>
              <Rewind className="h-4 w-4" />
              <span className="sr-only">Previous sentence</span>
            </Button>
            <Button onClick={togglePlayPause} variant="default" size="icon" className="h-10 w-10 rounded-full shadow hover:scale-105 transition-transform flex-shrink-0" disabled={currentSentenceIndex === -1}>
              {isPlaying ? <Pause className="h-5 w-5" /> : <Play className="h-5 w-5" />}
              <span className="sr-only">{isPlaying ? 'Pause' : 'Play'}</span>
            </Button>
            <Button onClick={handleNext} variant="ghost" size="icon" className="h-8 w-8" disabled={!visibleSubtitles.length || visibleSubtitles.findIndex(s => s.id === subtitles[currentSentenceIndex]?.id) >= visibleSubtitles.length - 1}>
              <FastForward className="h-4 w-4" />
              <span className="sr-only">Next sentence</span>
            </Button>
          </div>
        )}

        {/* ── Status bar (always visible): progress + counter + hide/show toggle ── */}
        {!isTimingEditing && (
          <>
            <div className="flex items-center gap-2 px-1">
              <Progress value={sentenceProgress} className="flex-1 h-1.5 [&>div]:bg-accent" />
              {isJumpInputVisible ? (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    const num = parseInt(jumpInputValue, 10);
                    if (!isNaN(num) && num >= 1 && num <= subtitles.length) {
                      const targetIndex = num - 1;
                      playSentence(targetIndex);
                    }
                    setIsJumpInputVisible(false);
                    setJumpInputValue('');
                  }}
                  className="flex-shrink-0"
                >
                  <input
                    ref={jumpInputRef}
                    type="number"
                    min={1}
                    max={subtitles.length}
                    value={jumpInputValue}
                    onChange={(e) => setJumpInputValue(e.target.value)}
                    onBlur={() => {
                      const num = parseInt(jumpInputValue, 10);
                      if (!isNaN(num) && num >= 1 && num <= subtitles.length) {
                        playSentence(num - 1);
                      }
                      setIsJumpInputVisible(false);
                      setJumpInputValue('');
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') {
                        setIsJumpInputVisible(false);
                        setJumpInputValue('');
                      }
                    }}
                    className="w-14 h-6 text-[11px] font-mono text-center rounded-full border-2 border-red-400 bg-background outline-none focus:ring-2 focus:ring-red-300 tabular-nums [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                    placeholder={String(currentSentenceIndex >= 0 ? currentSentenceIndex + 1 : 1)}
                    autoFocus
                  />
                </form>
              ) : (
                <span
                  className="text-[11px] font-mono whitespace-nowrap tabular-nums cursor-pointer select-none rounded-full border-2 border-red-400 text-red-500 px-1.5 py-0.5 hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors"
                  title="Double-click to jump to a subtitle number"
                  onDoubleClick={() => {
                    setJumpInputValue(String(currentSentenceIndex >= 0 ? currentSentenceIndex + 1 : ''));
                    setIsJumpInputVisible(true);
                  }}
                >
                  {currentSentenceIndex >= 0 ? currentSentenceIndex + 1 : '—'}/{subtitles.length}
                </span>
              )}
              <button
                onClick={() => setShowControls(v => !v)}
                className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors py-0.5 px-1 rounded hover:bg-accent/10 flex-shrink-0"
                title={showControls ? 'Hide playback controls' : 'Show playback controls'}
              >
                {showControls ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
              </button>
            </div>

            {/* ── Edit Operations Toolbar (compact) ───────────────────────── */}
            <div className="flex flex-wrap items-center justify-between gap-1 px-1">
              <div className="flex items-center gap-0.5">
                <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide mr-1">Edit</span>
                <Button
                  id="subtitle-remove-btn"
                  onClick={handleRemove}
                  variant="ghost"
                  size="sm"
                  disabled={subtitles.length === 0 || currentSentenceIndex < 0}
                  title="Remove current subtitle"
                  className="h-7 px-2 gap-1 text-xs text-red-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30"
                >
                  <Trash2 className="w-3 h-3" />
                  Remove
                </Button>
                <Button
                  id="subtitle-merge-btn"
                  onClick={handleMerge}
                  variant="ghost"
                  size="sm"
                  disabled={currentSentenceIndex < 0 || currentSentenceIndex >= subtitles.length - 1}
                  title="Merge with next"
                  className="h-7 px-2 gap-1 text-xs text-blue-500 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-950/30"
                >
                  <Merge className="w-3 h-3" />
                  Merge
                </Button>
                <Button
                  id="subtitle-split-btn"
                  onClick={handleSplit}
                  variant="ghost"
                  size="sm"
                  disabled={currentSentenceIndex < 0}
                  title="Split into two"
                  className="h-7 px-2 gap-1 text-xs text-violet-500 hover:text-violet-600 hover:bg-violet-50 dark:hover:bg-violet-950/30"
                >
                  <Scissors className="w-3 h-3" />
                  Split
                </Button>
              </div>
              <div className="flex items-center gap-1">
                <Button
                  id="subtitle-undo-btn"
                  onClick={handleUndo}
                  variant="ghost"
                  size="sm"
                  disabled={undoStack.length === 0}
                  title={`Undo (${undoStack.length})`}
                  className="h-7 px-2 gap-1 text-xs text-muted-foreground hover:text-foreground"
                >
                  <Undo2 className="w-3 h-3" />
                  Undo{undoStack.length > 0 && <span className="text-[9px] font-mono opacity-60">({undoStack.length})</span>}
                </Button>
                <div className="w-px h-4 bg-border mx-0.5" />
                <Button
                  onClick={() => setShowActions(v => !v)}
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 gap-1 text-xs text-muted-foreground hover:text-foreground"
                  title="Downloads & more"
                >
                  {showActions ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                  More
                </Button>
              </div>
            </div>
          </>
        )}
      </div>

      {/* ═══════════════════════════════════════════════════════════════════════
         SUBTITLE LIST — fills remaining vertical space
         ═══════════════════════════════════════════════════════════════════════ */}
      {!isTimingEditing && (
        <ScrollArea className="flex-1 min-h-0 w-full rounded-md px-2 py-1">
          <div className="flex flex-col gap-1">
            {visibleSubtitles.map((sub, index) => {
              const originalIndex = subtitles.findIndex(s => s.id === sub.id);
              const isEditing = editingSubtitleId === sub.id;

              return (
                <div
                  key={sub.id}
                  ref={el => { sentenceScrollRef.current[index] = el; }}
                  onClick={() => !isEditing && setCurrentSentenceIndex(originalIndex)}
                  onDoubleClick={() => !isEditing && playSentence(originalIndex)}
                  className={cn(
                    "cursor-pointer rounded-md px-2 py-1.5 transition-colors flex items-start gap-2",
                    !isEditing && (originalIndex === currentSentenceIndex
                      ? 'bg-accent/20'
                      : 'hover:bg-accent/10')
                  )}
                >
                  <button onClick={(e) => handleStarClick(e, sub.id)} className="p-0.5 -ml-0.5 text-muted-foreground hover:text-amber-500 transition-colors flex-shrink-0 mt-0.5">
                    <Star className={cn("w-3.5 h-3.5", sub.isStarred ? 'text-amber-400 fill-amber-400' : 'text-muted-foreground')} />
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
                    <div className="flex-1 flex items-start gap-2 group/sub">
                      <p
                        className={cn(
                          "flex-1 text-sm leading-snug",
                          originalIndex === currentSentenceIndex
                            ? 'font-bold text-foreground'
                            : 'text-muted-foreground'
                        )}
                      >
                        <span className={cn("mr-1.5 text-xs", originalIndex === currentSentenceIndex ? 'text-primary' : 'opacity-50')}>{originalIndex + 1}.</span>
                        <span>{sub.text}</span>
                      </p>
                      <div className="flex items-center opacity-0 group-hover/sub:opacity-100 transition-opacity">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setEditingSubtitleId(sub.id);
                            setEditingText(sub.text);
                          }}
                          className="p-1.5 text-muted-foreground hover:text-blue-500 rounded hover:bg-black/5 dark:hover:bg-white/10"
                          title="Edit text"
                        >
                          <Pencil className="w-3.5 h-3.5" />
                          <span className="sr-only">Edit text</span>
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </ScrollArea>
      )}

      {/* ═══════════════════════════════════════════════════════════════════════
         COLLAPSIBLE ACTIONS PANEL — downloads, star controls, compare
         ═══════════════════════════════════════════════════════════════════════ */}
      {!isTimingEditing && showActions && (
        <div className="flex-shrink-0 border-t pt-2 flex flex-col gap-2 animate-in slide-in-from-bottom-2 fade-in duration-200">
          {/* Star controls */}
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Button onClick={handleStarAll} variant="ghost" size="sm" className="h-7 text-xs text-amber-500 hover:text-amber-600 hover:bg-amber-50 dark:hover:bg-amber-950/30" id="star-all-btn" title="Star all">
              <Star className="w-3.5 h-3.5 mr-1 fill-amber-400 text-amber-400" />
              Star All
            </Button>
            <Button onClick={handleUnstarAll} variant="ghost" size="sm" className="h-7 text-xs text-muted-foreground hover:text-foreground" id="unstar-all-btn" title="Unstar all">
              <StarOff className="w-3.5 h-3.5 mr-1" />
              Unstar All
            </Button>
            {hasStarredSentences && (
              <>
                <div className="flex items-center space-x-1.5">
                  <Switch id="show-starred" checked={showOnlyStarred} onCheckedChange={handleShowStarredToggle} />
                  <Label htmlFor="show-starred" className="text-xs">Starred Only</Label>
                </div>
                <Button onClick={() => setShowExportDialog(true)} variant="ghost" size="sm" className="h-7 text-xs text-emerald-500 hover:text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-950/30" id="export-starred-mp3s-btn" title="Export starred MP3s">
                  <Music className="w-3.5 h-3.5 mr-1" />
                  Export .mp3s
                </Button>
              </>
            )}

            <div className="flex items-center space-x-1.5 ml-2 border-l pl-3 bg-muted/30 rounded-r-md">
              <Switch
                id="vol-adjusted"
                checked={activeSrtMode === 'adjusted'}
                onCheckedChange={(checked) => onSrtModeChange?.(checked ? 'adjusted' : 'original')}
                disabled={!srtContentAdjusted}
              />
              <Label htmlFor="vol-adjusted" className="text-xs">Adjust Timestamps</Label>
            </div>

            <div className="flex items-center space-x-1.5 ml-2">
              <Switch id="show-waveform" checked={showWaveform} onCheckedChange={setShowWaveform} />
              <Label htmlFor="show-waveform" className="text-xs">Show Waveform</Label>
            </div>
          </div>

          {/* Download buttons */}
          <div className="flex flex-wrap justify-center gap-1.5">
            <Button onClick={handleDownloadMp3} variant="outline" size="sm" className="h-7 text-xs" id="download-mp3-player-btn">
              <Download className="mr-1 h-3.5 w-3.5" />
              .mp3
            </Button>
            <Button onClick={handleDownloadSrt} variant="outline" size="sm" className="h-7 text-xs" id="download-srt-original-btn">
              <Download className="mr-1 h-3.5 w-3.5" />
              Original .srt
            </Button>
            {srtContentAdjusted && (
              <Button onClick={handleDownloadSrtAdjusted} variant="outline" size="sm" className="h-7 text-xs border-emerald-500 text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-950/30" id="download-srt-adjusted-btn">
                <Download className="mr-1 h-3.5 w-3.5" />
                Adjusted .srt
              </Button>
            )}
            <Button onClick={handleDownloadTxt} variant="outline" size="sm" className="h-7 text-xs">
              <FileText className="mr-1 h-3.5 w-3.5" />
              .txt
            </Button>
            <Button onClick={handleExportMd} variant="outline" size="sm" className="h-7 text-xs">
              <FileCode className="mr-1 h-3.5 w-3.5" />
              .md
            </Button>
          </div>

          {/* ── Compare & Verify Panel ──────────────────────────────── */}
          {srtContentAdjusted && srtRowsOrig.length > 0 && (
            <div className="border rounded-lg overflow-hidden">
              <button
                id="compare-timestamps-toggle"
                onClick={() => setShowCompare(v => !v)}
                className="w-full flex items-center justify-between px-3 py-2 bg-muted/40 hover:bg-muted/60 transition-colors text-xs font-medium"
              >
                <span className="flex items-center gap-2">
                  <GitCompare className="w-3.5 h-3.5 text-emerald-500" />
                  Compare Timestamps
                  <span className="text-[10px] text-muted-foreground font-normal">
                    ({deltas.filter(d => Math.abs(d) > 20).length} adjusted)
                  </span>
                </span>
                {showCompare ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
              </button>

              {showCompare && (
                <div className="overflow-hidden">
                  <div className="grid grid-cols-[2rem_1fr_1fr] gap-px bg-border text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    <div className="bg-background px-2 py-1">#</div>
                    <div className="bg-background px-3 py-1">Original End</div>
                    <div className="bg-background px-3 py-1 text-emerald-600">Adjusted End</div>
                  </div>

                  <ScrollArea className="h-48">
                    <div className="divide-y divide-border">
                      {srtRowsOrig.map((row, i) => {
                        const adj = srtRowsAdj[i];
                        const delta = deltas[i] ?? 0;
                        const changed = Math.abs(delta) > 20;
                        return (
                          <div
                            key={row.id}
                            className={cn(
                              "grid grid-cols-[2rem_1fr_1fr] gap-px text-[11px] font-mono",
                              changed ? 'bg-emerald-50 dark:bg-emerald-950/20' : ''
                            )}
                          >
                            <div className="px-2 py-1.5 text-muted-foreground self-start">{row.id}</div>
                            <div className="px-3 py-1.5">
                              <span className="block text-foreground">{row.end}</span>
                              <span className="block text-muted-foreground/70 truncate mt-0.5 font-sans text-[10px]">{row.text}</span>
                            </div>
                            <div className="px-3 py-1.5">
                              <span className={cn("block", changed ? 'text-emerald-600 font-semibold' : 'text-muted-foreground')}>
                                {adj?.end ?? row.end}
                              </span>
                              {changed && (
                                <span className="block text-[10px] font-sans mt-0.5">
                                  <span className={cn(
                                    "inline-block px-1 rounded text-white text-[9px]",
                                    delta > 0 ? 'bg-emerald-500' : 'bg-orange-500'
                                  )}>
                                    {delta > 0 ? `-${delta}ms` : `+${Math.abs(delta)}ms`}
                                  </span>
                                </span>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </ScrollArea>
                  <div className="px-3 py-1.5 bg-muted/20 text-[10px] text-muted-foreground flex gap-3 flex-wrap">
                    <span><span className="inline-block w-2 h-2 rounded-full bg-emerald-500 mr-1"></span>Earlier end</span>
                    <span><span className="inline-block w-2 h-2 rounded-full bg-orange-500 mr-1"></span>Later end</span>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── Export Starred MP3s Dialog ──────────────────────────────── */}
      <Dialog open={showExportDialog} onOpenChange={(open) => { if (!isExporting) setShowExportDialog(open); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Music className="w-5 h-5 text-emerald-500" />
              Export Starred Sentences as MP3
            </DialogTitle>
            <DialogDescription>
              Each starred sentence will be exported as an individual .mp3 file, sliced from the audio based on timestamps.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-4 py-2">
            <div className="text-sm text-muted-foreground">
              <span className="font-medium text-foreground">{subtitles.filter(s => s.isStarred).length}</span> starred sentence{subtitles.filter(s => s.isStarred).length !== 1 ? 's' : ''} will be exported.
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="export-prefix" className="text-sm font-medium">
                Filename prefix
              </Label>
              <Input
                id="export-prefix"
                placeholder="e.g. FRE0004"
                value={exportPrefix}
                onChange={(e) => setExportPrefix(e.target.value)}
                disabled={isExporting}
                autoFocus
                className="font-mono"
              />
              {exportPrefix.trim() && (() => {
                const { alpha, startNum, padding } = parsePrefix(exportPrefix.trim());
                const starredCount = subtitles.filter(s => s.isStarred).length;
                const previewNames = Array.from({ length: Math.min(starredCount, 3) }, (_, i) =>
                  generateFileName(alpha, startNum + i, padding)
                );
                return (
                  <div className="rounded-md bg-muted/50 border p-3 text-xs font-mono space-y-0.5">
                    <span className="text-[10px] uppercase tracking-wide text-muted-foreground font-sans font-medium block mb-1">Preview</span>
                    {previewNames.map((name, i) => (
                      <div key={i} className="text-foreground">{name}</div>
                    ))}
                    {starredCount > 3 && (
                      <div className="text-muted-foreground">… and {starredCount - 3} more</div>
                    )}
                  </div>
                );
              })()}
            </div>

            {isExporting && (
              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="w-4 h-4 animate-spin text-emerald-500" />
                  Exporting {exportProgress.current} of {exportProgress.total}…
                </div>
                <Progress
                  value={exportProgress.total > 0 ? (exportProgress.current / exportProgress.total) * 100 : 0}
                  className="h-2 [&>div]:bg-emerald-500"
                />
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowExportDialog(false)} disabled={isExporting}>
              Cancel
            </Button>
            <Button
              onClick={handleExportStarredMp3s}
              disabled={isExporting || !exportPrefix.trim() || !hasStarredSentences}
              className="bg-emerald-600 hover:bg-emerald-700 text-white"
            >
              {isExporting ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Exporting…
                </>
              ) : (
                <>
                  <Download className="w-4 h-4 mr-2" />
                  Export {subtitles.filter(s => s.isStarred).length} MP3s
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
