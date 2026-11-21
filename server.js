const express = require("express");
const path = require("path");
const fs = require("fs");
const { Pool } = require("pg");
const crypto = require("crypto");
const { Client, GatewayIntentBits } = require("discord.js");

const discordClient = new Client({ intents: [GatewayIntentBits.Guilds] });

const app = express();

const submissionAttempts = new Map();
function limitSeriesSubmissions(req, res, next) {
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  const now = Date.now();
  const recent = (submissionAttempts.get(ip) || []).filter(time => now - time < 3600000);
  if (recent.length >= 5) return res.status(429).json({ error: "وصلت للحد المؤقت للطلبات. حاول بعد ساعة." });
  recent.push(now);
  submissionAttempts.set(ip, recent);
  next();
}

const PORT = process.env.PORT || 3000;
const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false }
    })
  : null;

app.use(express.json({ limit: "1mb" }));
app.use((req, res, next) => {
  if (req.path === "/admin.html") return res.redirect(302, "/admin");
  next();
});
app.use(express.static(path.join(__dirname, "public")));

function parseCookies(req) {
  const result = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    const key = part.slice(0, index).trim();
    const raw = part.slice(index + 1).trim();
    try { result[key] = decodeURIComponent(raw); }
    catch (_error) { result[key] = raw; }
  }
  return result;
}

function signValue(value) {
  return crypto.createHmac("sha256", process.env.SESSION_SECRET || "").update(value).digest("base64url");
}

function safeEqualText(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function getAdminSession(req) {
  const secret = process.env.SESSION_SECRET || "";
  if (secret.length < 32) return null;
  const token = parseCookies(req).cass_admin_session || "";
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payload, signature] = parts;
  if (!safeEqualText(signValue(payload), signature)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    const allowed = String(process.env.DISCORD_ADMIN_IDS || "").split(",").map(x => x.trim()).filter(Boolean);
    if (!data.id || !Number.isFinite(data.exp) || data.exp < Date.now() || !allowed.includes(String(data.id))) return null;
    return { id: String(data.id), username: String(data.username || "Discord Admin") };
  } catch (_error) { return null; }
}

function requireAdmin(req, res, next) {
  if (getAdminSession(req)) return next();
  const expected = process.env.ADMIN_API_KEY || "";
  const supplied = req.get("x-admin-key") || "";
  const a = Buffer.from(expected);
  const b = Buffer.from(supplied);
  if (!expected || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: "سجّل الدخول بديسكورد أو أدخل مفتاح الإدارة." });
  }
  next();
}

function requireDatabase(req, res, next) {
  if (!pool) return res.status(503).json({ error: "قاعدة البيانات غير مربوطة." });
  next();
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (err, key) => {
      if (err) return reject(err);
      resolve({ salt, hash: key.toString("hex") });
    });
  });
}

async function verifyPassword(password, salt, expectedHash) {
  const result = await hashPassword(password, salt);
  const a = Buffer.from(result.hash, "hex");
  const b = Buffer.from(expectedHash, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function findXtreamUser(username, password) {
  if (!username || !password || !pool) return null;
  const result = await pool.query(
    "SELECT id, username, password_salt, password_hash, is_active, expires_at, created_at FROM xtream_users WHERE username = $1",
    [String(username).slice(0, 32)]
  );
  const user = result.rows[0];
  if (!user || !user.is_active) return null;
  if (user.expires_at && new Date(user.expires_at).getTime() < Date.now()) return null;
  return await verifyPassword(String(password), user.password_salt, user.password_hash) ? user : null;
}

function publicBaseUrl(req) {
  const proto = req.get("x-forwarded-proto") || req.protocol;
  return proto + "://" + req.get("host");
}

function xtreamStreamUrl(req, kind, username, password, id) {
  return publicBaseUrl(req) + "/" + kind + "/" +
    encodeURIComponent(username) + "/" + encodeURIComponent(password) + "/" + id;
}

function xtreamUserInfo(user) {
  return {
    username: user.username,
    password: "********",
    message: "Welcome to CASS TV",
    auth: 1,
    status: "Active",
    exp_date: user.expires_at ? Math.floor(new Date(user.expires_at).getTime() / 1000) : null,
    is_trial: "0",
    active_cons: "0",
    created_at: Math.floor(new Date(user.created_at).getTime() / 1000),
    max_connections: "1",
    allowed_output_formats: ["m3u8", "ts", "mp4"]
  };
}

function serverInfo(req) {
  return {
    url: req.get("host"),
    port: req.get("x-forwarded-port") || "443",
    https_port: "443",
    server_protocol: req.get("x-forwarded-proto") || req.protocol,
    rtmp_port: "0",
    timezone: "Asia/Riyadh",
    timestamp_now: Math.floor(Date.now() / 1000),
    time_now: new Date().toISOString().replace("T", " ").slice(0, 19)
  };
}

function adminCookieOptions(maxAge) {
  const secure = (process.env.DISCORD_REDIRECT_URI || "").startsWith("https://");
  // Discord OAuth returns from another site; None+Secure is reliable for the
  // cross-site callback on Safari/iOS while retaining Lax for local HTTP.
  return "Path=/; HttpOnly; SameSite=" + (secure ? "None; Secure" : "Lax") + "; Max-Age=" + maxAge;
}

app.get("/auth/discord", (req, res) => {
  const clientId = process.env.DISCORD_CLIENT_ID || "";
  const redirectUri = process.env.DISCORD_REDIRECT_URI || "";
  if (!clientId || !redirectUri || !process.env.DISCORD_CLIENT_SECRET || !process.env.SESSION_SECRET || String(process.env.SESSION_SECRET).length < 32 || !String(process.env.DISCORD_ADMIN_IDS || "").trim()) {
    return res.status(503).send("Discord admin login is not configured. Set the required Render environment variables.");
  }
  const state = crypto.randomBytes(24).toString("base64url");
  res.setHeader("Set-Cookie", "cass_oauth_state=" + encodeURIComponent(state) + ";" + adminCookieOptions(600));
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "identify",
    state,
    prompt: "consent"
  });
  res.redirect("https://discord.com/oauth2/authorize?" + params.toString());
});

