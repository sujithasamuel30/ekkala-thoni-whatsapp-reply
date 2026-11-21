# Ekkala Thoni WhatsApp auto-reply — Render deploy
#
# Node 22 (LTS) + Python 3 for the faster-whisper voice transcription.
# No npm dependencies: the server uses only Node built-ins.
# The Python venv is rebuilt here from requirements.txt (do NOT copy the
# local venv into the image — see .dockerignore).
#
# Render free tier: 512 MB RAM, 0.1 CPU, 750 instance-hours/month,
# no credit card. It sleeps after 15 min idle — see DEPLOY.md for the
# keep-awake note and what that means for the webhook.
FROM node:22-bookworm-slim

# Python + ffmpeg for faster-whisper (voice messages).
# PyAV wheels bundle their own FFmpeg libs, but the ffmpeg package is
# cheap insurance for audio decoding.
# tesseract-ocr: reads Google Pay receipt screenshots so the server can tell
# a payment screenshot (offering) apart from a random photo (no reply).
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-venv python3-pip ffmpeg tesseract-ocr \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Python deps first (better layer caching when only the server code changes).
COPY requirements.txt ./
RUN python3 -m venv /app/venv \
    && /app/venv/bin/pip install --no-cache-dir -r requirements.txt

# Server code + template images.
COPY server.js classify.js transcribe.py ./
COPY templates ./templates

# The Whisper model (tiny, ~75 MB) is NOT baked in: it downloads once from
# Hugging Face on the first voice message after a deploy/restart and is
# then cached in the container. That first transcription takes a few
# seconds longer, well inside the server's 120 s transcription timeout.
# If transcription fails, the server asks the clarification question
# instead of guessing — nothing is lost.
ENV TEMPLATES_DIR=/app/templates
ENV WHISPER_MODEL=tiny

# Render injects $PORT; the server reads it (default 3000).
EXPOSE 3000

CMD ["node", "server.js"]
