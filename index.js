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

async function fetchTodayApifyRuns() {
  const token = process.env.APIFY_API_TOKEN;
  const today = new Date().toISOString().slice(0, 10);
  const runsRes = await axios.get(
    `https://api.apify.com/v2/acts/clockworks~tiktok-scraper/runs?token=${token}&limit=20&desc=true`
  );
  const todayRuns = runsRes.data.data.items.filter(
    (r) => r.status === "SUCCEEDED" && r.startedAt?.startsWith(today)
  );
  if (todayRuns.length === 0) return null;
  console.log(`  Found ${todayRuns.length} completed Apify run(s) from today`);
  let allRaw = [];
  for (const run of todayRuns) {
    const res = await axios.get(
      `https://api.apify.com/v2/datasets/${run.defaultDatasetId}/items?token=${token}&limit=5000`
    );
    console.log(`  Run ${run.id}: ${res.data.length} items`);
    allRaw.push(...res.data);
  }
  return dedupeVideos(allRaw.map(extractVideoFields)).sort((a, b) => b.playCount - a.playCount);
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
  const videoData = videos.slice(0, 150).map((v) => ({
    text: sanitizeText(v.text, 200),
    url: v.webVideoUrl,
    views: v.playCount,
    likes: v.diggCount,
    author: sanitizeText(v.authorName, 50),
    hashtags: v.hashtags.slice(0, 10),
  }));

  const prompt = `You are a direct-response ad strategist and TikTok creative researcher. Your job is to find the best organic TikTok videos that can be used as ad references or inspiration for a fitness and wellness app targeting women 45+.

This audience cares about: hormonal health, perimenopause, cortisol, nervous system, weight that won't budge, energy, sleep, inflammation, feeling good in their body again. They are skeptical of hype but respond to authenticity, specificity, and being seen.

Analyze these ${videoData.length} TikTok videos. Select the 20 best ad references — prioritize by AD POTENTIAL (strong hook, clear angle, relatable to women 45+, adaptable to paid social) not just raw view count. Include men's content only if the angle clearly transfers to this female audience.

Return ONLY a raw JSON object. No markdown fences. No explanation. All string values must be valid JSON: no literal newlines, no unescaped quotes, no control characters.

{
  "ad_references": [
    {
      "url": "",
      "views": 0,
      "hook": "exact hook text from the video title or description — copy it precisely",
      "hook_type": "one of: POV / transformation / symptom list / debunk / routine / fear / identity",
      "angle": "the core positioning angle this video uses in 1 sentence",
      "why_usable": "why this works specifically for women 45+ app advertising — 1 sentence",
      "novelty": "one of: new angle / classic format / classic topic new format",
      "adapt_idea": "one concrete specific idea for how to adapt this as an app ad — 1 sentence"
    }
  ],
  "emerging_angles": [
    {
      "angle": "angle name",
      "evidence": "which video hooks or themes support this — be specific",
      "why_now": "why this angle is timely right now — 1 sentence"
    }
  ]
}

Return exactly 20 ad_references and 6 emerging_angles.

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

function buildRefBlock(r, i) {
  const lines = [
    `*${i + 1}. <${r.url}|${truncate(r.hook, 80)}>* — ${formatNum(r.views)} views`,
    `*Hook type:* ${r.hook_type}   *Novelty:* ${r.novelty}`,
    `*Angle:* ${r.angle}`,
    `*Why usable:* ${r.why_usable}`,
    `*Adapt idea:* ${r.adapt_idea}`,
  ];
  return [
    { type: "section", text: { type: "mrkdwn", text: lines.join("\n") } },
    { type: "divider" },
  ];
}

function buildSlackMessages(analysis, stats) {
  const refs = analysis.ad_references || [];
  const angles = analysis.emerging_angles || [];
  const mid = Math.ceil(refs.length / 2);

  // Message 1: header + stats + first half of refs
  const msg1 = [
    { type: "header", text: { type: "plain_text", text: "TikTok Ad Research — Women 45+" } },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${stats.totalCollected}* videos collected · *${stats.afterDedup}* new this run · *${refs.length}* ad references · *${angles.length}* emerging angles`,
      },
    },
    { type: "divider" },
    { type: "section", text: { type: "mrkdwn", text: `*:clapper: AD REFERENCES (${refs.length}) — part 1/${refs.length > mid ? 2 : 1}*` } },
  ];
  for (let i = 0; i < mid; i++) msg1.push(...buildRefBlock(refs[i], i));

  // Message 2: second half of refs (only if there are any)
  const msg2 = [];
  if (refs.length > mid) {
    msg2.push({ type: "section", text: { type: "mrkdwn", text: `*:clapper: AD REFERENCES — part 2/2*` } });
    for (let i = mid; i < refs.length; i++) msg2.push(...buildRefBlock(refs[i], i));
  }

  // Message 3: emerging angles
  const msg3 = [
    { type: "section", text: { type: "mrkdwn", text: `*:rocket: EMERGING ANGLES (${angles.length})*` } },
  ];
  for (const a of angles) {
    msg3.push({
      type: "section",
      text: { type: "mrkdwn", text: `*${a.angle}*\n_Evidence:_ ${a.evidence}\n_Why now:_ ${a.why_now}` },
    });
  }

  return [msg1, msg2.length ? msg2 : null, msg3].filter(Boolean).map((b) => ({ blocks: b }));
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
    let partialVideos = [];

    try {
      // 1. PRE-SNOWBALL
      console.log("\n[1/5] Pre-snowball: sampling base hashtags...");
      const preSnowballRaw = await runApify(config.baseHashtags, [], 10);
      const preSnowballVideos = preSnowballRaw.map(extractVideoFields);
      console.log(`  Collected ${preSnowballVideos.length} sample videos`);
      partialVideos = preSnowballVideos;

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
      partialVideos = allVideos;

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

    } catch (err) {
      console.warn(`\n[RECOVERY] Apify scraping failed: ${err.message}`);
      console.log("  Trying to recover from today's existing Apify runs...");

      let todayVideos = null;
      try {
        todayVideos = await fetchTodayApifyRuns();
      } catch (fetchErr) {
        console.warn(`  Could not fetch today's runs: ${fetchErr.message}`);
      }

      if (todayVideos && todayVideos.length > 0) {
        allVideos = dedupeVideos([...partialVideos, ...todayVideos]);
        allVideos.sort((a, b) => b.playCount - a.playCount);
        console.log(`  Recovered ${allVideos.length} videos (${partialVideos.length} partial + today's Apify runs)`);
      } else if (fs.existsSync(RAW_CACHE_PATH)) {
        console.log("  No today's runs found — falling back to raw-videos.json...");
        allVideos = JSON.parse(fs.readFileSync(RAW_CACHE_PATH, "utf8"));
        console.log(`  Loaded ${allVideos.length} videos from cache`);
      } else {
        throw new Error(`Apify scraping failed and no fallback data available: ${err.message}`);
      }
    }
  }

  // Filter out previously sent videos
  const sentUrls = loadSentUrls();
  const totalCollected = allVideos.length;
  allVideos = allVideos.filter((v) => !sentUrls.has(v.webVideoUrl));
  const afterDedup = allVideos.length;
  console.log(`\n[DEDUP] Filtered ${totalCollected - afterDedup} already-sent videos. ${afterDedup} remaining.`);

  // 4. ANALYSIS
  console.log("\n[4/5] Claude analysis...");
  const analysis = await claudeAnalyze(allVideos);
  console.log("  Analysis complete");

  // 5. OUTPUT
  console.log("\n[5/5] Posting to Slack...");
  const stats = { totalCollected, afterDedup };
  for (const msg of buildSlackMessages(analysis, stats)) {
    await postToSlack(msg);
  }
  console.log("  Slack message posted.");

  // Save full report
  const today = new Date().toISOString().slice(0, 10);
  const reportPath = path.join(__dirname, "reports", `${today}.json`);
  fs.mkdirSync(path.join(__dirname, "reports"), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify({ date: today, stats, analysis }, null, 2));
  console.log(`  Report saved to reports/${today}.json`);

  appendSentUrls(allVideos);
  commitAndPushSentVideos();
  console.log(`  Done! ${afterDedup} video URLs saved to sent-videos.json.`);
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
