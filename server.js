require("dotenv").config();
const express = require("express");
const fs = require("fs");
const path = require("path");
const { runResearch } = require("./index");

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const CONFIG_PATH = path.join(__dirname, "config.json");

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

// POST /tiktok/run — trigger full research run
app.post("/tiktok/run", (req, res) => {
  res.json({ text: "🔄 Research started… results will be posted to Slack." });
  runResearch().catch((err) => console.error("Async research run failed:", err));
});

// POST /tiktok/add — add a hashtag
app.post("/tiktok/add", (req, res) => {
  const raw = (req.body.text || "").trim().replace(/^#/, "").toLowerCase();
  if (!raw) {
    return res.json({ text: "❌ Please provide a hashtag. Usage: `/tiktok/add <hashtag>`" });
  }

  const config = loadConfig();
  if (config.hashtags.includes(raw)) {
    return res.json({ text: `ℹ️ #${raw} is already in the list.` });
  }

  config.hashtags.push(raw);
  saveConfig(config);
  res.json({ text: `✅ Added #${raw}` });
});

// POST /tiktok/list — list current hashtags
app.post("/tiktok/list", (req, res) => {
  const config = loadConfig();
  const tags = config.hashtags.map((h) => `#${h}`).join("  ");
  const terms = config.searchTerms.map((t) => `"${t}"`).join(", ");
  res.json({
    text: `*Hashtags (${config.hashtags.length}):*\n${tags}\n\n*Search Terms (${config.searchTerms.length}):*\n${terms}`,
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`TikTok Slack bot server running on port ${PORT}`));
