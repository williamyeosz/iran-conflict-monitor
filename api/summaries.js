// api/summaries.js — resolve redirects lazily, then fetch + summarise

// Decode Google News URL to real article URL
// Google News encodes the real URL in the article path using base64
async function resolveUrl(url) {
  if (!url || !url.includes("news.google.com")) return url;
  try {
    // Fetch the Google News page and extract the real URL from the HTML
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(5000),
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
        "Referer": "https://news.google.com/",
      },
    });

    // If we got redirected to a real domain, use it
    if (res.url && !res.url.includes("news.google.com")) return res.url;

    // Otherwise parse the HTML for the real URL
    const html = await res.text();

    // Try canonical link first
    const canonical = html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i)?.[1];
    if (canonical && !canonical.includes("news.google.com")) return canonical;

    // Try og:url meta tag
    const ogUrl = html.match(/<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)["']/i)?.[1];
    if (ogUrl && !ogUrl.includes("news.google.com")) return ogUrl;

    // Try JS redirect patterns
    const jsRedirect = html.match(/window\.location(?:\.href)?\s*=\s*["']([^"']+)["']/)?.[1];
    if (jsRedirect && !jsRedirect.includes("news.google.com") && jsRedirect.startsWith("http")) return jsRedirect;

    // Try data-n-au attribute (Google News article link)
    const dataUrl = html.match(/data-n-au=["']([^"']+)["']/)?.[1];
    if (dataUrl && !dataUrl.includes("news.google.com")) return dataUrl;

    return url; // couldn't resolve, return original
  } catch { return url; }
}

async function fetchPartialText(url) {
  if (!url) return null;
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Range": "bytes=0-12000",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(3000),
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
    signal: AbortSignal.timeout(15000),
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

  // Step 1: resolve any Google redirect URLs in parallel
  const resolvedUrls = await Promise.all(articles.map(a => resolveUrl(a.url)));

  // Step 2: fetch article content from real URLs in parallel
  const texts = await Promise.all(resolvedUrls.map(url => fetchPartialText(url)));

  // Step 3: enrich with fetched content, snippet, or headline as last resort
  const enriched = articles.map((a, i) => {
    const fetched = texts[i];
    const content = (fetched && fetched.length > 150)
      ? fetched
      : (a.summary && a.summary.length > 30)
        ? a.summary
        : null; // no fallback — skip if no content available
    return { ...a, content };
  });

  // Step 4: only summarise articles that have content
  const withContent = enriched.filter(a => a.content);
  const BATCH = 5;
  const batches = [];
  for (let i = 0; i < withContent.length; i += BATCH) batches.push(withContent.slice(i, i + BATCH));

  const batchResults = await Promise.all(
    batches.map(batch => summariseBatch(batch, anthropicKey).catch(() => []))
  );

  // Step 5: flatten results
  const summaries = [];
  batches.forEach((batch, batchIdx) => {
    const results = batchResults[batchIdx] || [];
    batch.forEach((article, localIdx) => {
      // Find original index in articles array
      const globalIdx = articles.findIndex(a => a.url === article.url && a.headline === article.headline);
      const found = results.find(r => r.i === localIdx);
      summaries.push({ i: globalIdx, summary: found?.summary || "" });
    });
  });

  return res.status(200).json({ summaries });
}
