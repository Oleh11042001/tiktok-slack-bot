require("dotenv").config();
const Anthropic = require("@anthropic-ai/sdk");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const CONFIG_PATH = path.join(__dirname, "config.json");

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
}

// --- Apify ------------------------------------------------------------------

async function runApify(hashtags, searchQueries, resultsPerPage) {
  const token = process.env.APIFY_API_TOKEN;
  const runUrl = `https://api.apify.com/v2/acts/clockworks~tiktok-scraper/runs?token=${token}`;

  const runRes = await axios.post(runUrl, {
    hashtags,
    searchQueries,
    resultsPerPage,
    shouldDownloadVideos: false,
    shouldDownloadCovers: false,
  });

  const runId = runRes.data.data.id;
  console.log(`Apify run started: ${runId}`);

  for (let i = 0; i < 60; i++) {
    await sleep(10000);
    const statusRes = await axios.get(
      `https://api.apify.com/v2/acts/clockworks~tiktok-scraper/runs/${runId}?token=${token}`
    );
    const status = statusRes.data.data.status;
    console.log(`  Run ${runId} status: ${status}`);
    if (status === "SUCCEEDED") break;
    if (["FAILED", "ABORTED", "TIMED-OUT"].includes(status)) {
      throw new Error(`Apify run ${runId} ended with status: ${status}`);
    }
  }

  const runInfo = await axios.get(
    `https://api.apify.com/v2/acts/clockworks~tiktok-scraper/runs/${runId}?token=${token}`
  );
  const datasetId = runInfo.data.data.defaultDatasetId;

  const itemsRes = await axios.get(
    `https://api.apify.com/v2/datasets/${datasetId}/items?token=${token}&limit=5000`
  );
  return itemsRes.data;
}

function extractVideoFields(raw) {
  return {
    id: raw.id,
    text: raw.text || "",
    authorName: raw.authorMeta?.name || "",
    authorId: raw.authorMeta?.id || "",
    duration: raw.videoMeta?.duration || 0,
    playCount: raw.playCount || 0,
    diggCount: raw.diggCount || 0,
    commentCount: raw.commentCount || 0,
    shareCount: raw.shareCount || 0,
    webVideoUrl: raw.webVideoUrl || "",
    hashtags: (raw.hashtags || []).map((h) => h.name || h),
    createTime: raw.createTime || 0,
  };
}

function dedupeVideos(videos) {
  const seen = new Set();
  return videos.filter((v) => {
    if (seen.has(v.id)) return false;
    seen.add(v.id);
    return true;
  });
}

// --- Claude helpers ---------------------------------------------------------

async function claudePreSnowball(sampleVideos) {
  const prompt = `You are a TikTok trend researcher focused on Health, Fitness, and Mental Health content for a Tier 1 English-speaking audience (US, UK, AU, CA).

Here is a sample of currently trending TikTok videos (descriptions and hashtags):
${sampleVideos
    .slice(0, 50)
    .map((v) => `- "${v.text}" | hashtags: ${v.hashtags.join(", ")}`)
    .join("\n")}

Based on these trending videos, identify 10 additional hashtags or search terms that are emerging or highly relevant right now but are NOT already in this list:
${sampleVideos
    .flatMap((v) => v.hashtags)
    .slice(0, 30)
    .join(", ")}

Return ONLY a JSON array of 10 strings. No explanation. Example:
["term1", "term2", "term3"]`;

  const msg = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 512,
    messages: [{ role: "user", content: prompt }],
  });

  const text = msg.content[0].text.trim();
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) throw new Error("Claude pre-snowball returned unexpected format");
  return JSON.parse(match[0]);
}

async function claudePostSnowball(allVideos) {
  const topVideos = allVideos.slice(0, 80);
  const prompt = `You are a TikTok trend researcher. Review these top-performing TikTok videos and identify any UNEXPECTED emerging topics that are not already covered by standard health/fitness/mental-health hashtags.

Videos:
${topVideos
    .map((v) => `- "${v.text}" | views: ${v.playCount} | hashtags: ${v.hashtags.join(", ")}`)
    .join("\n")}

Return ONLY a JSON array of up to 5 additional search queries or hashtags worth collecting. Return empty array [] if nothing new. No explanation.`;

  const msg = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 256,
    messages: [{ role: "user", content: prompt }],
  });

  const text = msg.content[0].text.trim();
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return [];
  return JSON.parse(match[0]);
}

