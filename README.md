# youtube-studio-engine

Video engine for the 14-channel network (Edge AI / عالم الذكاء الاصطناعي, …).

- `engine/` — renderer (Node + Playwright + ffmpeg): kinetic captions, motion, icons, emoji, web screenshots, news cards, stock B-roll (Pixabay, filtered), Gemini TTS.
- `specs/` — one JSON per video (beats: narration + visuals + media).
- `jobs/` — each JSON here is rendered once by the server.
- `server/autosync.py` — cron on the server: pulls this repo, redeploys the engine, renders new jobs, publishes https://panel.helpanegyptian.com/videos/

No API keys or secrets are stored in this repository. Keys live only in the server's `.env`.
