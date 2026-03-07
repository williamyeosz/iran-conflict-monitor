// api/news.js -- Google News RSS (real-time) + Brave Search (coverage), Claude for momentum scoring

const CACHE_TTL_MS = 2 * 60 * 60 * 1000;
let cache = { data: null, cachedAt: 0, inFlight: null };
let lastFetchStarted = 0;
const FETCH_COOLDOWN_MS = 5000;

// Google News RSS queries -- near real-time, no API key needed
const GNEWS_QUERIES = [
  { q: "Iran war latest" },
  { q: "Iran Israel strike" },
  { q: "Tehran conflict" },
];

const WESTERN_DOMAINS = {
  "bbc.com": "BBC News", "bbc.co.uk": "BBC News",
  "reuters.com": "Reuters",
  "cnn.com": "CNN",
  "apnews.com": "AP News",
  "cbsnews.com": "CBS News",
  "nytimes.com": "New York Times",
  "aljazeera.com": "Al Jazeera",
  "theguardian.com": "The Guardian",
  "timesofisrael.com": "Times of Israel",
  "npr.org": "NPR",
};

const IRAN_DOMAINS = {
  "presstv.ir": "Press TV",
  "almayadeen.net": "Al Mayadeen",
  "irna.ir": "IRNA",
  "tehrantimes.com": "Tehran Times",
  "tasnimnews.com": "Tasnim News",
  "mehrnews.com": "Mehr News",
};

const RUCN_DOMAINS = {
  "rt.com": "RT",
  "sputnikglobe.com": "Sputnik",
  "tass.com": "TASS",
  "cgtn.com": "CGTN",
  "english.news.cn": "Xinhua",
  "globaltimes.cn": "Global Times",
};

const BRAVE_SOURCES = {
  west: [
    { name: "BBC News",        query: "Iran war site:bbc.com" },
    { name: "Reuters",         query: "Iran conflict site:reuters.com" },
    { name: "AP News",         query: "Iran site:apnews.com" },
    { name: "Al Jazeera",      query: "Iran war site:aljazeera.com" },
    { name: "Times of Israel", query: "Iran site:timesofisrael.com" },
  ],
  iran: [
    { name: "Press TV",        query: "Iran conflict site:presstv.ir" },
    { name: "Al Mayadeen",     query: "Iran war site:almayadeen.net" },
    { name: "Tehran Times",    query: "Iran site:tehrantimes.com" },
    { name: "Tasnim News",     query: "Iran site:tasnimnews.com" },
  ],
  rucn: [
    { name: "RT",              query: "Iran site:rt.com" },
    { name: "Sputnik",         query: "Iran site:sputnikglobe.com" },
    { name: "TASS",            query: "Iran site:tass.com" },
    { name: "CGTN",            query: "Iran site:cgtn.com" },
    { name: "Xinhua",          query: "Iran site:english.news.cn" },
    { name: "Global Times",    query: "Iran site:globaltimes.cn" },
  ],
};

// ── Google News RSS ───────────────────────────────────────────────────────────
function getDomainSource(url, domainMap) {
  try {
    const hostname = new URL(url).hostname.replace("www.", "");
    for (const [domain, name] of Object.entries(domainMap)) {
      if (hostname === domain || hostname.endsWith("." + domain)) return name;
    }
  } catch {}
  return null;
}

function parseRSSDate(dateStr) {
  if (!dateStr) return null;
  try { return new Date(dateStr); } catch { return null; }
}

function parseRSSXML(xml) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRegex.exec(xml)) !== null) {
    const inner = m[1];
    const title = (inner.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) || inner.match(/<title>(.*?)<\/title>/))?.[1]?.trim();
    const link  = (inner.match(/<link>(.*?)<\/link>/))?.[1]?.trim();
    const pubDate = (inner.match(/<pubDate>(.*?)<\/pubDate>/))?.[1]?.trim();
    const desc = (inner.match(/<description><!\[CDATA\[(.*?)\]\]><\/description>/) || inner.match(/<description>(.*?)<\/description>/))?.[1]?.trim();
    if (title && link) items.push({ title, link, pubDate, desc });
  }
  return items;
}