function sanitizeText(str, maxLen) {
  if (!str) return "";
  // Remove control characters (0x00-0x1F except tab) and truncate
  return str.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, " ").slice(0, maxLen);
}

async function claudeAnalyze(videos) {
  const videoData = videos.slice(0, 100).map((v) => ({
    text: sanitizeText(v.text, 200),
    url: v.webVideoUrl,
    views: v.playCount,
    likes: v.diggCount,
    author: sanitizeText(v.authorName, 50),
    hashtags: v.hashtags.slice(0, 10),
  }));

  const prompt = `You are an expert TikTok content strategist analyzing viral health, fitness, and mental health content for a Tier 1 English-speaking audience.

Analyze these ${videoData.length} top-performing TikTok videos and return a JSON object. CRITICAL: all string values must be valid JSON — no literal newlines inside strings, no unescaped double quotes, no control characters.

Return exactly this structure:
{
  "summary": "3-4 sentences overview",
  "trending_topics": [
    { "topic": "name", "momentum": "new|growing|stable", "total_views": 0, "description": "1-2 sentences max", "top_videos": [{"title": "max 60 chars", "url": "", "views": 0, "likes": 0}, {"title": "", "url": "", "views": 0, "likes": 0}] }
  ],
  "viral_hooks": [
    { "hook": "exact pattern", "why_it_works": "1 sentence", "examples": [{"text": "max 60 chars", "url": "", "views": 0}, {"text": "", "url": "", "views": 0}] }
  ],
  "positioning_opportunities": [
    { "theme": "name", "trend": "new|growing|stable", "description": "1-2 sentences", "why_it_works": "1 sentence", "videos": [{"text": "max 60 chars", "url": "", "views": 0, "author": ""}, {"text": "", "url": "", "views": 0, "author": ""}] }
  ],
  "audience_language": [
    { "phrase": "exact phrase", "meaning": "1 sentence", "usage_context": "1 sentence" }
  ],
  "emerging_creators": [
    { "angle": "what makes them unique", "pattern": "1-2 sentences" }
  ]
}

Counts: exactly 8 trending_topics, 6 viral_hooks, 6 positioning_opportunities, 8 audience_language, 4 emerging_creators.
Return ONLY the raw JSON object. No markdown fences, no explanation.

VIDEO DATA:
${JSON.stringify(videoData)}`;

  const msg = await anthropic.messages.create(
    {
      model: "claude-sonnet-4-6",
      max_tokens: 16000,
      messages: [{ role: "user", content: prompt }],
    },
    { headers: { "anthropic-beta": "output-128k-2025-02-19" } }
  );

  const raw = msg.content[0].text.trim();
  const jsonStart = raw.indexOf("{");
  const jsonEnd = raw.lastIndexOf("}");
  if (jsonStart === -1) throw new Error("Claude analysis returned no JSON");
  const jsonStr = raw.slice(jsonStart, jsonEnd + 1);

  try {
    return JSON.parse(jsonStr);
  } catch (e) {
    // Strip control characters and retry
    const cleaned = jsonStr.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, " ");
    return JSON.parse(cleaned);
  }
}

// --- Slack ------------------------------------------------------------------

function truncate(str, len) {
  if (!str) return "";
  return str.length > len ? str.slice(0, len - 1) + "..." : str;
}

function formatNum(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(n);
}

function videoLink(video) {
  const label = truncate(video.title || video.text || "Watch video", 60);
  return `<${video.url}|${label}> (views: ${formatNum(video.views)})`;
}