app.get("/auth/discord/callback", async (req, res) => {
  const cookies = parseCookies(req);
  const state = String(req.query.state || "");
  if (!state || !cookies.cass_oauth_state || !safeEqualText(state, cookies.cass_oauth_state)) {
    res.setHeader("Set-Cookie", "cass_oauth_state=; " + adminCookieOptions(0));
    return res.status(400).send("OAuth state validation failed. Please try logging in again.");
  }
  // Clear the one-time OAuth state cookie without replacing other cookies.
  res.append("Set-Cookie", "cass_oauth_state=; " + adminCookieOptions(0));
  if (req.query.error || !req.query.code) return res.redirect("/admin?login=cancelled");
  try {
    const tokenResponse = await fetch("https://discord.com/api/v10/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.DISCORD_CLIENT_ID || "",
        client_secret: process.env.DISCORD_CLIENT_SECRET || "",
        grant_type: "authorization_code",
        code: String(req.query.code),
        redirect_uri: process.env.DISCORD_REDIRECT_URI || ""
      }),
      signal: AbortSignal.timeout(10000)
    });
    if (!tokenResponse.ok) throw new Error("Discord token exchange failed");
    const tokenData = await tokenResponse.json();
    const userResponse = await fetch("https://discord.com/api/v10/users/@me", {
      headers: { Authorization: "Bearer " + tokenData.access_token },
      signal: AbortSignal.timeout(10000)
    });
    if (!userResponse.ok) throw new Error("Discord identity lookup failed");
    const user = await userResponse.json();
    const allowed = String(process.env.DISCORD_ADMIN_IDS || "").split(",").map(x => x.trim()).filter(Boolean);
    if (!allowed.includes(String(user.id))) return res.redirect("/admin?login=denied");
    const payload = Buffer.from(JSON.stringify({
      id: String(user.id),
      username: String(user.username || "Discord Admin"),
      exp: Date.now() + 8 * 60 * 60 * 1000
    })).toString("base64url");
    const signature = signValue(payload);
    res.setHeader("Set-Cookie", "cass_admin_session=" + encodeURIComponent(payload + "." + signature) + ";" + adminCookieOptions(8 * 60 * 60));
    console.log("[AUTH_DIAG] Discord callback accepted", JSON.stringify({
      adminAllowed: allowed.includes(String(user.id)),
      sessionCookieIssued: true,
      forwardedProto: String(req.get("x-forwarded-proto") || "").split(",")[0].trim(),
      cookieSameSite: (process.env.DISCORD_REDIRECT_URI || "").startsWith("https://") ? "None; Secure" : "Lax"
    }));
    res.redirect("/admin?login=success");
  } catch (error) {
    console.error("Discord admin login failed:", error.message);
    res.redirect("/admin?login=error");
  }
});

app.get("/api/auth/me", (req, res) => {
  const session = getAdminSession(req);
  console.log("[AUTH_DIAG] /api/auth/me", JSON.stringify({
    cookiePresent: Boolean(parseCookies(req).cass_admin_session),
    sessionValid: Boolean(session),
    forwardedProto: String(req.get("x-forwarded-proto") || "").split(",")[0].trim()
  }));
  res.setHeader("Cache-Control", "no-store");
  res.json({ authenticated: Boolean(session), user: session ? { id: session.id, username: session.username } : null });
});

app.post("/api/auth/logout", (req, res) => {
  res.setHeader("Set-Cookie", "cass_admin_session=; " + adminCookieOptions(0));
  res.json({ success: true });
});

app.get("/admin.html", (_req, res) => res.redirect(302, "/admin"));

app.get("/admin", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const session = getAdminSession(req);
  console.log("[AUTH_DIAG] /admin", JSON.stringify({
    cookiePresent: Boolean(parseCookies(req).cass_admin_session),
    sessionValid: Boolean(session),
    forwardedProto: String(req.get("x-forwarded-proto") || "").split(",")[0].trim()
  }));
  if (!session) return res.redirect(302, "/auth/discord");
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

app.get("/api/health", async (_req, res) => {
  let database = false;
  if (pool) {
    try {
      await pool.query("SELECT 1");
      database = true;
    } catch (_error) {}
  }
  res.json({ success: true, app: "CASS TV", status: "running", database });
});

app.get("/api", (_req, res) => {
  res.json({ name: "CASS TV API", version: "1.1.0", xtream_codes: true });
});

app.get("/api/content", requireDatabase, async (_req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, type, title, poster, stream, teaser_url, description, category, created_at FROM content ORDER BY created_at DESC"
    );
    res.json(result.rows);
  } catch (error) {
    console.error("Content read failed:", error.message);
    res.status(500).json({ error: "تعذر تحميل المحتوى." });
  }
});

const DISCORD_CHANNEL_ID = "1573673448516100176";
const DISCORD_ROLE_ID = "1573673168063701123";

async function notifyDiscordNewContent(item) {
  if (!process.env.DISCORD_BOT_TOKEN || !DISCORD_CHANNEL_ID || !DISCORD_ROLE_ID) {
    console.log("Discord notification skipped: bot token is not configured");
    return;
  }
  if (!["movie", "series"].includes(item.type)) return;

  const kind = item.type === "movie" ? "فيلم جديد 🎬" : "مسلسل جديد 📺";
  const safeTitle = String(item.title || "").replace(/@/g, "@\\u200b").slice(0, 150);
  const message = [
    "السلام عليكم 👋",
    "",
    "نزل " + kind + " في CASS TV!",
    "**اسم العمل:** " + safeTitle,
    "تابعوه الآن: https://casstv.onrender.com/",
    "",
    "<@&" + DISCORD_ROLE_ID + ">"
  ].join("\n");

  try {
    const response = await fetch("https://discord.com/api/v10/channels/" + DISCORD_CHANNEL_ID + "/messages", {
      method: "POST",
      headers: {
        "Authorization": "Bot " + process.env.DISCORD_BOT_TOKEN,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        content: message,
        allowed_mentions: { parse: [], roles: [DISCORD_ROLE_ID] }
      }),
      signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) {
      console.error("Discord notification failed:", response.status, (await response.text()).slice(0, 500));
    } else {
      console.log("Discord notification sent for content:", item.id);
    }
  } catch (error) {
    console.error("Discord notification error:", error.message);
  }
}


async function startDiscordBot() {
  const token = process.env.DISCORD_BOT_TOKEN || "";
  if (!token) {
    console.log("Discord bot: DISCORD_BOT_TOKEN is missing");
    return;
  }

  discordClient.once("ready", () => {
    console.log("Discord Gateway ready: " + discordClient.user.tag + " (" + discordClient.user.id + ")");
  });
  discordClient.on("error", error => {
    console.error("Discord Gateway error:", error.message);
  });
  discordClient.on("shardDisconnect", (event, shardId) => {
    console.warn("Discord Gateway disconnected. Shard:", shardId, "Code:", event.code);
  });
  discordClient.on("shardReconnecting", shardId => {
    console.log("Discord Gateway reconnecting. Shard:", shardId);
  });
  discordClient.on("shardResume", (shardId, replayedEvents) => {
    console.log("Discord Gateway resumed. Shard:", shardId, "Replayed events:", replayedEvents);
  });
  discordClient.on("invalidated", () => {
    console.error("Discord Gateway session invalidated; bot cannot reconnect automatically.");
  });

  try {
    await discordClient.login(token);
  } catch (error) {
    console.error("Discord Gateway login failed:", error.message);
  }
}

app.post("/api/admin/discord-test", requireAdmin, async (_req, res) => {
  const token = process.env.DISCORD_BOT_TOKEN || "";
  if (!token) return res.status(503).json({ error: "DISCORD_BOT_TOKEN غير مضبوط." });
  const message = "اختبار بوت CASS TV: الاتصال يعمل بنجاح.";
  try {
    const response = await fetch("https://discord.com/api/v10/channels/" + DISCORD_CHANNEL_ID + "/messages", {
      method: "POST",
      headers: {
        Authorization: "Bot " + token,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ content: message }),
      signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) {
      const details = (await response.text()).slice(0, 500);
      console.error("Discord test message failed:", response.status, details);
      return res.status(502).json({ error: "فشل إرسال اختبار Discord.", status: response.status });
    }
    console.log("Discord test message sent to CASS TV channel");
    return res.json({ success: true, message: "تم إرسال رسالة الاختبار إلى روم CASS TV." });
  } catch (error) {
    console.error("Discord test message error:", error.message);
    return res.status(502).json({ error: "تعذر الاتصال بديسكورد." });
  }
});