async function fetchGoogleNewsRSS() {
  const allItems = [];
  await Promise.all(GNEWS_QUERIES.map(async ({ q }) => {
    try {
      const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) return;
      const xml = await res.text();
      allItems.push(...parseRSSXML(xml));
    } catch {}
  }));
  return allItems;
}

// ── Brave Search ──────────────────────────────────────────────────────────────
async function braveSearch(query, braveKey, force = false) {
  const cacheKey = `brave:${query}`;
  if (!force && braveSearch._cache?.[cacheKey]) {
    const { data, at } = braveSearch._cache[cacheKey];
    if (Date.now() - at < CACHE_TTL_MS) return data;
  }
  const url = `https://api.search.brave.com/res/v1/news/search?q=${encodeURIComponent(query)}&count=10&freshness=pd`;
  const res = await fetch(url, {
    headers: { "Accept": "application/json", "X-Subscription-Token": braveKey },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Brave ${res.status}`);
  const json = await res.json();
  const results = (json.results || []).map(r => ({
    headline: r.title,
    url: r.url,
    summary: r.description || "",
    age: r.age || "",
  }));
  braveSearch._cache = braveSearch._cache || {};
  braveSearch._cache[cacheKey] = { data: results, at: Date.now() };
  return results;
}

function parseAgeToHours(age) {
  if (!age) return null;
  const n = parseInt(age);
  if (isNaN(n)) return null;
  if (/hour/i.test(age))   return n;
  if (/minute/i.test(age)) return n / 60;
  if (/day/i.test(age))    return n * 24;
  if (/week/i.test(age))   return n * 168;
  return null;
}

function categoriseArticles(articles) {
  const rules = [
    { cat: "Military",   words: ["strike", "attack", "missile", "bomb", "kill", "dead", "troops", "military", "warship", "airstrike", "drone", "explosion", "soldier", "navy", "air force"] },
    { cat: "Diplomatic", words: ["sanction", "talks", "ceasefire", "negotiat", "diplomat", "treaty", "agreement", "envoy", "UN", "foreign minister"] },
    { cat: "Economic",   words: ["oil", "brent", "crude", "sanction", "export", "economy", "GDP", "inflation", "trade", "supply"] },
  ];
  return articles.map(a => {
    const text = (a.headline + " " + (a.summary || "")).toLowerCase();
    for (const rule of rules) {
      if (rule.words.some(w => text.includes(w))) return { ...a, category: rule.cat };
    }
    return { ...a, category: "Political" };
  });
}

// ── Generate reason (separate call after real scores computed) ────────────────
async function generateReason(recentHeadlines, direction, anthropicKey) {
  if (!recentHeadlines) return null;
  const prompt = [
    `The momentum direction for the last 6 hours is: ${direction}.`,
    "Write ONE sentence (max 25 words) explaining the key recent events that support this direction.",
    "Attribute claims to source: US claims, Iran reports, per war monitor. No loaded words: dominated, overwhelmingly, degraded, ineffective, crippled, decisive.",
    "Do NOT contradict the stated direction. State specific facts only. Do NOT reference headline numbers.",
    "Return ONLY the sentence, no preamble.",
    "Recent headlines:", recentHeadlines,
  ].join("\n");
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "anthropic-version": "2023-06-01", "x-api-key": anthropicKey },
      body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 100, messages: [{ role: "user", content: prompt }] }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return (data.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim() || null;
  } catch { return null; }
}

// ── Score momentum ────────────────────────────────────────────────────────────
async function scoreMomentum(articles, anthropicKey) {
  if (!articles.length) return { articles, reason: null };

  // Sort by recency so model sees freshest first; tag [RECENT] for <=6h
  const sorted = [...articles].sort((a, b) => (a.hoursAgo || 99) - (b.hoursAgo || 99));
  const list = sorted.map((a, i) => {
    const tag = (a.hoursAgo || 99) <= 6 ? " [RECENT]" : "";
    return `${i}: [${a.source}${tag}] ${a.headline}`;
  }).join("\n");
  const sortedToOrig = sorted.map(a => articles.indexOf(a));

  const prompt = [
    "Score each headline for who is gaining momentum in the Iran conflict. Scale 1-5:",
    "1 = Iran/proxies achieving major victory OR US/Israel suffering major losses",
    "2 = Iran/proxies gaining OR Iran asserting/threatening/defying OR US/Israel under pressure",
    "3 = GENUINELY neutral ONLY — both sides in dialogue with no clear winner, pure market data with no conflict cause",
    "4 = US/Israel gaining OR Iran suffering setbacks OR Iran isolated/constrained/sanctioned",
    "5 = US/Israel achieving major victory OR Iran/proxies suffering major losses",
    "MILITARY — always directional, never 3:",
    "- Strikes ON Iran/proxies = 4 or 5. Strikes BY Iran/proxies = 1 or 2.",
    "- Iran casualties/destroyed/killed = 4. US/Israel casualties = 1 or 2.",
    "- High death toll IN Iran or Tehran = 4. High death toll IN Israel/US bases = 1 or 2.",
    "- Iran losing soldiers, commanders, ships, aircraft = 4. Israel/US losing these = 1 or 2.",
    "DIPLOMATIC:",
    "- US/EU sanctions on Iran, Iran denied access, Iran isolated = 4",
    "- Iran enriching uranium, Iran defiant, Iran threatening = 2",
    "- Ceasefire both sides agree to = 3. Talks collapse = 2.",
    "ECONOMIC:",
    "- Iran economy hurting, oil exports blocked = 4",
    "- Iran securing trade deals, bypassing sanctions = 2",
    "- Brent moves with no stated conflict cause = 3",
    "RULE: Only score 3 when there is genuinely zero directional signal.",
    "When uncertain between 2/3 choose 2. When uncertain between 3/4 choose 4.",
    `Return ONLY a JSON array: [{"i":0,"m":4},{"i":1,"m":2}]`,
    "Headlines:", list,
  ].join("\n");

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "anthropic-version": "2023-06-01", "x-api-key": anthropicKey },
      body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 3000, messages: [{ role: "user", content: prompt }] }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) return { articles: articles.map(a => ({ ...a, momentum: 3 })), reason: null };
    const data = await res.json();
    const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("");
    const clean = text.replace(/```[\w]*\n?/g, "").replace(/```/g, "").trim();
    const scores = JSON.parse(clean.match(/\[[\s\S]*\]/)?.[0] || "[]");

    // Remap sorted indices back to original
    const scoredArticles = articles.map((a, origIdx) => {
      const sortedIdx = sortedToOrig.indexOf(origIdx);
      const s = scores.find(x => x.i === sortedIdx);
      return { ...a, momentum: s?.m ?? 3 };
    });

    // Compute 6h average from actual scores, then generate reason in separate call
    const recent6 = scoredArticles.filter(a => (a.hoursAgo || 99) <= 6 && a.momentum !== 3);
    const recent6Avg = recent6.length
      ? recent6.reduce((s, a) => s + a.momentum, 0) / recent6.length
      : null;
    const recentDir = recent6Avg === null ? "mixed"
      : recent6Avg < 2.5 ? "Iran gained momentum"
      : recent6Avg > 3.5 ? "US/Israel gained momentum"
      : "mixed/neutral";

    const recentHeadlines = sorted
      .filter(a => (a.hoursAgo || 99) <= 6)
      .map(a => `[${a.source}] ${a.headline}`)
      .join("\n") || null;

    const reason = await generateReason(recentHeadlines, recentDir, anthropicKey);
    return { articles: scoredArticles, reason };
  } catch {
    return { articles: articles.map(a => ({ ...a, momentum: 3 })), reason: null };
  }
}

// ── Brave side fetch ──────────────────────────────────────────────────────────
async function fetchBraveSide(side, braveKey, force = false) {
  const results = await Promise.all(
    BRAVE_SOURCES[side].map(async ({ name, query }) => {
      const articles = await braveSearch(query, braveKey, force).catch(() => []);
      return articles.map(a => ({ ...a, source: name }));
    })
  );
  return results.flat().map(a => ({ ...a, hoursAgo: parseAgeToHours(a.age) }));
}

// ── Deduplication ─────────────────────────────────────────────────────────────
function headlineFingerprint(h) {
  return h.toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim().split(" ").slice(0, 8).join(" ");
}

function extractQuotedPhrases(h) {
  return (h.match(/"([^"]{10,})"/g) || []).map(m => m.toLowerCase().replace(/"/g, "").trim());
}

function isSimilar(a, b) {
  const fa = headlineFingerprint(a), fb = headlineFingerprint(b);
  const wa = new Set(fa.split(" ")), wb = new Set(fb.split(" "));
  const intersection = [...wa].filter(w => wb.has(w)).length;
  const union = new Set([...wa, ...wb]).size;
  if (intersection / union > 0.6) return true;
  const qa = extractQuotedPhrases(a), qb = extractQuotedPhrases(b);
  return qa.some(p => qb.includes(p));
}

function mergeAndDedupe(rssArticles, braveArticles) {
  const all = [...rssArticles, ...braveArticles];
  const kept = [];
  for (const a of all) {
    if (!kept.some(k => isSimilar(k.headline, a.headline))) kept.push(a);
  }
  return kept;
}

// ── Main orchestrator ─────────────────────────────────────────────────────────
async function fetchAllSides(braveKey, anthropicKey, force = false) {
  const [rssItems, westBrave, iranBrave, rucnBrave] = await Promise.all([
    fetchGoogleNewsRSS().catch(() => []),
    fetchBraveSide("west", braveKey, force).catch(() => []),
    fetchBraveSide("iran", braveKey, force).catch(() => []),
    fetchBraveSide("rucn", braveKey, force).catch(() => []),
  ]);

  const rssWest = [], rssIran = [], rssRucn = [];
  for (const item of rssItems) {
    const wSrc = getDomainSource(item.link, WESTERN_DOMAINS);
    const iSrc = getDomainSource(item.link, IRAN_DOMAINS);
    const rSrc = getDomainSource(item.link, RUCN_DOMAINS);
    const pubDate = parseRSSDate(item.pubDate);
    const hoursAgo = pubDate ? (Date.now() - pubDate.getTime()) / 3600000 : null;
    const base = { headline: item.title, url: item.link, summary: item.desc || "", hoursAgo };
    if (wSrc)      rssWest.push({ ...base, source: wSrc });
    else if (iSrc) rssIran.push({ ...base, source: iSrc });
    else if (rSrc) rssRucn.push({ ...base, source: rSrc });
  }

  const west = mergeAndDedupe(rssWest, westBrave).slice(0, 40);
  const iran = mergeAndDedupe(rssIran, iranBrave).slice(0, 40);
  const rucn = mergeAndDedupe(rssRucn, rucnBrave).slice(0, 40);

  const allArticles = [...west, ...iran, ...rucn];
  const { articles: scored, reason: sentimentReason } = await scoreMomentum(allArticles, anthropicKey);

  const scoredWest = scored.slice(0, west.length);
  const scoredIran = scored.slice(west.length, west.length + iran.length);
  const scoredRucn = scored.slice(west.length + iran.length);

  return {
    west:  categoriseArticles(scoredWest),
    iran:  categoriseArticles(scoredIran),
    rucn:  categoriseArticles(scoredRucn),
    sentimentReason,
  };
}

// ── Handler ───────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(200).end();

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const braveKey = process.env.BRAVE_API_KEY;
  if (!anthropicKey) return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });
  if (!braveKey) return res.status(500).json({ error: "BRAVE_API_KEY not configured" });

  const force = req.query.force === "1";
  const debug = req.query.debug === "1";
  const now = Date.now();

  if (!force && now - lastFetchStarted < FETCH_COOLDOWN_MS && cache.inFlight) {
    try { return res.status(200).json(await cache.inFlight); }
    catch (e) { return res.status(500).json({ error: e.message }); }
  }

  if (!force && cache.data && (now - cache.cachedAt) < CACHE_TTL_MS) {
    if (debug) return res.status(200).json({ ...cache.data, cached: true, cachedAt: cache.cachedAt, age: now - cache.cachedAt });
    return res.status(200).json({ ...cache.data, cachedAt: cache.cachedAt });
  }

  lastFetchStarted = now;
  cache.inFlight = fetchAllSides(braveKey, anthropicKey, force);
  try {
    const data = await cache.inFlight;
    cache = { data, cachedAt: now, inFlight: null };
    return res.status(200).json({ ...data, cachedAt: now });
  } catch (e) {
    cache.inFlight = null;
    if (cache.data) return res.status(200).json({ ...cache.data, error: e.message });
    return res.status(500).json({ error: e.message });
  }
}