function buildMessage1(analysis) {
  const blocks = [
    {
      type: "header",
      text: { type: "plain_text", text: "TikTok Weekly Research Report" },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: `*Summary*\n${analysis.summary}` },
    },
    { type: "divider" },
    {
      type: "section",
      text: { type: "mrkdwn", text: "*Trending Topics*" },
    },
  ];

  for (const topic of analysis.trending_topics) {
    const momentumLabel = { new: "[NEW]", growing: "[GROWING]", stable: "[STABLE]" }[topic.momentum] || "";
    const links = (topic.top_videos || [])
      .slice(0, 2)
      .map((v) => videoLink(v))
      .join("\n");
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${momentumLabel} *${topic.topic}* — ${formatNum(topic.total_views)} total views\n${topic.description}${links ? "\n" + links : ""}`,
      },
    });
  }

  return { blocks };
}

function buildMessage2(analysis) {
  const blocks = [
    {
      type: "header",
      text: { type: "plain_text", text: "Viral Hooks & Audience Language" },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: "*Viral Hook Patterns*" },
    },
  ];

  for (const hook of analysis.viral_hooks) {
    const examples = (hook.examples || [])
      .slice(0, 2)
      .map((e) => videoLink(e))
      .join("\n");
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*"${hook.hook}"*\n_Why it works:_ ${hook.why_it_works}${examples ? "\n" + examples : ""}`,
      },
    });
  }

  blocks.push({ type: "divider" });
  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: "*Audience Language*" },
  });

  for (const phrase of analysis.audience_language) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*"${phrase.phrase}"*\n_Meaning:_ ${phrase.meaning}\n_When used:_ ${phrase.usage_context}`,
      },
    });
  }

  return { blocks };
}

function buildMessage3(analysis) {
  const blocks = [
    {
      type: "header",
      text: { type: "plain_text", text: "Positioning & Creators" },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: "*Positioning Opportunities*" },
    },
  ];

  for (const opp of analysis.positioning_opportunities) {
    const trendLabel = { new: "[NEW]", growing: "[GROWING]", stable: "[STABLE]" }[opp.trend] || "";
    const videos = (opp.videos || [])
      .slice(0, 2)
      .map((v) => videoLink(v))
      .join("\n");
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${trendLabel} *${opp.theme}*\n${opp.description}\n_Why it works:_ ${opp.why_it_works}${videos ? "\n" + videos : ""}`,
      },
    });
  }

  blocks.push({ type: "divider" });
  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: "*Emerging Creator Patterns*" },
  });

  for (const creator of analysis.emerging_creators) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${creator.angle}*\n${creator.pattern}`,
      },
    });
  }

  return { blocks };
}

async function postToSlack(payload) {
  await axios.post(process.env.SLACK_WEBHOOK_URL, payload);
}

// --- Main -------------------------------------------------------------------

const RAW_CACHE_PATH = path.join(__dirname, "raw-videos.json");
const SENT_VIDEOS_PATH = path.join(__dirname, "sent-videos.json");

function loadSentUrls() {
  if (!fs.existsSync(SENT_VIDEOS_PATH)) return new Set();
  return new Set(JSON.parse(fs.readFileSync(SENT_VIDEOS_PATH, "utf8")));
}

function appendSentUrls(videos) {
  const existing = loadSentUrls();
  for (const v of videos) {
    if (v.webVideoUrl) existing.add(v.webVideoUrl);
  }
  fs.writeFileSync(SENT_VIDEOS_PATH, JSON.stringify([...existing], null, 2));
}

function commitAndPushSentVideos() {
  try {
    const exec = (cmd) => execSync(cmd, { stdio: "pipe" }).toString().trim();

    // Configure git identity if not already set
    try { exec("git config user.email"); } catch { exec('git config user.email "bot@tiktok-slack-bot"'); }
    try { exec("git config user.name"); } catch { exec('git config user.name "TikTok Bot"'); }

    // On Railway (or any CI), inject GITHUB_TOKEN into the remote URL for auth
    if (process.env.GITHUB_TOKEN) {
      const currentUrl = exec("git remote get-url origin");
      const authedUrl = currentUrl.replace("https://", `https://${process.env.GITHUB_TOKEN}@`);
      exec(`git remote set-url origin ${authedUrl}`);
    }

    exec("git add sent-videos.json");

    // Nothing to commit if file is unchanged
    const dirty = exec("git status --porcelain sent-videos.json");
    if (!dirty) {
      console.log("  sent-videos.json unchanged, skipping push.");
      return;
    }

    exec('git commit -m "Update sent-videos.json"');
    exec("git pull --rebase origin main");
    exec("git push origin main");
    console.log("  sent-videos.json committed and pushed to GitHub.");
  } catch (err) {
    console.error("  Warning: could not push sent-videos.json:", err.message);
  }
}

