# Noir Kanza ABCD — Bot Terminal Portfolio

A neon-styled terminal portfolio site for Noir Kanza ABCD. Features an interactive terminal UI, YouTube audio downloader, Pinterest image search, and a text-based RPG mini-game.

## Stack

- **Runtime:** Node.js 20
- **Framework:** Express 5
- **Frontend:** Vanilla HTML/CSS/JS (served from `public/`)
- **Storage:** File-based JSON (`data/players.json`) for RPG player accounts
- **Audio download:** [cobalt.tools](https://cobalt.tools) API — no CLI tools required

## How to run (Replit)

```
node server.js
```

The app listens on `PORT` (default 5000).

## How to deploy on Vercel

1. Push this repo to GitHub.
2. Import the repo in [vercel.com](https://vercel.com) — `vercel.json` is already configured.
3. Add the `SESSION_SECRET` environment variable in Vercel project settings → Environment Variables.
4. Deploy. The play and pin features work out of the box — no CLI tools needed.

> **⚠️ RPG limitation on Vercel:** Player accounts are stored in `data/players.json`. Vercel's serverless filesystem is ephemeral, so RPG data (registrations, levels, gold) will not persist between cold starts. To fix this properly, the RPG module should be migrated to a database.

## API endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/song?q=<query>` | Search YouTube for a song |
| GET | `/api/song/download?id=<videoId>` | Redirect to cobalt.tools MP3 download URL |
| GET | `/api/pinterest?q=<query>` | Search Pinterest images via third-party API |
| POST | `/api/rpg/register` | Register RPG account (email + password) |
| POST | `/api/rpg/login` | Login and get session token |
| GET | `/api/rpg/profile` | Get player profile (requires `x-session-token` header) |
| POST | `/api/rpg/adventure` | Go on an adventure (30s cooldown) |

## Environment secrets

| Secret | Purpose |
|--------|---------|
| `SESSION_SECRET` | HMAC key for signing/verifying RPG session tokens (required at startup) |

## Key files

- `server.js` — Express server and all API routes
- `rpg.js` — RPG player account system (register, login, adventure)
- `public/index.html` — Terminal-style frontend SPA
- `data/players.json` — RPG player accounts (file-based, auto-created)
- `vercel.json` — Vercel deployment configuration

## Notes

- Audio download uses [cobalt.tools](https://cobalt.tools) public API — no yt-dlp or ffmpeg required. The endpoint redirects (HTTP 302) to cobalt's download URL.
- Pinterest search proxies through `api.deline.web.id` — if that service is down, the endpoint will fail.
- The `SESSION_SECRET` environment variable must be set before the server starts.

## User preferences

(Add preferences here as they come up)
