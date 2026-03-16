import sys
from pathlib import Path

# Add current dir to path
sys.path.append(str(Path.cwd() / "backend"))

from app import extract_waveform_peaks

def test():
    mp3_path = Path("media/UF8uR6Z6KLc.mp3")
    if not mp3_path.exists():
        print(f"File not found: {mp3_path}")
        return
    
    try:
        peaks = extract_waveform_peaks(mp3_path)
        print(f"Extracted {len(peaks)} peaks")
    except Exception as e:
        import traceback
        traceback.print_exc()

if __name__ == "__main__":
    test()
