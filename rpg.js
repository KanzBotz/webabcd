// --- RPG Player Accounts Module ---
// File-based player storage + stateless HMAC session tokens (no DB needed).
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");

const DATA_DIR = path.join(__dirname, "data");
const PLAYERS_FILE = path.join(DATA_DIR, "players.json");
const OWNER_EMAIL = "kanzatitit@gmail.com";
const SESSION_SECRET = process.env.SESSION_SECRET;

if (!SESSION_SECRET) {
  throw new Error("SESSION_SECRET env var is required for RPG session tokens but is not set.");
}

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(PLAYERS_FILE)) fs.writeFileSync(PLAYERS_FILE, "{}");

const EMAIL_RE = /^[a-zA-Z0-9._%+-]+@gmail\.com$/;

function loadPlayers() {
  try {
    return JSON.parse(fs.readFileSync(PLAYERS_FILE, "utf8"));
  } catch {
    // Corrupted or unreadable file: back it up for manual recovery instead of
    // silently losing all accounts.
    try {
      if (fs.existsSync(PLAYERS_FILE)) {
        fs.copyFileSync(PLAYERS_FILE, `${PLAYERS_FILE}.corrupt.${Date.now()}`);
      }
    } catch { /* best-effort backup */ }
    return {};
  }
}

// Serialize all reads+writes through a single in-memory queue so concurrent
// requests can't clobber each other with stale read-modify-write cycles, and
// write atomically (tmp file + rename) so a crash mid-write can't corrupt
// the store.
let writeQueue = Promise.resolve();

