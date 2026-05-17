require("dotenv").config();
const express = require("express");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { runResearch } = require("./index");

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const CONFIG_PATH = path.join(__dirname, "config.json");
const PENDING_PATH = path.join(__dirname, "custom-research-pending.json");

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

function loadPending() {
  if (!fs.existsSync(PENDING_PATH)) return { hashtags: [], searchTerms: [] };
  return JSON.parse(fs.readFileSync(PENDING_PATH, "utf8"));
}

function savePending(pending) {
  fs.writeFileSync(PENDING_PATH, JSON.stringify(pending, null, 2));
}

// Split raw multiline input into hashtags vs search terms
function parseTermLines(raw) {
  return (raw || "")
    .split("\n")
    .map((t) => t.trim().replace(/^#/, "").toLowerCase())
    .filter(Boolean);
}

// Build the pending-terms preview Slack message (blocks + buttons)
function buildPendingPreview(pending) {
  const allTerms = [...pending.hashtags, ...pending.searchTerms];
  const previewText = allTerms.length
    ? allTerms.map((t) => (t.includes(" ") ? `"${t}"` : `#${t}`)).join("  ")
    : "_No custom terms yet_";

  return {
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Custom Research Terms* (${allTerms.length})\n${previewText}`,
        },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "Edit Terms" },
            action_id: "edit_terms_button",
            style: "primary",
          },
          {
            type: "button",
            text: { type: "plain_text", text: "Run Research Now" },
            action_id: "run_research_button",
            style: "danger",
            confirm: {
              title: { type: "plain_text", text: "Start research run?" },
              text: { type: "mrkdwn", text: "This will kick off a full Apify + Claude run." },
              confirm: { type: "plain_text", text: "Run it" },
              deny: { type: "plain_text", text: "Cancel" },
            },
          },
        ],
      },
    ],
  };
}

// Open the Edit Terms modal using views.open
async function openEditTermsModal(triggerId, pending) {
  const allTerms = [...pending.hashtags, ...pending.searchTerms];
  const currentText = allTerms
    .map((t) => (t.includes(" ") ? t : `#${t}`))
    .join("\n");

  await axios.post(
    "https://slack.com/api/views.open",
    {
      trigger_id: triggerId,
      view: {
        type: "modal",
        callback_id: "edit_terms_modal",
        title: { type: "plain_text", text: "Edit Research Terms" },
        submit: { type: "plain_text", text: "Save" },
        close: { type: "plain_text", text: "Cancel" },
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `Current terms: *${allTerms.length}*\nHashtags use #prefix, multi-word terms are search queries.`,
            },
          },
          {
            type: "input",
            block_id: "add_terms_block",
            optional: true,
            label: { type: "plain_text", text: "Add terms" },
            element: {
              type: "plain_text_input",
              action_id: "add_terms_input",
              multiline: true,
              placeholder: { type: "plain_text", text: "One term per line" },
            },
          },
          {
            type: "input",
            block_id: "remove_terms_block",
            optional: true,
            label: { type: "plain_text", text: "Remove terms" },
            element: {
              type: "plain_text_input",
              action_id: "remove_terms_input",
              multiline: true,
              placeholder: { type: "plain_text", text: "One term per line" },
            },
          },
        ],
      },
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
        "Content-Type": "application/json",
      },
    }
  );
}

// Post updated preview via webhook
async function postPendingPreview(pending) {
  await axios.post(process.env.SLACK_WEBHOOK_URL, buildPendingPreview(pending));
}

// --- Slash commands ---------------------------------------------------------

// POST /tiktok/run — trigger full research run
app.post("/tiktok/run", (req, res) => {
  res.json({ text: "Research started... results will be posted to Slack." });
  runResearch().catch((err) => console.error("Async research run failed:", err));
});

// POST /tiktok/add — add a hashtag to config
app.post("/tiktok/add", (req, res) => {
  const raw = (req.body.text || "").trim().replace(/^#/, "").toLowerCase();
  if (!raw) {
    return res.json({ text: "Please provide a hashtag. Usage: `/tiktok-add <hashtag>`" });
  }
  const config = loadConfig();
  if (config.hashtags.includes(raw)) {
    return res.json({ text: `#${raw} is already in the list.` });
  }
  config.hashtags.push(raw);
  saveConfig(config);
  res.json({ text: `Added #${raw}` });
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

// POST /tiktok/custom — show pending custom terms + Edit Terms button
app.post("/tiktok/custom", (req, res) => {
  const pending = loadPending();
  res.json(buildPendingPreview(pending));
});

// --- Slack interactivity ----------------------------------------------------
// Handles both block_actions (button clicks) and view_submission (modal submit)
// Configure this URL in Slack App > Interactivity & Shortcuts > Request URL:
//   https://<your-domain>/slack/interactions

app.post("/slack/interactions", async (req, res) => {
  let payload;
  try {
    payload = JSON.parse(req.body.payload);
  } catch {
    return res.status(400).send("Bad payload");
  }

  // Button click — open the Edit Terms modal
  if (payload.type === "block_actions") {
    const action = (payload.actions || [])[0];
    if (action?.action_id === "edit_terms_button") {
      res.status(200).send("");
      try {
        await openEditTermsModal(payload.trigger_id, loadPending());
      } catch (err) {
        console.error("Failed to open modal:", err.response?.data || err.message);
      }
      return;
    }

    if (action?.action_id === "run_research_button") {
      res.status(200).send("");
      runResearch().catch((err) => console.error("Async research run failed:", err));
      return;
    }

    return res.status(200).send("");
  }

  // Modal submitted
  if (payload.type === "view_submission" && payload.view?.callback_id === "edit_terms_modal") {
    res.status(200).send("");

    const values = payload.view.state.values;
    const addRaw = values?.add_terms_block?.add_terms_input?.value || "";
    const removeRaw = values?.remove_terms_block?.remove_terms_input?.value || "";

    const toAdd = parseTermLines(addRaw);
    const toRemove = new Set(parseTermLines(removeRaw));

    const pending = loadPending();

    // Add new terms, split into hashtags vs search terms by presence of spaces
    for (const term of toAdd) {
      if (term.includes(" ")) {
        if (!pending.searchTerms.includes(term)) pending.searchTerms.push(term);
      } else {
        if (!pending.hashtags.includes(term)) pending.hashtags.push(term);
      }
    }

    // Remove terms from both lists
    pending.hashtags = pending.hashtags.filter((t) => !toRemove.has(t));
    pending.searchTerms = pending.searchTerms.filter((t) => !toRemove.has(t));

    savePending(pending);
    console.log(`Pending terms updated — added: ${toAdd.length}, removed: ${toRemove.size}`);

    try {
      await postPendingPreview(pending);
    } catch (err) {
      console.error("Failed to post pending preview:", err.message);
    }
    return;
  }

  res.status(200).send("");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`TikTok Slack bot server running on port ${PORT}`));
