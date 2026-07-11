const express = require("express");
const path = require("path");
const fs = require("fs");
const fetch = require("node-fetch");
const yts = require("yt-search");
const ytdl = require("@distube/ytdl-core");
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

// Uses @distube/ytdl-core — pure JS, no CLI tools required, works on serverless (Vercel etc.)
// Redirects the browser to YouTube's signed audio CDN URL (audioonly, highest quality).
app.get("/api/song/download", async (req, res) => {
  const id = (req.query.id || "").toString().trim();
  if (!id || !VIDEO_ID_RE.test(id)) {
    return res.status(400).json({ ok: false, error: "ID video tidak valid" });
  }

  try {
    const info = await ytdl.getInfo(`https://www.youtube.com/watch?v=${id}`);
    const format = ytdl.chooseFormat(info.formats, {
      quality: "highestaudio",
      filter: "audioonly",
    });

    if (!format || !format.url) {
      return res.status(500).json({ ok: false, error: "Format audio tidak ditemukan" });
    }

    // Redirect browser directly to YouTube's audio CDN — no binary streaming needed
    return res.redirect(302, format.url);
  } catch (err) {
    console.error("ytdl error:", err.message);
    return res.status(500).json({ ok: false, error: "Gagal mendapatkan URL audio dari YouTube" });
  }
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

// Only start a local listener when run directly (e.g. `node server.js`).
// On Vercel, the file is imported as a serverless handler — app.listen must NOT be called.
if (require.main === module) {
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on port ${PORT}`);
  });
}

module.exports = app;
