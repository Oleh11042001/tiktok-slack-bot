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

// --- Reddit context ---------------------------------------------------------

function loadRedditReport() {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const candidates = [
    path.join(home, "reddit-slack-bot", "reports"),
    path.join(__dirname, "reddit-report.json"),
  ];

  // Most recent structured report from the reports dir
  const reportsDir = candidates[0];
  if (fs.existsSync(reportsDir)) {
    const files = fs
      .readdirSync(reportsDir)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .reverse();
    if (files.length > 0) {
      try {
        const report = JSON.parse(
          fs.readFileSync(path.join(reportsDir, files[0]), "utf8")
        );
        if (report.insights) {
          console.log(`  Loaded Reddit report: ${files[0]}`);
          return report.insights;
        }
      } catch {}
    }
  }

  // Fallback: local copy committed to this repo
  if (fs.existsSync(candidates[1])) {
    try {
      const report = JSON.parse(fs.readFileSync(candidates[1], "utf8"));
      console.log("  Loaded Reddit report from local reddit-report.json");
      return report.insights || null;
    } catch {}
  }

  console.log("  No Reddit report found — will skip Reddit cross-reference");
  return null;
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
  return str.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, " ").slice(0, maxLen);
}

function filterRecentVideos(videos, days = 7) {
  const cutoff = Math.floor(Date.now() / 1000) - days * 24 * 3600;
  const recent = videos.filter((v) => v.createTime && v.createTime >= cutoff);
  console.log(`  ${recent.length}/${videos.length} videos are from the last ${days} days`);
  return recent;
}

