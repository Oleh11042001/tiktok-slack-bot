require("dotenv").config();
const Anthropic = require("@anthropic-ai/sdk");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const CONFIG_PATH = path.join(__dirname, "config.json");

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
}

// ─── Apify ────────────────────────────────────────────────────────────────────

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

  // Poll until finished
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

  const datasetId = (
    await axios.get(
      `https://api.apify.com/v2/acts/clockworks~tiktok-scraper/runs/${runId}?token=${token}`
    )
  ).data.data.defaultDatasetId;

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

// ─── Claude helpers ───────────────────────────────────────────────────────────

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

async function claudeAnalyze(videos) {
  const videoData = videos.slice(0, 150).map((v) => ({
    text: v.text,
    url: v.webVideoUrl,
    views: v.playCount,
    likes: v.diggCount,
    author: v.authorName,
    hashtags: v.hashtags,
  }));

  const prompt = `You are an expert TikTok content strategist analyzing viral health, fitness, and mental health content for a Tier 1 English-speaking audience.

Analyze these ${videoData.length} top-performing TikTok videos and return a JSON object matching EXACTLY this schema:

{
  "summary": "3-4 sentences overview of the current landscape",
  "trending_topics": [8 items: { "topic", "momentum" (new/growing/stable), "total_views" (number), "description", "top_videos": [{"title", "url", "views", "likes"}] }],
  "viral_hooks": [6 items: { "hook", "why_it_works", "examples": [{"text", "url", "views"}] }],
  "positioning_opportunities": [6 items: { "theme", "trend" (new/growing/stable), "description", "why_it_works", "videos": [{"text", "url", "views", "author"}] }],
  "audience_language": [8 items: { "phrase", "meaning", "usage_context" }],
  "emerging_creators": [4 items: { "angle", "pattern" }]
}

Return exactly 8 trending_topics, 6 viral_hooks, 6 positioning_opportunities, 8 audience_language, 4 emerging_creators.
Return ONLY the JSON object. No markdown fences, no explanation.

VIDEO DATA:
${JSON.stringify(videoData, null, 2)}`;

  const msg = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 8192,
    messages: [{ role: "user", content: prompt }],
  });

  const text = msg.content[0].text.trim();
  const jsonStart = text.indexOf("{");
  const jsonEnd = text.lastIndexOf("}");
  if (jsonStart === -1) throw new Error("Claude analysis returned no JSON");
  return JSON.parse(text.slice(jsonStart, jsonEnd + 1));
}

// ─── Slack ────────────────────────────────────────────────────────────────────

function truncate(str, len) {
  if (!str) return "";
  return str.length > len ? str.slice(0, len - 1) + "…" : str;
}

function formatNum(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(n);
}

function videoLink(video) {
  const label = truncate(video.title || video.text || "Watch video", 60);
  return `<${video.url}|🎵 ${label}> (views: ${formatNum(video.views)})`;
}

function buildMessage1(analysis) {
  const blocks = [
    {
      type: "header",
      text: { type: "plain_text", text: "📊 TikTok Weekly Research Report" },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: `*Summary*\n${analysis.summary}` },
    },
    { type: "divider" },
    {
      type: "section",
      text: { type: "mrkdwn", text: "*🔥 Trending Topics*" },
    },
  ];

  for (const topic of analysis.trending_topics) {
    const momentumEmoji = { new: "🆕", growing: "📈", stable: "➡️" }[topic.momentum] || "•";
    const links = (topic.top_videos || [])
      .slice(0, 3)
      .map((v) => videoLink(v))
      .join("\n");
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${momentumEmoji} *${topic.topic}* — ${formatNum(topic.total_views)} total views\n${topic.description}${links ? "\n" + links : ""}`,
      },
    });
  }

  return { blocks };
}

function buildMessage2(analysis) {
  const blocks = [
    {
      type: "header",
      text: { type: "plain_text", text: "🎣 Viral Hooks & Audience Language" },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: "*💬 Viral Hook Patterns*" },
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
    text: { type: "mrkdwn", text: "*🗣️ Audience Language*" },
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
      text: { type: "plain_text", text: "🎯 Positioning & Creators" },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: "*💡 Positioning Opportunities*" },
    },
  ];

  for (const opp of analysis.positioning_opportunities) {
    const trendEmoji = { new: "🆕", growing: "📈", stable: "➡️" }[opp.trend] || "•";
    const videos = (opp.videos || [])
      .slice(0, 2)
      .map((v) => videoLink(v))
      .join("\n");
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${trendEmoji} *${opp.theme}*\n${opp.description}\n_Why it works:_ ${opp.why_it_works}${videos ? "\n" + videos : ""}`,
      },
    });
  }

  blocks.push({ type: "divider" });
  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: "*🌱 Emerging Creator Patterns*" },
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

// ─── Main ─────────────────────────────────────────────────────────────────────

async function runResearch() {
  const config = loadConfig();
  console.log("=== TikTok Research Bot Starting ===");

  // 1. PRE-SNOWBALL — small sample to discover additional trending terms
  console.log("\n[1/5] Pre-snowball: sampling base hashtags…");
  const preSnowballRaw = await runApify(config.baseHashtags, [], 10);
  const preSnowballVideos = preSnowballRaw.map(extractVideoFields);
  console.log(`  Collected ${preSnowballVideos.length} sample videos`);

  const snowballTerms = await claudePreSnowball(preSnowballVideos);
  console.log(`  Claude suggested: ${snowballTerms.join(", ")}`);

  // Split snowball terms into hashtags vs multi-word search queries
  const snowballHashtags = snowballTerms.filter((t) => !t.includes(" "));
  const snowballQueries = snowballTerms.filter((t) => t.includes(" "));

  // 2. MAIN COLLECTION
  console.log("\n[2/5] Main collection…");
  const allHashtags = [...new Set([...config.hashtags, ...snowballHashtags])];
  const allSearchTerms = [...new Set([...config.searchTerms, ...snowballQueries])];
  console.log(`  Hashtags: ${allHashtags.length}, Search queries: ${allSearchTerms.length}`);

  const mainRaw = await runApify(allHashtags, allSearchTerms, 20);
  let allVideos = dedupeVideos(
    [...preSnowballVideos, ...mainRaw.map(extractVideoFields)]
  );
  allVideos.sort((a, b) => b.playCount - a.playCount);
  console.log(`  Total unique videos after main collection: ${allVideos.length}`);

  // 3. POST-SNOWBALL
  console.log("\n[3/5] Post-snowball: spotting unexpected topics…");
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

  // 4. ANALYSIS
  console.log("\n[4/5] Claude analysis…");
  const analysis = await claudeAnalyze(allVideos);
  console.log("  Analysis complete");

  // 5. OUTPUT
  console.log("\n[5/5] Posting to Slack…");
  await postToSlack(buildMessage1(analysis));
  await postToSlack(buildMessage2(analysis));
  await postToSlack(buildMessage3(analysis));
  console.log("  Done! 3 messages posted to Slack.");
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