app.post("/api/content", requireDatabase, requireAdmin, async (req, res) => {
  const { type, title, poster = "", stream = "", teaser_url = "", description = "", category = "عام" } = req.body || {};
  if (!["movie", "series", "live"].includes(type) || typeof title !== "string" || !title.trim() || typeof category !== "string" || !category.trim() || category.trim().length > 60) {
    return res.status(400).json({ error: "نوع المحتوى والاسم مطلوبان." });
  }
  if (type === "live" && (typeof stream !== "string" || !stream.trim())) {
    return res.status(400).json({ error: "رابط البث المباشر مطلوب." });
  }
  if (stream && !/^https?:\/\//i.test(String(stream))) {
    return res.status(400).json({ error: "رابط التشغيل يجب أن يبدأ بـ http:// أو https://." });
  }
  try {
    const result = await pool.query(
      "INSERT INTO content (type, title, poster, stream, teaser_url, description, category) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, type, title, poster, stream, teaser_url, description, category, created_at",
      [type, title.trim().slice(0, 100), String(poster).slice(0, 1000), String(stream).slice(0, 2000), String(teaser_url).slice(0, 2000), String(description).slice(0, 500), category.trim().slice(0, 60)]
    );
    await notifyDiscordNewContent(result.rows[0]);
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error("Content insert failed:", error.message);
    res.status(500).json({ error: "تعذر حفظ المحتوى." });
  }
});

app.delete("/api/content/:id", requireDatabase, requireAdmin, async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: "معرّف غير صالح." });
  try {
    const result = await pool.query("DELETE FROM content WHERE id = $1 RETURNING id", [req.params.id]);
    if (!result.rowCount) return res.status(404).json({ error: "المحتوى غير موجود." });
    res.json({ success: true });
  } catch (error) {
    console.error("Content delete failed:", error.message);
    res.status(500).json({ error: "تعذر حذف المحتوى." });
  }
});



// Series seasons and episodes API
app.get("/api/series/:id/seasons", requireDatabase, async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: "معرّف المسلسل غير صالح." });
  try {
    const series = await pool.query("SELECT id FROM content WHERE id = $1 AND type = 'series'", [req.params.id]);
    if (!series.rowCount) return res.status(404).json({ error: "المسلسل غير موجود." });
    const result = await pool.query(
      "SELECT s.id, s.season_number, s.title, s.created_at, COALESCE(json_agg(json_build_object('id', e.id, 'episode_number', e.episode_number, 'title', e.title, 'stream', e.stream, 'created_at', e.created_at) ORDER BY e.episode_number) FILTER (WHERE e.id IS NOT NULL), '[]'::json) AS episodes FROM series_seasons s LEFT JOIN series_episodes e ON e.season_id = s.id WHERE s.series_id = $1 GROUP BY s.id ORDER BY s.season_number",
      [req.params.id]
    );
    res.json(result.rows);
  } catch (error) {
    console.error("Series seasons read failed:", error.message);
    res.status(500).json({ error: "تعذر تحميل المواسم والحلقات." });
  }
});
app.post("/api/series/:id/seasons", requireDatabase, requireAdmin, async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: "معرّف المسلسل غير صالح." });
  const number = Number(req.body?.season_number);
  const title = typeof req.body?.title === "string" ? req.body.title.trim() : "";
  if (!Number.isSafeInteger(number) || number < 1 || number > 100 || !title || title.length > 100)
    return res.status(400).json({ error: "أدخل رقم موسم صحيحاً واسماً لا يتجاوز 100 حرف." });
  try {
    const series = await pool.query("SELECT id FROM content WHERE id = $1 AND type = 'series'", [req.params.id]);
    if (!series.rowCount) return res.status(404).json({ error: "المسلسل غير موجود." });
    const result = await pool.query("INSERT INTO series_seasons (series_id, season_number, title) VALUES ($1, $2, $3) RETURNING id, series_id, season_number, title", [req.params.id, number, title]);
    res.status(201).json(result.rows[0]);
  } catch (error) {
    if (error.code === "23505") return res.status(409).json({ error: "رقم الموسم موجود لهذا المسلسل بالفعل." });
    console.error("Season insert failed:", error.message);
    res.status(500).json({ error: "تعذرت إضافة الموسم." });
  }
});
app.post("/api/seasons/:id/episodes", requireDatabase, requireAdmin, async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: "معرّف الموسم غير صالح." });
  const number = Number(req.body?.episode_number);
  const title = typeof req.body?.title === "string" ? req.body.title.trim() : "";
  const stream = typeof req.body?.stream === "string" ? req.body.stream.trim() : "";
  if (!Number.isSafeInteger(number) || number < 1 || number > 10000 || !title || title.length > 120)
    return res.status(400).json({ error: "أدخل رقم حلقة صحيحاً واسماً لا يتجاوز 120 حرفاً." });
  if (!/^https?:\/\//i.test(stream) || !/\.mp4(?:$|[?#])/i.test(stream))
    return res.status(400).json({ error: "رابط الحلقة يجب أن يكون MP4 مباشراً." });
  try {
    const season = await pool.query("SELECT id FROM series_seasons WHERE id = $1", [req.params.id]);
    if (!season.rowCount) return res.status(404).json({ error: "الموسم غير موجود." });
    const result = await pool.query("INSERT INTO series_episodes (season_id, episode_number, title, stream) VALUES ($1, $2, $3, $4) RETURNING id, season_id, episode_number, title, stream", [req.params.id, number, title, stream.slice(0, 2000)]);
    res.status(201).json(result.rows[0]);
  } catch (error) {
    if (error.code === "23505") return res.status(409).json({ error: "رقم الحلقة موجود في هذا الموسم بالفعل." });
    console.error("Episode insert failed:", error.message);
    res.status(500).json({ error: "تعذرت إضافة الحلقة." });
  }
});