async function claudeWeeklyDigest(videos, redditInsights) {
  const videoData = videos.slice(0, 150).map((v) => ({
    url: v.webVideoUrl,
    text: sanitizeText(v.text, 150),
    author: sanitizeText(v.authorName, 40),
    authorHandle: v.authorName ? `@${v.authorName}` : "",
    views: v.playCount,
    hashtags: v.hashtags.slice(0, 8),
    createTime: v.createTime,
  }));

  const redditSection = redditInsights
    ? `
REDDIT INTELLIGENCE (what our target audience talked about this week):
Summary: ${redditInsights.summary?.slice(0, 400) || ""}

Top pain points:
${(redditInsights.pain_points || [])
    .slice(0, 6)
    .map((p) => `- ${p.point}`)
    .join("\n")}

Positioning opportunities:
${(redditInsights.positioning_opportunities || [])
    .slice(0, 3)
    .map((o) => `- ${o.theme}`)
    .join("\n")}
`
    : "";

  const prompt = `You are a TikTok trend researcher. Analyze ${videoData.length} TikTok videos from the last 7 days for a fitness and wellness app targeting women 45+.
${redditSection}
Produce a weekly digest. Return ONLY a raw JSON object. No markdown fences. No explanation. All strings must be valid JSON (no literal newlines, no unescaped quotes).

{
  "week_summary": "2-3 sentence summary of what dominated TikTok in health/fitness/wellness this week",
  "hashtag_summary": {
    "top_hashtags": [
      {"tag": "#cortisol", "video_count": 45, "signal": "exploding", "why_now": "1 sentence"}
    ],
    "new_this_week": ["#tag1", "#tag2"],
    "fading": ["#tag3", "#tag4"]
  },
  "new_trends": [
    {
      "trend": "Trend name",
      "description": "What it is and why it matters for women 45+ — 2 sentences",
      "example_hook": "Exact hook text from one of the videos",
      "example_url": "tiktok url",
      "views": 0,
      "why_now": "1 sentence on why this is emerging now"
    }
  ],
  "top_profiles": [
    {
      "handle": "@username",
      "profile_url": "https://www.tiktok.com/@username",
      "why_follow": "What makes this creator valuable for our research — 1 sentence",
      "top_video_url": "url of their best video this week",
      "top_video_views": 0,
      "top_video_hook": "hook text from their best video"
    }
  ],
  "reddit_matched_videos": [
    {
      "reddit_topic": "Exact pain point or theme from the Reddit report this addresses",
      "url": "tiktok url",
      "views": 0,
      "hook": "hook text",
      "why_match": "How this TikTok speaks directly to that Reddit pain point — 1 sentence"
    }
  ],
  "top_videos": [
    {
      "url": "tiktok url",
      "views": 0,
      "hook": "hook or description text",
      "angle": "The core angle in 1 sentence"
    }
  ]
}

Requirements:
- week_summary: honest characterization of this week's TikTok landscape
- top_hashtags: 8 most-used hashtags in the data, with signal = "exploding" / "growing" / "stable"
- new_this_week: 3-5 hashtags that feel genuinely novel or newly trending
- fading: 2-3 hashtags that appear low-volume or losing steam
- new_trends: 5 distinct emerging content angles/formats
- top_profiles: top 5 creators by total reach this week (use real handles from the data)
- reddit_matched_videos: 5 videos that directly address pain points from the Reddit report${redditInsights ? " — cross-reference the Reddit intelligence above" : ""}
- top_videos: top 10 videos by view count

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
  if (jsonStart === -1) throw new Error("Claude weekly digest returned no JSON");
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
  return str.length > len ? str.slice(0, len - 1) + "…" : str;
}

function formatNum(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(n);
}

function buildWeeklyDigestMessages(digest, stats) {
  const { hashtag_summary, new_trends, top_profiles, reddit_matched_videos, top_videos, week_summary } = digest;
  const hs = hashtag_summary || {};
  const topTags = hs.top_hashtags || [];
  const newTags = hs.new_this_week || [];
  const fadingTags = hs.fading || [];
  const trends = new_trends || [];
  const profiles = top_profiles || [];
  const redditVideos = reddit_matched_videos || [];
  const topVids = top_videos || [];

  // --- Message 1: Header + Week Summary + Hashtag Landscape ---
  const signalEmoji = { exploding: "🔥", growing: "📈", stable: "➡️" };

  const hashtagLines = topTags
    .map((t) => `${signalEmoji[t.signal] || "•"} *${t.tag}* (${t.video_count} videos) — ${t.why_now}`)
    .join("\n");

  const newTagsLine = newTags.length ? `*New this week:* ${newTags.join("  ")}` : "";
  const fadingLine = fadingTags.length ? `*Fading:* ${fadingTags.join("  ")}` : "";

  const msg1 = [
    {
      type: "header",
      text: { type: "plain_text", text: "📊 Weekly TikTok Research Digest — Women 45+" },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `${stats.recentVideos} videos from last 7 days · ${stats.totalCollected} collected total · week of ${stats.weekOf}`,
        },
      ],
    },
    { type: "divider" },
    {
      type: "section",
      text: { type: "mrkdwn", text: `*This Week on TikTok*\n${week_summary || ""}` },
    },
    { type: "divider" },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*#️⃣ Hashtag Landscape*\n${hashtagLines}${newTagsLine ? "\n\n" + newTagsLine : ""}${fadingLine ? "\n" + fadingLine : ""}`,
      },
    },
    { type: "divider" },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*🚀 New Trends This Week (${trends.length})*`,
      },
    },
    ...trends.map((t) => ({
      type: "section",
      text: {
        type: "mrkdwn",
        text: [
          `*${t.trend}*`,
          t.description,
          `_Why now:_ ${t.why_now}`,
          t.example_url
            ? `_Example:_ <${t.example_url}|${truncate(t.example_hook, 80)}> — ${formatNum(t.views)} views`
            : "",
        ]
          .filter(Boolean)
          .join("\n"),
      },
    })),
  ];

  // --- Message 2: Top Profiles + Reddit-matched videos ---
  const msg2 = [
    {
      type: "section",
      text: { type: "mrkdwn", text: `*👤 Top Profiles This Week*` },
    },
    ...profiles.map((p) => ({
      type: "section",
      text: {
        type: "mrkdwn",
        text: [
          `*<${p.profile_url}|${p.handle}>*`,
          p.why_follow,
          p.top_video_url
            ? `Top video: <${p.top_video_url}|${truncate(p.top_video_hook, 70)}> — ${formatNum(p.top_video_views)} views`
            : "",
        ]
          .filter(Boolean)
          .join("\n"),
      },
    })),
    { type: "divider" },
    ...(redditVideos.length
      ? [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `*🔗 TikTok × Reddit — Videos Matching This Week's Audience Pain Points*`,
            },
          },
          ...redditVideos.map((v) => ({
            type: "section",
            text: {
              type: "mrkdwn",
              text: [
                `*Reddit topic:* ${v.reddit_topic}`,
                `<${v.url}|${truncate(v.hook, 80)}> — ${formatNum(v.views)} views`,
                `_Why it matches:_ ${v.why_match}`,
              ].join("\n"),
            },
          })),
          { type: "divider" },
        ]
      : []),
  ];

  // --- Message 3: Top 10 Videos ---
  const msg3 = [
    {
      type: "section",
      text: { type: "mrkdwn", text: `*🎬 Top ${topVids.length} Videos This Week*` },
    },
    { type: "divider" },
    ...topVids.map((v, i) => ({
      type: "section",
      text: {
        type: "mrkdwn",
        text: [
          `*${i + 1}. <${v.url}|${truncate(v.hook, 80)}>* — ${formatNum(v.views)} views`,
          `${v.angle}`,
        ].join("\n"),
      },
    })),
  ];

  return [msg1, msg2, msg3].map((b) => ({ blocks: b }));
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

    try { exec("git config user.email"); } catch { exec('git config user.email "bot@tiktok-slack-bot"'); }
    try { exec("git config user.name"); } catch { exec('git config user.name "TikTok Bot"'); }

    if (process.env.GITHUB_TOKEN) {
      const currentUrl = exec("git remote get-url origin");
      const authedUrl = currentUrl.replace("https://", `https://${process.env.GITHUB_TOKEN}@`);
      exec(`git remote set-url origin ${authedUrl}`);
    }

    exec("git add sent-videos.json");

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