function withPlayers(mutator) {
  const run = writeQueue.then(async () => {
    const players = loadPlayers();
    const result = await mutator(players);
    const tmpFile = `${PLAYERS_FILE}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmpFile, JSON.stringify(players, null, 2));
    fs.renameSync(tmpFile, PLAYERS_FILE);
    return result;
  });
  // Keep the queue alive even if this mutation throws, so later ones still run.
  writeQueue = run.catch(() => {});
  return run;
}

// Use a delimiter that cannot appear in an email or a decimal timestamp, so
// splitting the decoded token back into fields is unambiguous (emails
// contain dots, which ruled that out as a separator).
const TOKEN_DELIM = "|";

function makeToken(email) {
  const issuedAt = Date.now();
  const payload = `${email}${TOKEN_DELIM}${issuedAt}`;
  const sig = crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("hex");
  return Buffer.from(`${payload}${TOKEN_DELIM}${sig}`).toString("base64url");
}

function verifyToken(token) {
  try {
    const decoded = Buffer.from(String(token), "base64url").toString("utf8");
    const parts = decoded.split(TOKEN_DELIM);
    if (parts.length !== 3) return null;
    const [email, issuedAtStr, sig] = parts;
    const issuedAt = Number(issuedAtStr);
    if (!Number.isFinite(issuedAt) || Date.now() - issuedAt > SESSION_TTL_MS) return null;

    const payload = `${email}${TOKEN_DELIM}${issuedAtStr}`;
    const expected = crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("hex");
    if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
      return null;
    }
    return email;
  } catch {
    return null;
  }
}

function expForLevel(level) {
  return level * 100;
}

function publicView(player) {
  return {
    email: player.email,
    level: player.level,
    exp: player.exp,
    expToNext: expForLevel(player.level),
    gold: player.gold,
    hp: player.hp,
    maxHp: player.maxHp,
    createdAt: player.createdAt,
  };
}

async function register(email, password) {
  email = String(email || "").trim().toLowerCase();
  password = String(password || "");

  if (!EMAIL_RE.test(email)) {
    return { ok: false, error: "Format email tidak valid. Gunakan alamat @gmail.com." };
  }
  if (password.length < 4) {
    return { ok: false, error: "Password minimal 4 karakter." };
  }

  // Hash before entering the write queue (bcrypt is slow; don't hold the lock).
  const passwordHash = await bcrypt.hash(password, 10);

  const result = await withPlayers((players) => {
    if (players[email]) {
      return { ok: false, error: "Akun dengan email ini sudah terdaftar." };
    }
    const player = {
      email,
      passwordHash,
      level: 1,
      exp: 0,
      gold: 100,
      hp: 100,
      maxHp: 100,
      createdAt: new Date().toISOString(),
      lastAdventureAt: 0,
    };
    players[email] = player;
    return { ok: true, token: makeToken(email), player: publicView(player) };
  });

  return result;
}

async function login(email, password) {
  email = String(email || "").trim().toLowerCase();
  password = String(password || "");

  const players = loadPlayers();
  const player = players[email];
  if (!player) {
    return { ok: false, error: "Akun tidak ditemukan. Daftar dulu dengan .daftar" };
  }

  const match = await bcrypt.compare(password, player.passwordHash);
  if (!match) {
    return { ok: false, error: "Password salah." };
  }

  return { ok: true, token: makeToken(email), player: publicView(player) };
}

function getPlayerFromToken(token) {
  const email = verifyToken(token);
  if (!email) return null;
  const players = loadPlayers();
  return players[email] || null;
}

const ADVENTURE_COOLDOWN_MS = 30 * 1000;

function adventure(token) {
  const email = verifyToken(token);
  if (!email) return { ok: false, error: "Sesi tidak valid. Login dulu dengan .login" };

  return withPlayers((players) => {
    const player = players[email];
    if (!player) return { ok: false, error: "Akun tidak ditemukan." };

    const now = Date.now();
    const wait = ADVENTURE_COOLDOWN_MS - (now - (player.lastAdventureAt || 0));
    if (wait > 0) {
      return { ok: false, error: `Karaktermu masih lelah. Tunggu ${Math.ceil(wait / 1000)} detik lagi.` };
    }

    const expGain = 15 + Math.floor(Math.random() * 20);
    const goldGain = 5 + Math.floor(Math.random() * 15);
    const damage = Math.floor(Math.random() * 15);

    player.exp += expGain;
    player.gold += goldGain;
    player.hp = Math.max(1, player.hp - damage);
    player.lastAdventureAt = now;

    let leveledUp = false;
    while (player.exp >= expForLevel(player.level)) {
      player.exp -= expForLevel(player.level);
      player.level += 1;
      player.maxHp += 10;
      player.hp = player.maxHp;
      leveledUp = true;
    }

    return {
      ok: true,
      expGain,
      goldGain,
      damage,
      leveledUp,
      player: publicView(player),
    };
  });
}

async function changePassword(token, oldPassword, newPassword) {
  const email = verifyToken(token);
  if (!email) return { ok: false, error: "Sesi tidak valid. Login dulu dengan .login" };

  oldPassword = String(oldPassword || "");
  newPassword = String(newPassword || "");

  if (newPassword.length < 4) {
    return { ok: false, error: "Password baru minimal 4 karakter." };
  }

  // Hash before entering write queue (bcrypt is slow; don't hold the lock).
  const newHash = await bcrypt.hash(newPassword, 10);

  return withPlayers(async (players) => {
    const player = players[email];
    if (!player) return { ok: false, error: "Akun tidak ditemukan." };

    const match = await bcrypt.compare(oldPassword, player.passwordHash);
    if (!match) return { ok: false, error: "Password lama salah." };

    player.passwordHash = newHash;
    return { ok: true };
  });
}

function backupData(token) {
  const email = verifyToken(token);
  if (!email) return { ok: false, error: "Sesi tidak valid. Login dulu dengan .login" };
  if (email !== OWNER_EMAIL) return { ok: false, error: "Akses ditolak. Fitur ini hanya untuk owner." };

  const players = loadPlayers();
  // Return sanitized backup: public fields only (no password hashes)
  const backup = Object.values(players).map((p) => ({
    email: p.email,
    level: p.level,
    exp: p.exp,
    gold: p.gold,
    hp: p.hp,
    maxHp: p.maxHp,
    createdAt: p.createdAt,
    lastAdventureAt: p.lastAdventureAt,
  }));
  return { ok: true, data: backup, total: backup.length, exportedAt: new Date().toISOString() };
}

module.exports = { register, login, getPlayerFromToken, adventure, publicView, changePassword, backupData };