app.post("/api/series-submissions", requireDatabase, limitSeriesSubmissions, async (req, res) => {
  const body = req.body || {};
  if (typeof body.website === "string" && body.website.trim()) return res.status(200).json({ success: true });
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const category = typeof body.category === "string" ? body.category.trim() : "";
  const details = typeof body.details === "string" ? body.details.trim() : "";
  const poster = typeof body.poster === "string" ? body.poster.trim() : "";
  const submitter = typeof body.submitter === "string" ? body.submitter.trim() : "";
  const email = typeof body.email === "string" ? body.email.trim() : "";
  if (title.length < 2 || title.length > 120 || !category || category.length > 60)
    return res.status(400).json({ error: "اكتب اسم العمل واختر فئته." });
  if (details.length > 1500 || submitter.length > 80 || poster.length > 1000)
    return res.status(400).json({ error: "بعض البيانات أطول من الحد المسموح." });
  if (email && (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)))
    return res.status(400).json({ error: "البريد الإلكتروني غير صحيح." });
  if (poster) {
    try { if (!["http:", "https:"].includes(new URL(poster).protocol)) throw new Error(); }
    catch { return res.status(400).json({ error: "رابط الغلاف غير صالح." }); }
  }
  try {
    const duplicate = await pool.query("SELECT 1 FROM series_submissions WHERE lower(title) = lower($1) AND created_at > NOW() - INTERVAL '10 minutes' LIMIT 1", [title]);
    if (duplicate.rowCount) return res.status(409).json({ error: "وصلنا اقتراح بهذا الاسم مؤخراً. جرّب لاحقاً." });
    const code = crypto.randomBytes(8).toString("hex").toUpperCase();
    const inserted = await pool.query(
      "INSERT INTO series_submissions (title, category, details, poster_url, submitter_name, contact_email, request_code) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, title, request_code, status",
      [title, category, details, poster, submitter, email, code]
    );
    const item = inserted.rows[0];
    let emailSent = false;
    if (process.env.RESEND_API_KEY && process.env.EMAIL_FROM) {
      try {
        const mail = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { "Authorization": "Bearer " + process.env.RESEND_API_KEY, "Content-Type": "application/json" },
          body: JSON.stringify({
            from: process.env.EMAIL_FROM,
            to: ["ab.cass@outlook.sa"],
            subject: "اقتراح مسلسل جديد · CASS TV · " + title,
            text: ["اقتراح جديد في CASS TV", "رقم الطلب: " + code, "اسم العمل: " + title, "الفئة: " + category, "مقدم الطلب: " + (submitter || "غير محدد"), "بريد التواصل: " + (email || "غير مضاف"), "رابط الغلاف: " + (poster || "غير مضاف"), "التفاصيل: " + (details || "لا توجد تفاصيل")].join("\n")
          })
        });
        if (mail.ok) {
          emailSent = true;
          await pool.query("UPDATE series_submissions SET email_sent = TRUE WHERE id = $1", [item.id]);
        } else console.error("Series submission email failed:", await mail.text());
      } catch (mailError) { console.error("Series submission email error:", mailError.message); }
    }
    res.status(201).json({ success: true, request_code: item.request_code, status: item.status, email_sent: emailSent, message: "تم حفظ اقتراحك بنجاح." });
  } catch (error) {
    console.error("Series submission failed:", error.message);
    res.status(500).json({ error: "تعذر حفظ الطلب حالياً. حاول مرة أخرى." });
  }
});

app.get("/api/series-submissions/track/:code", requireDatabase, async (req, res) => {
  const code = String(req.params.code || "").trim().toUpperCase();
  if (!/^[A-F0-9]{16}$/.test(code)) return res.status(400).json({ error: "رقم الطلب غير صحيح." });
  try {
    const result = await pool.query("SELECT request_code, title, status, created_at, updated_at FROM series_submissions WHERE request_code = $1", [code]);
    if (!result.rowCount) return res.status(404).json({ error: "لم نعثر على طلب بهذا الرقم." });
    res.json(result.rows[0]);
  } catch (error) {
    console.error("Series submission tracking failed:", error.message);
    res.status(500).json({ error: "تعذر متابعة الطلب." });
  }
});

app.get("/api/admin/series-submissions", requireDatabase, requireAdmin, async (_req, res) => {
  try {
    const result = await pool.query("SELECT id, title, category, details, poster_url, submitter_name, contact_email, request_code, status, email_sent, created_at, updated_at FROM series_submissions ORDER BY created_at DESC LIMIT 200");
    res.json(result.rows);
  } catch (error) {
    console.error("Admin series submissions read failed:", error.message);
    res.status(500).json({ error: "تعذر تحميل اقتراحات المسلسلات." });
  }
});

app.patch("/api/admin/series-submissions/:id", requireDatabase, requireAdmin, async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: "رقم الطلب غير صحيح." });
  const status = String(req.body?.status || "");
  if (!["new", "reviewing", "approved", "rejected"].includes(status)) return res.status(400).json({ error: "حالة الطلب غير صحيحة." });
  try {
    const result = await pool.query("UPDATE series_submissions SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING id, status, request_code", [status, req.params.id]);
    if (!result.rowCount) return res.status(404).json({ error: "الطلب غير موجود." });
    res.json({ success: true, ...result.rows[0] });
  } catch (error) {
    console.error("Series submission update failed:", error.message);
    res.status(500).json({ error: "تعذر تحديث حالة الطلب." });
  }
});

app.post("/api/register", requireDatabase, async (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== "string" || !/^[a-zA-Z0-9_.-]{3,32}$/.test(username))
    return res.status(400).json({ error: "اسم المستخدم يجب أن يكون 3 إلى 32 حرفًا إنجليزيًا أو رقمًا." });
  if (typeof password !== "string" || password.length < 8 || password.length > 128)
    return res.status(400).json({ error: "كلمة المرور يجب أن تكون بين 8 و128 حرفًا." });
  try {
    const existing = await pool.query(
      "SELECT 1 FROM xtream_users WHERE username = $1 UNION ALL SELECT 1 FROM xtream_registration_requests WHERE username = $1 AND status = 'pending' LIMIT 1",
      [username]
    );
    if (existing.rowCount) return res.status(409).json({ error: "اسم المستخدم مستخدم أو لديه طلب قيد المراجعة." });
    const { salt, hash } = await hashPassword(password);
    await pool.query(
      "INSERT INTO xtream_registration_requests (username, password_salt, password_hash) VALUES ($1, $2, $3)",
      [username, salt, hash]
    );
    res.status(201).json({ success: true, status: "pending", message: "تم استلام طلبك. انتظر موافقة المدير." });
  } catch (error) {
    if (error.code === "23505") return res.status(409).json({ error: "يوجد طلب بهذا الاسم بالفعل." });
    console.error("Registration request failed:", error.message);
    res.status(500).json({ error: "تعذر إرسال طلب التسجيل." });
  }
});

app.get("/api/xtream/requests", requireDatabase, requireAdmin, async (_req, res) => {
  try {
    const result = await pool.query("SELECT id, username, created_at FROM xtream_registration_requests WHERE status = 'pending' ORDER BY created_at ASC");
    res.json(result.rows);
  } catch (error) {
    console.error("Registration requests read failed:", error.message);
    res.status(500).json({ error: "تعذر تحميل الطلبات." });
  }
});

app.post("/api/xtream/requests/:id/approve", requireDatabase, requireAdmin, async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: "معرّف الطلب غير صالح." });
  const duration = Number(req.body?.duration_days);
  if (![0, 7, 30, 90, 180].includes(duration)) return res.status(400).json({ error: "مدة الاشتراك غير صحيحة." });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const found = await client.query("SELECT id, username, password_salt, password_hash FROM xtream_registration_requests WHERE id = $1 AND status = 'pending' FOR UPDATE", [req.params.id]);
    if (!found.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "الطلب غير موجود أو تمت معالجته." });
    }
    const request = found.rows[0];
    const expiry = duration === 0 ? null : new Date(Date.now() + duration * 86400000);
    const created = await client.query(
      "INSERT INTO xtream_users (username, password_salt, password_hash, expires_at) VALUES ($1, $2, $3, $4) RETURNING id, username, expires_at",
      [request.username, request.password_salt, request.password_hash, expiry]
    );
    await client.query("UPDATE xtream_registration_requests SET status = 'approved' WHERE id = $1", [req.params.id]);
    await client.query("COMMIT");
    res.json({ success: true, user: created.rows[0] });
  } catch (error) {
    await client.query("ROLLBACK");
    if (error.code === "23505") return res.status(409).json({ error: "اسم المستخدم موجود بالفعل." });
    console.error("Registration approval failed:", error.message);
    res.status(500).json({ error: "تعذرت الموافقة على الطلب." });
  } finally {
    client.release();
  }
});

