# PokéBid

A blind-bid Pokémon auction teambuilder. Draft a team of **6 Pokémon** with a **$30** budget — but you only ever see **two random stats** per Pokémon, so every bid is a gamble.

- **2–5 players**, online multiplayer (real-time via Socket.IO)
- **30-second bid timer** per turn — bid, or fold to skip
- Losing bids cost nothing; only the winner pays
- Pool limited to **battle-ready Pokémon** from VGC World Champion teams, in-game Champion teams, and special boss teams
- Everyone's drafted team is revealed at the end

## Tech

- Node.js + Express + Socket.IO
- No database — game rooms live in memory (cleaned up automatically)

## Run locally

```bash
npm install
npm start
```

Then open http://localhost:3000

Environment variables (all optional):

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | Port to listen on |
| `TURN_SECONDS` | `30` | Seconds each player gets to bid |
| `REVEAL_SECONDS` | `4` | Seconds the "you got X" cutscene shows |

## Deploy for free

### Option A — Render (recommended, free tier)

1. Push this folder to a GitHub repository:
   ```bash
   git init
   git add .
   git commit -m "PokéBid"
   git branch -M main
   git remote add origin https://github.com/YOURNAME/pokebid.git
   git push -u origin main
   ```
2. Go to https://render.com → **New → Web Service** → connect your repo.
   - Render will auto-detect Node. If it asks: build command `npm install`, start command `npm start`.
   - (Or use **New → Blueprint** and point it at the repo — it reads `render.yaml` automatically.)
3. Render gives you a URL like `https://pokebid.onrender.com` — share it with your friends.

> Note: Render's free tier puts the app to sleep after ~15 minutes of inactivity and cold-starts it (~30–60s) on the next visit. The first player to open it just waits a moment.

### Option B — Railway

1. Push to GitHub (same as above).
2. Go to https://railway.app → **New Project → Deploy from GitHub repo**.
3. Railway auto-detects the Node app and exposes a public URL.

### Option C — Fly.io

1. Install the Fly CLI and run `fly launch` in this folder, then `fly deploy`.
2. (Fly requires a credit card on file even for the free allowance.)

## Project layout

- `server.js` — game server (Express + Socket.IO, all game logic)
- `battle_pool.json` — the curated list of 177 battle-ready Pokémon
- `public/index.html` — the entire client (self-contained: HTML + CSS + JS)
- `render.yaml` — Render blueprint config
