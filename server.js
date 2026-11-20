const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/health", (_req, res) => {
  res.json({
    success: true,
    app: "CASS TV",
    status: "running"
  });
});

app.get("/api", (_req, res) => {
  res.json({
    name: "CASS TV API",
    version: "1.0.0",
    status: "in development"
  });
});

app.get("/{*splat}", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`CASS TV is running on port ${PORT}`);
});