app.post("/api/xtream/requests/:id/reject", requireDatabase, requireAdmin, async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: "معرّف الطلب غير صالح." });
  try {
    const result = await pool.query("UPDATE xtream_registration_requests SET status = 'rejected' WHERE id = $1 AND status = 'pending' RETURNING id", [req.params.id]);
    if (!result.rowCount) return res.status(404).json({ error: "الطلب غير موجود أو تمت معالجته." });
    res.json({ success: true });
  } catch (error) {
    console.error("Registration rejection failed:", error.message);
    res.status(500).json({ error: "تعذر رفض الطلب." });
  }
});

app.get("/api/xtream/users", requireDatabase, requireAdmin, async (_req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, username, is_active, expires_at, created_at FROM xtream_users ORDER BY created_at DESC"
    );
    res.json(result.rows);
  } catch (error) {
    console.error("Xtream users read failed:", error.message);
    res.status(500).json({ error: "تعذر تحميل الحسابات." });
  }
});

app.post("/api/xtream/users", requireDatabase, requireAdmin, async (req, res) => {
  const { username, password, expires_at = null } = req.body || {};
  if (typeof username !== "string" || !/^[a-zA-Z0-9_.-]{3,32}$/.test(username)) {
    return res.status(400).json({ error: "اسم المستخدم يجب أن يكون 3 إلى 32 حرفًا إنجليزيًا أو رقمًا." });
  }
  if (typeof password !== "string" || password.length < 8 || password.length > 128) {
    return res.status(400).json({ error: "كلمة المرور يجب أن تكون بين 8 و128 حرفًا." });
  }
  let expiry = null;
  if (expires_at !== null && expires_at !== "") {
    expiry = new Date(expires_at);
    if (Number.isNaN(expiry.getTime())) return res.status(400).json({ error: "تاريخ الانتهاء غير صالح." });
  }
  try {
    const { salt, hash } = await hashPassword(password);
    const result = await pool.query(
      "INSERT INTO xtream_users (username, password_salt, password_hash, expires_at) VALUES ($1, $2, $3, $4) RETURNING id, username, is_active, expires_at, created_at",
      [username, salt, hash, expiry]
    );
    res.status(201).json({
      ...result.rows[0],
      server_url: publicBaseUrl(req),
      note: "احفظ كلمة المرور؛ لا يمكن عرضها مرة أخرى."
    });
  } catch (error) {
    if (error.code === "23505") return res.status(409).json({ error: "اسم المستخدم مستخدم بالفعل." });
    console.error("Xtream user create failed:", error.message);
    res.status(500).json({ error: "تعذر إنشاء الحساب." });
  }
});

app.patch("/api/xtream/users/:id", requireDatabase, requireAdmin, async (req, res) => {
  if (!/^\d+$/.test(req.params.id) || typeof req.body?.is_active !== "boolean") {
    return res.status(400).json({ error: "أرسل is_active بقيمة true أو false." });
  }
  try {
    const result = await pool.query(
      "UPDATE xtream_users SET is_active = $1 WHERE id = $2 RETURNING id, username, is_active, expires_at",
      [req.body.is_active, req.params.id]
    );
    if (!result.rowCount) return res.status(404).json({ error: "الحساب غير موجود." });
    res.json(result.rows[0]);
  } catch (error) {
    console.error("Xtream user update failed:", error.message);
    res.status(500).json({ error: "تعذر تحديث الحساب." });
  }
});

app.get("/player_api.php", requireDatabase, async (req, res) => {
  try {
    const user = await findXtreamUser(req.query.username, req.query.password);
    if (!user) return res.status(401).json({ user_info: { auth: 0, status: "Disabled" }, server_info: serverInfo(req) });
    const userInfo = xtreamUserInfo(user);
    const action = String(req.query.action || "");
    if (!action) return res.json({ user_info: userInfo, server_info: serverInfo(req) });

    if (action === "get_vod_categories") {
      const result = await pool.query("SELECT DISTINCT category FROM content WHERE type = 'movie' ORDER BY category");
      return res.json(result.rows.map(row => ({ category_id: row.category, category_name: row.category, parent_id: 0 })));
    }
    if (action === "get_series_categories") {
      const result = await pool.query("SELECT DISTINCT category FROM content WHERE type = 'series' ORDER BY category");
      return res.json(result.rows.map(row => ({ category_id: row.category, category_name: row.category, parent_id: 0 })));
    }
    if (action === "get_live_categories") {
      return res.json([{ category_id: "3", category_name: "البث المباشر", parent_id: 0 }]);
    }
    if (action === "get_live_streams") {
      const result = await pool.query(
        "SELECT id, title, poster, description, created_at FROM content WHERE type = 'live' ORDER BY created_at DESC"
      );
      return res.json(result.rows.map(item => ({
        num: Number(item.id),
        name: item.title,
        title: item.title,
        stream_type: "live",
        stream_id: Number(item.id),
        stream_icon: item.poster || "",
        thumbnail: item.poster || "",
        category_id: "3",
        category_name: "البث المباشر",
        epg_channel_id: "",
        added: Math.floor(new Date(item.created_at).getTime() / 1000),
        is_adult: 0,
        tv_archive: 0,
        tv_archive_duration: 0,
        container_extension: "m3u8",
        direct_source: ""
      })));
    }
    if (action === "get_live_info") {
      const id = String(req.query.stream_id || req.query.id || "");
      if (!/^\\d+$/.test(id)) return res.status(400).json({ error: "معرّف القناة غير صالح." });
      const result = await pool.query(
        "SELECT id, title, poster, description FROM content WHERE id = $1 AND type = 'live'",
        [id]
      );
      const item = result.rows[0];
      if (!item) return res.status(404).json({ error: "القناة غير موجودة." });
      return res.json({ info: { name: item.title, title: item.title, cover: item.poster || "", cover_big: item.poster || "", plot: item.description || "" } });
    }
    if (action === "get_vod_streams" || action === "get_series") {
      const type = action === "get_vod_streams" ? "movie" : "series";
      const result = await pool.query(
        "SELECT id, title, poster, description, category, created_at FROM content WHERE type = $1 ORDER BY created_at DESC",
        [type]
      );
      return res.json(result.rows.map(item => ({
        num: Number(item.id),
        name: item.title,
        title: item.title,
        stream_type: type === "movie" ? "movie" : "series",
        stream_id: Number(item.id),
        stream_icon: item.poster || "",
        cover: item.poster || "",
        plot: item.description || "",
        category_id: item.category || "عام",
        category_name: item.category || "عام",
        container_extension: "mp4",
        added: Math.floor(new Date(item.created_at).getTime() / 1000),
        direct_source: ""
      })));
    }
    if (action === "get_vod_info" || action === "get_series_info") {
      const type = action === "get_vod_info" ? "movie" : "series";
      const id = String(req.query.vod_id || req.query.series_id || "");
      if (!/^\d+$/.test(id)) return res.status(400).json({ error: "معرّف المحتوى غير صالح." });
      const result = await pool.query(
        "SELECT id, title, poster, stream, description, created_at FROM content WHERE id = $1 AND type = $2",
        [id, type]
      );
      const item = result.rows[0];
      if (!item) return res.status(404).json({ error: "المحتوى غير موجود." });
      if (type === "movie") {
        return res.json({
          info: { movie_image: item.poster || "", cover_big: item.poster || "", plot: item.description || "", name: item.title, releasedate: "", duration_secs: 0 },
          movie_data: { stream_id: Number(item.id), name: item.title, title: item.title, container_extension: "mp4", added: Math.floor(new Date(item.created_at).getTime() / 1000) }
        });
      }
      const seasonResult = await pool.query(
        "SELECT s.id, s.season_number, s.title, e.id AS episode_id, e.episode_number, e.title AS episode_title, e.stream FROM series_seasons s LEFT JOIN series_episodes e ON e.season_id = s.id WHERE s.series_id = $1 ORDER BY s.season_number, e.episode_number",
        [id]
      );
      const episodes = {};
      const seasons = [];
      for (const row of seasonResult.rows) {
        const seasonKey = String(row.season_number);
        if (!episodes[seasonKey]) {
          episodes[seasonKey] = [];
          seasons.push({ air_date: "", episode_count: 0, id: Number(row.id), name: row.title, overview: "", season_number: Number(row.season_number), cover: "" });
        }
        if (row.episode_id) {
          episodes[seasonKey].push({
            id: Number(row.episode_id), episode_num: Number(row.episode_number),
            title: row.episode_title, container_extension: "mp4",
            info: { movie_image: "", plot: "", duration_secs: 0 },
            custom_sid: "", added: Math.floor(Date.now() / 1000),
            direct_source: row.stream
          });
          seasons[seasons.length - 1].episode_count++;
        }
      }
      return res.json({
        info: { cover: item.poster || "", plot: item.description || "", name: item.title, releaseDate: "" },
        episodes, seasons
      });
    }
    return res.status(400).json({ error: "إجراء Xtream Codes غير مدعوم." });
  } catch (error) {
    console.error("Xtream player API failed:", error.message);
    res.status(500).json({ error: "حدث خطأ في واجهة Xtream Codes." });
  }
});

