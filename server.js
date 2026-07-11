const express = require("express");
const path = require("path");
const fs = require("fs");
const os = require("os");
const fetch = require("node-fetch");
const yts = require("yt-search");
const { spawn } = require("child_process");
const rpg = require("./rpg");

const app = express();
const PORT = process.env.PORT || 5000;

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

// --- RPG: Account registration / login / adventure ---
app.post("/api/rpg/register", async (req, res) => {
  const { email, password } = req.body || {};
  const result = await rpg.register(email, password);
  res.status(result.ok ? 200 : 400).json(result);
});

app.post("/api/rpg/login", async (req, res) => {
  const { email, password } = req.body || {};
  const result = await rpg.login(email, password);
  res.status(result.ok ? 200 : 400).json(result);
});

app.post("/api/rpg/ubahpw", async (req, res) => {
  const token = req.headers["x-session-token"];
  const { oldPassword, newPassword } = req.body || {};
  const result = await rpg.changePassword(token, oldPassword, newPassword);
  res.status(result.ok ? 200 : 400).json(result);
});

app.get("/api/rpg/backupdata", (req, res) => {
  const token = req.headers["x-session-token"];
  const result = rpg.backupData(token);
  if (!result.ok) return res.status(result.error.includes("ditolak") ? 403 : 401).json(result);
  const filename = `backup-players-${new Date().toISOString().slice(0,10)}.json`;
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Content-Type", "application/json");
  res.send(JSON.stringify(result, null, 2));
});

app.get("/api/rpg/profile", (req, res) => {
  const token = req.headers["x-session-token"];
  const player = rpg.getPlayerFromToken(token);
  if (!player) return res.status(401).json({ ok: false, error: "Sesi tidak valid. Login dulu dengan .login" });
  res.json({ ok: true, player: rpg.publicView(player) });
});

app.post("/api/rpg/adventure", async (req, res) => {
  const token = req.headers["x-session-token"];
  const result = await rpg.adventure(token);
  res.status(result.ok ? 200 : 400).json(result);
});

// --- Song search + download (YouTube audio) ---
app.get("/api/song", async (req, res) => {
  const q = (req.query.q || "").toString().trim();
  if (!q) return res.status(400).json({ ok: false, error: "Parameter q wajib diisi" });

  try {
    const result = await yts(q);
    const video = result.videos && result.videos[0];
    if (!video) return res.status(404).json({ ok: false, error: "Lagu tidak ditemukan" });

    res.json({
      ok: true,
      title: video.title,
      author: video.author?.name || "Unknown",
      duration: video.timestamp,
      thumbnail: video.thumbnail,
      videoId: video.videoId,
      downloadUrl: `/api/song/download?id=${video.videoId}`,
    });
  } catch (err) {
    console.error("song search error:", err.message);
    res.status(500).json({ ok: false, error: "Gagal mencari lagu" });
  }
});

const VIDEO_ID_RE = /^[a-zA-Z0-9_-]{11}$/;
const DOWNLOAD_TIMEOUT_MS = 60_000;
const MAX_CONCURRENT_DOWNLOADS = 4;
let activeDownloads = 0;

