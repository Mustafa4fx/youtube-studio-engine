FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg fonts-noto-core fonts-noto-color-emoji fonts-dejavu-core ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
RUN npm init -y >/dev/null && npm install playwright@1.63.0 && npx playwright install --with-deps chromium
COPY lib.js render.js run.js assets.js stage.html ./
CMD ["sleep", "infinity"]