app.get("/get.php", requireDatabase, async (req, res) => {
  try {
    const user = await findXtreamUser(req.query.username, req.query.password);
    if (!user) return res.status(401).send("Invalid username or password");
    const result = await pool.query("SELECT id, type, title, poster, category FROM content WHERE type IN ('movie', 'live') ORDER BY type, title");
    const username = String(req.query.username);
    const password = String(req.query.password);
    const lines = ["#EXTM3U"];
    for (const item of result.rows) {
      const isLive = item.type === "live";
      const group = isLive ? "البث المباشر" : "الأفلام - " + (item.category || "عام");
      lines.push("#EXTINF:-1 tvg-logo=\"" + (item.poster || "") + "\" group-title=\"" + group + "\"," + item.title);
      lines.push(isLive
        ? publicBaseUrl(req) + "/live/" + encodeURIComponent(username) + "/" + encodeURIComponent(password) + "/" + item.id + ".m3u8"
        : xtreamStreamUrl(req, "movie", username, password, item.id));
    }
    const episodeRows = await pool.query("SELECT e.id, e.episode_number, e.title, c.title AS series_title, c.category, c.poster FROM series_episodes e JOIN series_seasons s ON s.id = e.season_id JOIN content c ON c.id = s.series_id WHERE c.type = 'series' ORDER BY c.title, s.season_number, e.episode_number");
    for (const episode of episodeRows.rows) {
      const group = ("المسلسلات - " + (episode.category || "عام") + " - " + episode.series_title).replace(/"/g, "");
      const title = episode.series_title + " · الحلقة " + episode.episode_number + " · " + episode.title;
      lines.push("#EXTINF:-1 tvg-logo=\"" + (episode.poster || "") + "\" group-title=\"" + group + "\"," + title);
      lines.push(publicBaseUrl(req) + "/series/" + encodeURIComponent(username) + "/" + encodeURIComponent(password) + "/" + episode.id + ".mp4");
    }
    res.type("application/x-mpegURL").send(lines.join("\n"));
  } catch (error) {
    console.error("M3U playlist failed:", error.message);
    res.status(500).send("Playlist unavailable");
  }
});

async function handleXtreamPlayback(req, res, type) {
  try {
    const user = await findXtreamUser(req.params.username, req.params.password);
    if (!user) return res.status(401).send("Invalid username or password");
    if (!/^\d+$/.test(req.params.id)) return res.status(400).send("Invalid stream id");
    const result = await pool.query(
      "SELECT stream FROM content WHERE id = $1 AND type = $2",
      [req.params.id, type]
    );
    const stream = result.rows[0]?.stream;
    if (!stream || !/^https?:\/\//i.test(stream)) {
      return res.status(404).send("Stream is not configured for this item");
    }
    return res.redirect(302, stream);
  } catch (error) {
    console.error("Xtream playback failed:", error.message);
    res.status(500).send("Playback unavailable");
  }
}
let offlineSequence = Math.floor(Date.now() / 1000);

function makeOfflinePlaylist(req) {
  const sequence = ++offlineSequence;
  const base = publicBaseUrl(req);
  return [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    "#EXT-X-TARGETDURATION:1",
    "#EXT-X-MEDIA-SEQUENCE:" + sequence,
    "#EXTINF:1.0,",
    base + "/offline/wait.ts?seq=" + sequence,
    "#EXTINF:1.0,",
    base + "/offline/wait.ts?seq=" + (sequence + 1),
    "#EXTINF:1.0,",
    base + "/offline/wait.ts?seq=" + (sequence + 2)
  ].join("\n");
}

const liveAllowedOrigins = new Map();

function rewriteLivePlaylist(playlist, sourceUrl, req, username, password, id) {
  const originKey = String(username) + ":" + String(id);
  const allowedOrigins = new Set(liveAllowedOrigins.get(originKey) || []);
  try { allowedOrigins.add(new URL(sourceUrl).origin); } catch (_error) {}
  const base = publicBaseUrl(req);
  const proxyTarget = target => {
    try {
      const resolved = new URL(target, sourceUrl);
      if (!["http:", "https:"].includes(resolved.protocol)) return target;
      allowedOrigins.add(resolved.origin);
      liveAllowedOrigins.set(originKey, allowedOrigins);
      return base + "/live-resource/" + encodeURIComponent(username) + "/" +
        encodeURIComponent(password) + "/" + id + "?target=" + encodeURIComponent(resolved.href);
    } catch (_error) {
      return target;
    }
  };
  return playlist.split(/\r?\n/).map(line => {
    const trimmed = line.trim();
    if (!trimmed) return line;
    if (trimmed.startsWith("#")) {
      return line.replace(/URI="([^"]+)"/g, (_match, uri) => 'URI="' + proxyTarget(uri) + '"');
    }
    return proxyTarget(trimmed);
  }).join("\n");
}