app.get("/api/song/download", async (req, res) => {
  const id = (req.query.id || "").toString().trim();
  if (!id || !VIDEO_ID_RE.test(id)) {
    return res.status(400).json({ ok: false, error: "ID video tidak valid" });
  }

  if (activeDownloads >= MAX_CONCURRENT_DOWNLOADS) {
    return res.status(429).json({ ok: false, error: "Server sedang sibuk, coba lagi sebentar lagi" });
  }
  activeDownloads++;
  let slotReleased = false;
  const releaseSlot = () => {
    if (!slotReleased) { slotReleased = true; activeDownloads--; }
  };

  const filename = `audio-${id}.mp3`;
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Content-Type", "audio/mpeg");

  const ytdlpBin = path.join(__dirname, ".bin", "yt-dlp");
  const tmpBase = path.join(os.tmpdir(), `song-${id}-${Date.now()}`);
  const rawPath = `${tmpBase}.audio`;
  const mp3Path = `${tmpBase}.mp3`;

  const children = new Set();
  let settled = false;

  const cleanup = () => {
    fs.unlink(rawPath, () => {});
    fs.unlink(mp3Path, () => {});
    for (const child of children) {
      if (!child.killed) child.kill("SIGKILL");
    }
    clearTimeout(timeoutTimer);
    releaseSlot();
  };

  const fail = (msg, status = 500) => {
    if (settled) return;
    settled = true;
    if (!res.headersSent) res.status(status).json({ ok: false, error: msg });
    else res.destroy();
    cleanup();
  };

  const timeoutTimer = setTimeout(() => {
    fail("Proses unduh memakan waktu terlalu lama", 504);
  }, DOWNLOAD_TIMEOUT_MS);

  res.on("close", () => {
    // Only abort if the response didn't finish normally (i.e. client disconnected
    // before we finished sending). res.writableFinished is true once the stream
    // completed successfully, so we suppress the cancel in that case.
    if (!settled && !res.writableFinished) fail("Klien memutuskan koneksi");
  });

  const ytdlp = spawn(ytdlpBin, [
    "-f", "bestaudio",
    "-o", rawPath,
    `https://www.youtube.com/watch?v=${id}`,
  ]);
  children.add(ytdlp);

  let ytdlpStderr = "";
  ytdlp.stderr.on("data", (d) => { ytdlpStderr += d.toString(); });

  ytdlp.on("error", (err) => {
    console.error("yt-dlp spawn error:", err.message);
    fail("Gagal menjalankan proses unduh");
  });

  ytdlp.on("close", (code) => {
    if (settled) return;
    if (code !== 0 || !fs.existsSync(rawPath)) {
      console.error("yt-dlp failed:", ytdlpStderr.slice(-500));
      return fail("Gagal mengunduh audio dari YouTube");
    }

    const ffmpeg = spawn("ffmpeg", [
      "-y", "-i", rawPath,
      "-vn", "-ar", "44100", "-ac", "2", "-b:a", "128k",
      mp3Path,
    ]);
    children.add(ffmpeg);

    let ffmpegStderr = "";
    ffmpeg.stderr.on("data", (d) => { ffmpegStderr += d.toString(); });

    ffmpeg.on("error", (err) => {
      console.error("ffmpeg spawn error:", err.message);
      fail("Gagal mengonversi audio");
    });

    ffmpeg.on("close", (code2) => {
      if (settled) return;
      if (code2 !== 0 || !fs.existsSync(mp3Path)) {
        console.error("ffmpeg failed:", ffmpegStderr.slice(-500));
        return fail("Gagal mengonversi audio");
      }

      settled = true;
      clearTimeout(timeoutTimer);
      const readStream = fs.createReadStream(mp3Path);
      readStream.pipe(res);
      readStream.on("close", cleanup);
      readStream.on("error", () => { fail("Gagal mengirim audio"); });
    });
  });
});

// --- Pinterest search ---
app.get("/api/pinterest", async (req, res) => {
  const q = (req.query.q || "").toString().trim();
  if (!q) return res.status(400).json({ ok: false, error: "Parameter q wajib diisi" });

  try {
    const response = await fetch(`https://api.deline.web.id/search/pinterest?q=${encodeURIComponent(q)}`);
    const json = await response.json();

    if (!json || json.status === false || !Array.isArray(json.data)) {
      return res.status(404).json({ ok: false, error: "Gambar tidak ditemukan" });
    }

    // Deduplicate by image URL, then shuffle so repeated searches don't
    // always surface the exact same top results.
    const seen = new Set();
    const unique = json.data.filter((item) => {
      if (!item.image || seen.has(item.image)) return false;
      seen.add(item.image);
      return true;
    });

    for (let i = unique.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [unique[i], unique[j]] = [unique[j], unique[i]];
    }

    const items = unique.slice(0, 12).map((item) => ({
      image: item.image,
      caption: item.caption || "",
      source: item.source || "",
    }));

    res.json({ ok: true, items });
  } catch (err) {
    console.error("pinterest search error:", err.message);
    res.status(500).json({ ok: false, error: "Gagal menghubungi server Pinterest" });
  }
});

app.get("/*splat", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
