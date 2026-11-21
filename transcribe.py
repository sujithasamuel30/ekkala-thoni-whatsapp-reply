#!/usr/bin/env python3
"""Transcribe a WhatsApp voice/audio file to text with faster-whisper (local, free).

Usage: transcribe.py <audio-file-path> [model]
  Prints the transcribed text to stdout (one line). Prints nothing on failure
  and exits non-zero; the caller then falls back to the clarification question.

Model: 'tiny' by default (fast, small download ~75 MB). Set WHISPER_MODEL or
pass a 2nd argument for 'base' (~145 MB, better Tamil accuracy) or 'small'.
The model is downloaded once from Hugging Face and cached in ~/.cache/huggingface.
Requires ffmpeg (already on this machine) and the venv in this project folder.
"""
import os
import sys


def main():
    if len(sys.argv) < 2:
        print("usage: transcribe.py <audio-file> [model]", file=sys.stderr)
        return 2
    audio_path = sys.argv[1]
    model = sys.argv[2] if len(sys.argv) > 2 else os.environ.get("WHISPER_MODEL", "tiny")
    try:
        from faster_whisper import WhisperModel
    except ImportError as e:
        print(f"faster-whisper not installed: {e}", file=sys.stderr)
        return 3
    try:
        m = WhisperModel(model, device="cpu", compute_type="int8")
        segments, _info = m.transcribe(audio_path, beam_size=1)
        text = " ".join(s.text.strip() for s in segments).strip()
        print(text)
        return 0
    except Exception as e:
        print(f"transcription failed: {e}", file=sys.stderr)
        return 4


if __name__ == "__main__":
    sys.exit(main())
