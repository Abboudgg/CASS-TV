const express = require("express");
const path = require("path");
const fs = require("fs");
const { Pool } = require("pg");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;
const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false }
    })
  : null;

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

function requireAdmin(req, res, next) {
  const expected = process.env.ADMIN_API_KEY || "";
  const supplied = req.get("x-admin-key") || "";
  const a = Buffer.from(expected);
  const b = Buffer.from(supplied);
  if (!expected || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: "مفتاح الإدارة غير صحيح أو غير مضبوط." });
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

app.get("/admin", (_req, res) => {
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
      "SELECT id, type, title, poster, stream, description, created_at FROM content ORDER BY created_at DESC"
    );
    res.json(result.rows);
  } catch (error) {
    console.error("Content read failed:", error.message);
    res.status(500).json({ error: "تعذر تحميل المحتوى." });
  }
});

app.post("/api/content", requireDatabase, requireAdmin, async (req, res) => {
  const { type, title, poster = "", stream = "", description = "" } = req.body || {};
  if (!["movie", "series", "live"].includes(type) || typeof title !== "string" || !title.trim()) {
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
      "INSERT INTO content (type, title, poster, stream, description) VALUES ($1, $2, $3, $4, $5) RETURNING id, type, title, poster, stream, description, created_at",
      [type, title.trim().slice(0, 100), String(poster).slice(0, 1000), String(stream).slice(0, 2000), String(description).slice(0, 500)]
    );
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
      return res.json([{ category_id: "1", category_name: "الأفلام", parent_id: 0 }]);
    }
    if (action === "get_series_categories") {
      return res.json([{ category_id: "2", category_name: "المسلسلات", parent_id: 0 }]);
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
        "SELECT id, title, poster, description, created_at FROM content WHERE type = $1 ORDER BY created_at DESC",
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
        category_id: type === "movie" ? "1" : "2",
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
      return res.json({
        info: { cover: item.poster || "", plot: item.description || "", name: item.title, releaseDate: "" },
        episodes: {},
        seasons: []
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
    const result = await pool.query("SELECT id, type, title, poster FROM content WHERE type IN ('movie', 'live') ORDER BY type, title");
    const username = String(req.query.username);
    const password = String(req.query.password);
    const lines = ["#EXTM3U"];
    for (const item of result.rows) {
      const isLive = item.type === "live";
      lines.push("#EXTINF:-1 tvg-logo=\"" + (item.poster || "") + "\" group-title=\"" + (isLive ? "Live" : "Movies") + "\"," + item.title);
      lines.push(isLive
        ? publicBaseUrl(req) + "/live/" + encodeURIComponent(username) + "/" + encodeURIComponent(password) + "/" + item.id + ".m3u8"
        : xtreamStreamUrl(req, "movie", username, password, item.id));
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

function rewriteLivePlaylist(playlist, sourceUrl, req, username, password, id) {
  const base = publicBaseUrl(req);
  const proxyTarget = target => {
    try {
      const resolved = new URL(target, sourceUrl);
      if (!["http:", "https:"].includes(resolved.protocol)) return target;
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
    if (!["http:", "https:"].includes(target.protocol) || target.origin !== source.origin) {
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

app.get("/movie/:username/:password/:id", requireDatabase, (req, res) => handleXtreamPlayback(req, res, "movie"));
app.get("/series/:username/:password/:id", requireDatabase, (req, res) => handleXtreamPlayback(req, res, "series"));

app.get("/{*splat}", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

async function start() {
  if (pool) {
    try {
      await pool.query(
        "CREATE TABLE IF NOT EXISTS content (id BIGSERIAL PRIMARY KEY, type VARCHAR(10) NOT NULL CHECK (type IN ('movie', 'series')), title VARCHAR(100) NOT NULL, poster TEXT NOT NULL DEFAULT '', stream TEXT NOT NULL DEFAULT '', description VARCHAR(500) NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())"
      );
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
