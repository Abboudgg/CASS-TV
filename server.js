const express = require("express");
const path = require("path");
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
  const expectedBuffer = Buffer.from(expected);
  const suppliedBuffer = Buffer.from(supplied);
  if (!expected || expectedBuffer.length !== suppliedBuffer.length ||
      !crypto.timingSafeEqual(expectedBuffer, suppliedBuffer)) {
    return res.status(401).json({ error: "مفتاح الإدارة غير صحيح أو غير مضبوط." });
  }
  next();
}

function requireDatabase(req, res, next) {
  if (!pool) return res.status(503).json({ error: "قاعدة البيانات غير مربوطة بعد. أضف DATABASE_URL في إعدادات الاستضافة." });
  next();
}

app.get("/admin", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

app.get("/api/health", (_req, res) => {
  res.json({ success: true, app: "CASS TV", status: "running", databaseConfigured: Boolean(pool) });
});

app.get("/api", (_req, res) => {
  res.json({ name: "CASS TV API", version: "1.0.0", status: "in development" });
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
  if (!["movie", "series"].includes(type) || typeof title !== "string" || !title.trim()) {
    return res.status(400).json({ error: "نوع المحتوى والاسم مطلوبان." });
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

app.get("/{*splat}", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

async function start() {
  if (pool) {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS content (
          id BIGSERIAL PRIMARY KEY,
          type VARCHAR(10) NOT NULL CHECK (type IN ('movie', 'series')),
          title VARCHAR(100) NOT NULL,
          poster TEXT NOT NULL DEFAULT '',
          stream TEXT NOT NULL DEFAULT '',
          description VARCHAR(500) NOT NULL DEFAULT '',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      console.log("CASS TV database is ready");
    } catch (error) {
      console.error("Database initialization failed:", error.message);
    }
  } else {
    console.log("DATABASE_URL is not configured yet");
  }

  app.listen(PORT, () => console.log(`CASS TV is running on port ${PORT}`));
}

start();