app.get("/live/:username/:password/:id.m3u8", requireDatabase, async (req, res) => {
  try {
    const user = await findXtreamUser(req.params.username, req.params.password);
    if (!user) return res.status(401).send("Invalid username or password");
    if (!/^\d+$/.test(req.params.id)) return res.status(400).send("Invalid stream id");
    const result = await pool.query("SELECT stream FROM content WHERE id = $1 AND type = 'live'", [req.params.id]);
    const stream = result.rows[0]?.stream;
    if (!stream || !/^https?:\/\//i.test(stream)) return res.status(404).send("Live channel not found");

    const upstream = await fetch(stream, { redirect: "follow", signal: AbortSignal.timeout(10000) });
    if (!upstream.ok) {
      if (upstream.body) await upstream.body.cancel().catch(() => {});
      return res.status(200).type("application/vnd.apple.mpegurl")
        .set("Cache-Control", "no-store, no-cache, must-revalidate")
        .send(makeOfflinePlaylist(req));
    }
    const contentType = upstream.headers.get("content-type") || "";
    const isPlaylist = contentType.toLowerCase().includes("mpegurl") || /\.m3u8(?:$|\?)/i.test(stream);
    if (!isPlaylist) {
      if (upstream.body) await upstream.body.cancel().catch(() => {});
      return res.status(415).send("Live source must be an HLS M3U8 playlist");
    }
    const playlist = await upstream.text();
    if (!playlist.trimStart().startsWith("#EXTM3U")) {
      return res.status(502).send("Invalid upstream HLS playlist");
    }
    const rewritten = rewriteLivePlaylist(playlist, upstream.url || stream, req, req.params.username, req.params.password, req.params.id);
    return res.status(200).type("application/vnd.apple.mpegurl")
      .set("Cache-Control", "no-store, no-cache, must-revalidate")
      .send(rewritten);
  } catch (_error) {
    return res.status(200).type("application/vnd.apple.mpegurl")
      .set("Cache-Control", "no-store, no-cache, must-revalidate")
      .send(makeOfflinePlaylist(req));
  }
});

app.get("/live-resource/:username/:password/:id", requireDatabase, async (req, res) => {
  let playlistTarget = false;
  try {
    const user = await findXtreamUser(req.params.username, req.params.password);
    if (!user) return res.status(401).send("Invalid username or password");
    if (!/^\d+$/.test(req.params.id)) return res.status(400).send("Invalid stream id");
    const result = await pool.query("SELECT stream FROM content WHERE id = $1 AND type = 'live'", [req.params.id]);
    const stream = result.rows[0]?.stream;
    const target = new URL(String(req.query.target || ""));
    playlistTarget = /\.m3u8(?:$|\?)/i.test(target.href);
    const source = new URL(String(stream || ""));
    const allowedOrigins = liveAllowedOrigins.get(String(req.params.username) + ":" + String(req.params.id)) || new Set([source.origin]);
    if (!["http:", "https:"].includes(target.protocol) || !allowedOrigins.has(target.origin)) {
      return res.status(403).send("Invalid live resource URL");
    }
    const headers = {};
    if (req.get("range")) headers.Range = req.get("range");
    const upstream = await fetch(target.href, { headers, redirect: "follow", signal: AbortSignal.timeout(15000) });
    if (!upstream.ok) {
      if (playlistTarget) return res.status(200).type("application/vnd.apple.mpegurl").set("Cache-Control", "no-store").send(makeOfflinePlaylist(req));
      return res.status(upstream.status).send("Live resource unavailable");
    }
    const contentType = upstream.headers.get("content-type") || "";
    if (contentType.toLowerCase().includes("mpegurl") || playlistTarget) {
      const playlist = await upstream.text();
      return res.status(200).type("application/vnd.apple.mpegurl")
        .set("Cache-Control", "no-store")
        .send(rewriteLivePlaylist(playlist, upstream.url || target.href, req, req.params.username, req.params.password, req.params.id));
    }
    const bytes = Buffer.from(await upstream.arrayBuffer());
    res.status(upstream.status)
      .set("Content-Type", contentType || "video/mp2t")
      .set("Cache-Control", "no-store")
      .send(bytes);
  } catch (_error) {
    if (playlistTarget) return res.status(200).type("application/vnd.apple.mpegurl").set("Cache-Control", "no-store").send(makeOfflinePlaylist(req));
    res.status(502).send("Live resource proxy failed");
  }
});


const TWITCH2_SOURCE = "https://live-jzc6.onrender.com/live/twitch/index.m3u8";
const TWITCH2_HOST = new URL(TWITCH2_SOURCE).hostname;

function makeTwitch2OfflinePlaylist(req) {
  const base = publicBaseUrl(req);
  const sequence = Math.floor(Date.now() / 1000);
  return [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    "#EXT-X-TARGETDURATION:1",
    "#EXT-X-MEDIA-SEQUENCE:" + sequence,
    "#EXTINF:1.0,",
    base + "/offline/wait.ts?seq=" + sequence,
    "#EXTINF:1.0,",
    base + "/offline/wait.ts?seq=" + (sequence + 1),
    "#EXTINF:1.0,",
    base + "/offline/wait.ts?seq=" + (sequence + 2)
  ].join("\n");
}

function rewriteTwitch2Playlist(playlist, sourceUrl, req) {
  const base = publicBaseUrl(req);
  const proxy = value => {
    try {
      const target = new URL(value, sourceUrl);
      if (!["http:", "https:"].includes(target.protocol) || target.hostname !== TWITCH2_HOST) return value;
      return base + "/twitch2-resource?target=" + encodeURIComponent(target.href);
    } catch (_error) {
      return value;
    }
  };
  return playlist.split(/\r?\n/).map(line => {
    const trimmed = line.trim();
    if (!trimmed) return line;
    if (trimmed.startsWith("#")) {
      return line.replace(/URI="([^"]+)"/g, (_match, uri) => 'URI="' + proxy(uri) + '"');
    }
    return proxy(trimmed);
  }).join("\n");
}

app.get("/twitch2.m3u8", async (req, res) => {
  try {
    const upstream = await fetch(TWITCH2_SOURCE, { redirect: "follow", signal: AbortSignal.timeout(10000) });
    if (!upstream.ok) {
      if (upstream.body) await upstream.body.cancel().catch(() => {});
      return res.status(200).type("application/vnd.apple.mpegurl")
        .set("Cache-Control", "no-store, no-cache, must-revalidate")
        .send(makeTwitch2OfflinePlaylist(req));
    }
    const finalUrl = new URL(upstream.url || TWITCH2_SOURCE);
    if (finalUrl.hostname !== TWITCH2_HOST) {
      if (upstream.body) await upstream.body.cancel().catch(() => {});
      return res.status(502).send("Unexpected Twitch2 source host");
    }
    const playlist = await upstream.text();
    if (!playlist.trimStart().startsWith("#EXTM3U")) {
      return res.status(502).send("Invalid Twitch2 HLS playlist");
    }
    return res.status(200).type("application/vnd.apple.mpegurl")
      .set("Cache-Control", "no-store, no-cache, must-revalidate")
      .send(rewriteTwitch2Playlist(playlist, finalUrl.href, req));
  } catch (_error) {
    return res.status(200).type("application/vnd.apple.mpegurl")
      .set("Cache-Control", "no-store, no-cache, must-revalidate")
      .send(makeTwitch2OfflinePlaylist(req));
  }
});

