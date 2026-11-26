FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg fonts-noto-core fonts-noto-color-emoji fonts-dejavu-core ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
RUN npm init -y >/dev/null && npm install playwright@1.63.0 && npx playwright install --with-deps chromium
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip && rm -rf /var/lib/apt/lists/* && pip3 install --no-cache-dir --break-system-packages faster-whisper==1.1.1
COPY lib.js render.js run.js assets.js stage.html config.json align.py cloud.js cloudtask.js ./
CMD ["sleep", "infinity"]
