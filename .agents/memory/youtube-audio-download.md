---
name: YouTube audio download reliability
description: How to reliably extract audio from YouTube via yt-dlp in this environment
---

The `yt-dlp` package available through Nix (`installSystemDependencies`) can be
a year or more out of date. YouTube evolves its anti-bot/PO-token and player
signature logic frequently, so an old yt-dlp build fails with errors like
"Some formats missing", "403 Forbidden", or "content not available on this app".

**Why:** hit this while building a song-download feature — the Nix yt-dlp
(mid-2025) could not extract playable audio URLs at all, while downloading the
latest static `yt-dlp_linux` release from GitHub worked immediately.

**How to apply:** if yt-dlp extraction fails or looks flaky, download the latest
release binary directly (`curl -L -o .bin/yt-dlp https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux && chmod +x`)
and point the app at that binary instead of the system/Nix one. Also prefer
downloading to a temp file (`-o <path>`) rather than piping to stdout — piping
audio through `-o -` triggered spurious 403s in testing, while file output was
reliable. Convert with a separate `ffmpeg` pass reading that temp file.