app.get("/twitch2-resource", async (req, res) => {
  try {
    const target = new URL(String(req.query.target || ""));
    if (!["http:", "https:"].includes(target.protocol) || target.hostname !== TWITCH2_HOST) {
      return res.status(403).send("Invalid Twitch2 resource URL");
    }
    const headers = {};
    if (req.get("range")) headers.Range = req.get("range");
    const upstream = await fetch(target.href, { headers, redirect: "follow", signal: AbortSignal.timeout(15000) });
    const finalUrl = new URL(upstream.url || target.href);
    if (finalUrl.hostname !== TWITCH2_HOST) {
      if (upstream.body) await upstream.body.cancel().catch(() => {});
      return res.status(502).send("Unexpected Twitch2 resource host");
    }
    if (!upstream.ok) return res.status(upstream.status).send("Twitch2 resource unavailable");
    const contentType = upstream.headers.get("content-type") || "";
    if (contentType.toLowerCase().includes("mpegurl") || /\.m3u8(?:$|\?)/i.test(finalUrl.href)) {
      const playlist = await upstream.text();
      if (!playlist.trimStart().startsWith("#EXTM3U")) return res.status(502).send("Invalid Twitch2 HLS playlist");
      return res.status(200).type("application/vnd.apple.mpegurl")
        .set("Cache-Control", "no-store")
        .send(rewriteTwitch2Playlist(playlist, finalUrl.href, req));
    }
    const bytes = Buffer.from(await upstream.arrayBuffer());
    return res.status(upstream.status)
      .set("Content-Type", contentType || "video/mp2t")
      .set("Cache-Control", "no-store")
      .send(bytes);
  } catch (_error) {
    return res.status(502).send("Twitch2 resource proxy failed");
  }
});

app.get("/movie/:username/:password/:id", requireDatabase, (req, res) => handleXtreamPlayback(req, res, "movie"));
app.get("/series/:username/:password/:id.mp4", requireDatabase, async (req, res) => {
  try {
    const user = await findXtreamUser(req.params.username, req.params.password);
    if (!user) return res.status(401).send("Invalid username or password");
    if (!/^\d+$/.test(req.params.id)) return res.status(400).send("Invalid episode id");
    const result = await pool.query("SELECT stream FROM series_episodes WHERE id = $1", [req.params.id]);
    const stream = result.rows[0]?.stream;
    if (!stream || !/^https?:\/\//i.test(stream)) return res.status(404).send("Episode stream not found");
    return res.redirect(302, stream);
  } catch (error) {
    console.error("Series episode playback failed:", error.message);
    res.status(500).send("Playback unavailable");
  }
});
app.get("/series/:username/:password/:id", requireDatabase, (req, res) => handleXtreamPlayback(req, res, "series"));

app.get("/twitch2", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "twitch2.html"));
});

app.get("/{*splat}", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

async function start() {
  void startDiscordBot();
  if (pool) {
    try {
      await pool.query(
        "CREATE TABLE IF NOT EXISTS content (id BIGSERIAL PRIMARY KEY, type VARCHAR(10) NOT NULL CHECK (type IN ('movie', 'series')), title VARCHAR(100) NOT NULL, poster TEXT NOT NULL DEFAULT '', stream TEXT NOT NULL DEFAULT '', description VARCHAR(500) NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())"
      );
      await pool.query("ALTER TABLE content ADD COLUMN IF NOT EXISTS category VARCHAR(60) NOT NULL DEFAULT 'عام'");
      await pool.query("ALTER TABLE content ADD COLUMN IF NOT EXISTS teaser_url TEXT NOT NULL DEFAULT ''");
      await pool.query("CREATE TABLE IF NOT EXISTS series_submissions (id BIGSERIAL PRIMARY KEY, title VARCHAR(120) NOT NULL, category VARCHAR(60) NOT NULL, details VARCHAR(1500) NOT NULL DEFAULT '', poster_url TEXT NOT NULL DEFAULT '', submitter_name VARCHAR(80) NOT NULL DEFAULT '', contact_email VARCHAR(254) NOT NULL DEFAULT '', request_code VARCHAR(16) NOT NULL UNIQUE, status VARCHAR(12) NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'reviewing', 'approved', 'rejected')), email_sent BOOLEAN NOT NULL DEFAULT FALSE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
      await pool.query("ALTER TABLE series_submissions ALTER COLUMN request_code TYPE VARCHAR(16)");
      await pool.query("CREATE TABLE IF NOT EXISTS series_seasons (id BIGSERIAL PRIMARY KEY, series_id BIGINT NOT NULL REFERENCES content(id) ON DELETE CASCADE, season_number INTEGER NOT NULL CHECK (season_number > 0), title VARCHAR(100) NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(series_id, season_number))");
      await pool.query("CREATE TABLE IF NOT EXISTS series_episodes (id BIGSERIAL PRIMARY KEY, season_id BIGINT NOT NULL REFERENCES series_seasons(id) ON DELETE CASCADE, episode_number INTEGER NOT NULL CHECK (episode_number > 0), title VARCHAR(120) NOT NULL, stream TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(season_id, episode_number))");
      await pool.query("ALTER TABLE content DROP CONSTRAINT IF EXISTS content_type_check");
      await pool.query("ALTER TABLE content ADD CONSTRAINT content_type_check CHECK (type IN ('movie', 'series', 'live'))");
      await pool.query(
        "CREATE TABLE IF NOT EXISTS xtream_users (id BIGSERIAL PRIMARY KEY, username VARCHAR(32) NOT NULL UNIQUE, password_salt VARCHAR(64) NOT NULL, password_hash VARCHAR(128) NOT NULL, is_active BOOLEAN NOT NULL DEFAULT TRUE, expires_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())"
      );
      await pool.query(
        "CREATE TABLE IF NOT EXISTS xtream_registration_requests (id BIGSERIAL PRIMARY KEY, username VARCHAR(32) NOT NULL UNIQUE, password_salt VARCHAR(64) NOT NULL, password_hash VARCHAR(128) NOT NULL, status VARCHAR(12) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())"
      );
      try {
        const encodedWaitAsset = path.join(__dirname, "public", "offline", "wait.ts.b64");
        const waitAsset = path.join(__dirname, "public", "offline", "wait.ts");
        if (fs.existsSync(encodedWaitAsset)) {
          const bytes = Buffer.from(fs.readFileSync(encodedWaitAsset, "utf8").trim(), "base64");
          if (bytes[0] !== 0x47) throw new Error("Offline waiting media is not a valid MPEG-TS file.");
          fs.mkdirSync(path.dirname(waitAsset), { recursive: true });
          fs.writeFileSync(waitAsset, bytes);
        }
      } catch (assetError) {
        console.error("Offline waiting screen asset failed:", assetError.message);
      }
      console.log("CASS TV database is ready");
      console.log("CASS TV Xtream Codes API is ready");
    } catch (error) {
      console.error("Database initialization failed:", error.message);
    }
  } else {
    console.log("DATABASE_URL is not configured yet");
  }
  app.listen(PORT, () => console.log("CASS TV is running on port " + PORT));
}

start();