function commitAndPushReport(reportPath, date) {
  try {
    const exec = (cmd) => execSync(cmd, { stdio: "pipe" }).toString().trim();

    try { exec("git config user.email"); } catch { exec('git config user.email "bot@tiktok-slack-bot"'); }
    try { exec("git config user.name"); } catch { exec('git config user.name "TikTok Bot"'); }

    if (process.env.GITHUB_TOKEN) {
      const currentUrl = exec("git remote get-url origin");
      if (!currentUrl.includes("@")) {
        const authedUrl = currentUrl.replace("https://", `https://${process.env.GITHUB_TOKEN}@`);
        exec(`git remote set-url origin ${authedUrl}`);
      }
    }

    exec(`git add "${reportPath}"`);
    const dirty = exec(`git status --porcelain "${reportPath}"`);
    if (!dirty) {
      console.log("  Report unchanged, skipping push.");
      return;
    }

    exec(`git commit -m "Add report ${date}"`);
    exec("git pull --rebase origin main");
    exec("git push origin main");
    console.log(`  Report committed and pushed.`);
  } catch (err) {
    console.error("  Warning: could not push report:", err.message);
  }
}

async function runResearch() {
  const config = loadConfig();
  console.log("=== TikTok Weekly Research Bot ===");

  // Load Reddit context for cross-referencing
  console.log("\n[0/5] Loading Reddit intelligence...");
  const redditInsights = loadRedditReport();

  let allVideos;

  if (fs.existsSync(RAW_CACHE_PATH)) {
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
        console.log(`  Recovered ${allVideos.length} videos`);
      } else if (fs.existsSync(RAW_CACHE_PATH)) {
        console.log("  Falling back to raw-videos.json...");
        allVideos = JSON.parse(fs.readFileSync(RAW_CACHE_PATH, "utf8"));
        console.log(`  Loaded ${allVideos.length} videos from cache`);
      } else {
        throw new Error(`Apify scraping failed and no fallback data available: ${err.message}`);
      }
    }
  }

  const totalCollected = allVideos.length;

  // Filter to last 7 days — only growing, recent content
  console.log("\n[FILTER] Keeping only videos from the last 7 days...");
  const recentVideos = filterRecentVideos(allVideos, 7);
  const digestVideos = recentVideos;
  console.log(`  ${digestVideos.length} videos for digest`);

  // 4. ANALYSIS
  console.log("\n[4/5] Claude weekly digest analysis...");
  const digest = await claudeWeeklyDigest(digestVideos, redditInsights);
  console.log("  Analysis complete");

  // 5. OUTPUT
  console.log("\n[5/5] Posting to Slack...");
  const today = new Date().toISOString().slice(0, 10);
  const stats = {
    totalCollected,
    recentVideos: recentVideos.length,
    weekOf: today,
  };
  for (const msg of buildWeeklyDigestMessages(digest, stats)) {
    await postToSlack(msg);
  }
  console.log("  Slack messages posted.");

  // Save and commit report
  const reportPath = path.join(__dirname, "reports", `${today}.json`);
  fs.mkdirSync(path.join(__dirname, "reports"), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify({ date: today, stats, digest }, null, 2));
  console.log(`  Report saved to reports/${today}.json`);
  commitAndPushReport(reportPath, today);

  console.log("  Done.");
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