async function runResearch() {
  const config = loadConfig();
  console.log("=== TikTok Research Bot Starting ===");

  let allVideos;

  if (fs.existsSync(RAW_CACHE_PATH)) {
    // Use cached Apify data — skip all collection steps
    console.log("\n[CACHE] Found raw-videos.json — skipping Apify, loading cached data...");
    allVideos = JSON.parse(fs.readFileSync(RAW_CACHE_PATH, "utf8"));
    console.log(`  Loaded ${allVideos.length} videos from cache`);
  } else {
    // 1. PRE-SNOWBALL
    console.log("\n[1/5] Pre-snowball: sampling base hashtags...");
    const preSnowballRaw = await runApify(config.baseHashtags, [], 10);
    const preSnowballVideos = preSnowballRaw.map(extractVideoFields);
    console.log(`  Collected ${preSnowballVideos.length} sample videos`);

    const snowballTerms = await claudePreSnowball(preSnowballVideos);
    console.log(`  Claude suggested: ${snowballTerms.join(", ")}`);

    const snowballHashtags = snowballTerms.filter((t) => !t.includes(" "));
    const snowballQueries = snowballTerms.filter((t) => t.includes(" "));

    // 2. MAIN COLLECTION
    console.log("\n[2/5] Main collection...");
    const allHashtags = [...new Set([...config.hashtags, ...snowballHashtags])];
    const allSearchTerms = [...new Set([...config.searchTerms, ...snowballQueries])];
    console.log(`  Hashtags: ${allHashtags.length}, Search queries: ${allSearchTerms.length}`);

    const mainRaw = await runApify(allHashtags, allSearchTerms, 20);
    allVideos = dedupeVideos([...preSnowballVideos, ...mainRaw.map(extractVideoFields)]);
    allVideos.sort((a, b) => b.playCount - a.playCount);
    console.log(`  Total unique videos after main collection: ${allVideos.length}`);

    // 3. POST-SNOWBALL
    console.log("\n[3/5] Post-snowball: spotting unexpected topics...");
    const postSnowballTerms = await claudePostSnowball(allVideos);
    if (postSnowballTerms.length > 0) {
      console.log(`  Found ${postSnowballTerms.length} additional terms: ${postSnowballTerms.join(", ")}`);
      const postHashtags = postSnowballTerms.filter((t) => !t.includes(" "));
      const postQueries = postSnowballTerms.filter((t) => t.includes(" "));
      const postRaw = await runApify(postHashtags, postQueries, 20);
      allVideos = dedupeVideos([...allVideos, ...postRaw.map(extractVideoFields)]);
      allVideos.sort((a, b) => b.playCount - a.playCount);
      console.log(`  Total unique videos after post-snowball: ${allVideos.length}`);
    } else {
      console.log("  No unexpected topics found, skipping post-snowball run");
    }

    // Save raw collected videos for reuse / debugging
    fs.writeFileSync(RAW_CACHE_PATH, JSON.stringify(allVideos, null, 2));
    console.log(`  Saved ${allVideos.length} videos to raw-videos.json`);
  }

  // Filter out previously sent videos
  const sentUrls = loadSentUrls();
  const beforeFilter = allVideos.length;
  allVideos = allVideos.filter((v) => !sentUrls.has(v.webVideoUrl));
  console.log(`\n[DEDUP] Filtered ${beforeFilter - allVideos.length} already-sent videos. ${allVideos.length} remaining.`);

  // 4. ANALYSIS
  console.log("\n[4/5] Claude analysis...");
  const analysis = await claudeAnalyze(allVideos);
  console.log("  Analysis complete");

  // 5. OUTPUT
  console.log("\n[5/5] Posting to Slack...");
  await postToSlack(buildMessage1(analysis));
  await postToSlack(buildMessage2(analysis));
  await postToSlack(buildMessage3(analysis));
  appendSentUrls(allVideos);
  commitAndPushSentVideos();
  console.log(`  Done! 3 messages posted to Slack. ${allVideos.length} video URLs saved to sent-videos.json.`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = { runResearch };

if (require.main === module) {
  runResearch().catch((err) => {
    console.error("Research run failed:", err);
    process.exit(1);
  });
}
