// api/summaries.js — parallel fetch + 3 parallel Claude calls (5 articles each)

async function fetchPartialText(url) {
  if (!url) return null;
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Range": "bytes=0-12000",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok && res.status !== 206) return null;
    const html = await res.text();
    const clean = html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<nav[\s\S]*?<\/nav>/gi, "")
      .replace(/<header[\s\S]*?<\/header>/gi, "")
      .replace(/<footer[\s\S]*?<\/footer>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&nbsp;/g," ")
      .replace(/\s+/g, " ").trim();
    return clean.length > 150 ? clean.substring(0, 1200) : null;
  } catch { return null; }
}

async function summariseBatch(batch, anthropicKey) {
  if (!batch.length) return [];
  const list = batch.map((a, i) =>
    `${i}: [${a.source}] ${a.headline}\nContent: ${a.content}`
  ).join("\n\n---\n\n");

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
      "x-api-key": anthropicKey,
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 2000,
      messages: [{ role: "user", content:
        `Summarise each article. Rich content = 5-6 sentences (what happened, who, key details, context, significance). Snippet only = 2-3 sentences, no invented details. Match outlet's voice.
Return ONLY JSON array, no markdown: [{"i":0,"summary":"..."}]

Articles:
${list}` }],
    }),
    signal: AbortSignal.timeout(12000),
  });

  if (!res.ok) return batch.map((_, i) => ({ i, summary: "" }));
  const data = await res.json();
  const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("");
  const clean = text.replace(/```[\w]*\n?/g, "").replace(/```/g, "").trim();
  try {
    return JSON.parse(clean.match(/\[[\s\S]*\]/)?.[0] || "[]");
  } catch { return batch.map((_, i) => ({ i, summary: "" })); }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });

  const { articles } = req.body;
  if (!articles?.length) return res.status(400).json({ error: "No articles provided" });

  // Step 1: fetch all articles in parallel — max 2s wait
  const texts = await Promise.all(articles.map(a => fetchPartialText(a.url)));

  // Step 2: enrich articles with fetched content (or fall back to snippet)
  const enriched = articles.map((a, i) => {
    const fetched = texts[i];
    const content = (fetched && fetched.length > (a.summary?.length || 0) * 1.5)
      ? fetched : (a.summary || "(no content)");
    return { ...a, content };
  });

  // Step 3: split into batches of 5, run all Claude calls in parallel
  const BATCH = 5;
  const batches = [];
  for (let i = 0; i < enriched.length; i += BATCH) {
    batches.push(enriched.slice(i, i + BATCH));
  }

  const batchResults = await Promise.all(
    batches.map(batch => summariseBatch(batch, anthropicKey).catch(() => []))
  );

  // Step 4: flatten results, preserving original article indices
  const summaries = [];
  batches.forEach((batch, batchIdx) => {
    const results = batchResults[batchIdx] || [];
    batch.forEach((_, localIdx) => {
      const globalIdx = batchIdx * BATCH + localIdx;
      const found = results.find(r => r.i === localIdx);
      summaries.push({ i: globalIdx, summary: found?.summary || "" });
    });
  });

  return res.status(200).json({ summaries });
}
