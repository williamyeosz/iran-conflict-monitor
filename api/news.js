// api/news.js — Brave Search for articles, Claude for categorisation only

const CACHE_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours — keeps within Brave free tier
let cache = { data: null, cachedAt: 0, inFlight: null };
let lastFetchStarted = 0;
const FETCH_COOLDOWN_MS = 5000; // 5s — just prevents double-clicks

// Each source gets a targeted Brave search
const SOURCES = {
  west: [
    { name: "BBC News",        query: "Iran war site:bbc.com" },
    { name: "Reuters",         query: "Iran war site:reuters.com" },
    { name: "Al Jazeera",      query: "Iran conflict site:aljazeera.com" },
    { name: "New York Times",  query: "Iran war site:nytimes.com" },
    { name: "The Guardian",    query: "Iran conflict site:theguardian.com" },
    { name: "Times of Israel", query: "Iran war site:timesofisrael.com" },
    { name: "NPR",             query: "Iran conflict site:npr.org" },
  ],
  iran: [
    { name: "Press TV",        query: "Iran war site:presstv.ir" },
    { name: "Al Mayadeen",     query: "Iran resistance site:almayadeen.net" },
    { name: "IRNA",            query: "Iran site:irna.ir" },
    { name: "Tehran Times",    query: "Iran site:tehrantimes.com" },
    { name: "Tasnim News",     query: "Iran site:tasnimnews.com" },
    { name: "Mehr News",       query: "Iran site:mehrnews.com" },
  ],
  rucn: [
    { name: "RT",              query: "Iran war site:rt.com" },
    { name: "Sputnik",         query: "Iran war site:sputnikglobe.com" },
    { name: "TASS",            query: "Iran site:tass.com" },
    { name: "CGTN",            query: "Iran site:cgtn.com" },
    { name: "Xinhua",          query: "Iran site:english.news.cn" },
    { name: "Global Times",    query: "Iran site:globaltimes.cn" },
  ],
};

// Fetch top 2 results from Brave for a single source
async function braveSearch(query, braveKey) {
  const url = `https://api.search.brave.com/res/v1/news/search?q=${encodeURIComponent(query)}&count=3&freshness=pd2`; // pd2 = past 2 days // pd3 = past 3 days
  const res = await fetch(url, {
    headers: {
      "Accept": "application/json",
      "Accept-Encoding": "gzip",
      "X-Subscription-Token": braveKey,
    },
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) return [];
  const data = await res.json();
  return (data.results || []).map(r => ({
    headline: r.title || "",
    url: r.url || "",
    summary: r.description || "",
    age: r.age || r.page_age || "",  // e.g. "2 hours ago" or ISO date
  }));
}

// Convert Brave age string to hours
function parseAgeToHours(age) {
  if (!age) return 999;
  if (typeof age === "number") return age;
  const s = age.toLowerCase();
  const num = parseInt(s);
  if (isNaN(num)) return 999;
  if (s.includes("minute")) return Math.round(num / 60);
  if (s.includes("hour")) return num;
  if (s.includes("day")) return num * 24;
  if (s.includes("week")) return num * 168;
  // ISO date string
  try {
    const ms = Date.now() - new Date(age).getTime();
    return Math.round(ms / 3600000);
  } catch { return 999; }
}

// Keyword-based categorisation — instant, no API call needed
function categoriseArticles(articles) {
  const rules = [
    { cat: "Military",   score: 4, words: ["strike","attack","missile","bomb","airstrike","troops","military","soldiers","war","weapons","nuclear","drone","explosion","killed","forces","idf","irgc","navy","air force","tank","artillery","ammunition","rocket","ballistic","combat","casualt","wound","dead","death","destroy","target","intercept","iron dome","hezbollah","hamas","houthi"] },
    { cat: "Diplomatic", score: 3, words: ["talks","negotiat","sanction","ceasefire","deal","treaty","agreement","diplomacy","minister","ambassador","un ","united nations","envoy","summit","meeting","visit","secretary","foreign","bilateral","relations","statement","condemn","warn","demand","ultimatum"] },
    { cat: "Economic",   score: 3, words: ["oil","gas","price","barrel","economy","trade","export","import","bank","dollar","rial","currency","inflation","gdp","market","supply","energy","opec","sanction","revenue","budget","financial"] },
    { cat: "Oil",        score: 3, words: ["crude","brent","wti","petroleum","refinery","pipeline","tanker","strait of hormuz","oil field","opec","energy export","oil price","oil supply","oil production"] },
    { cat: "Civilian",   score: 2, words: ["civilian","hospital","school","refugee","displaced","humanitarian","aid","casualties","children","family","home","house","village","town","resident","population","food","water","shelter"] },
    { cat: "Political",  score: 3, words: ["government","president","minister","parliament","election","policy","regime","leader","official","political","party","supreme leader","khamenei","trump","biden","netanyahu","raisi","congress","white house","kremlin","beijing"] },
  ];

  return articles.map(a => {
    const text = (a.headline + " " + (a.summary || "")).toLowerCase();
    // Oil is more specific than Economic — check first
    for (const rule of rules) {
      if (rule.words.some(w => text.includes(w))) {
        return { ...a, category: rule.cat, score: rule.score };
      }
    }
    return { ...a, category: "Political", score: 3 };
  });
}

// Claude scores momentum for all articles — 1=Iran gaining, 5=US/Israel gaining
async function scoreMomentum(articles, anthropicKey) {
  if (!articles.length) return articles;
  const list = articles.map((a, i) => i + ": [" + a.source + "] " + a.headline).join("\n");
  const prompt = [
    "Score each headline for momentum in the Iran conflict on a scale 1-5:",
    "1 = Iran/proxies achieving major victory OR US/Israel suffering major losses",
    "2 = Iran/proxies making meaningful gains OR US/Israel under meaningful pressure",
    "3 = Neutral — diplomatic, economic, analytical, or unclear military impact",
    "4 = US/Israel making meaningful gains OR Iran/proxies suffering setbacks",
    "5 = US/Israel achieving major victory OR Iran/proxies suffering major losses",
    "",
    "CRITICAL RULES:",
    "- First ask: WHO is performing the action? WHO suffers the consequence?",
    "- Israeli/US strikes ON Iran = score 4 or 5 (bad for Iran)",
    "- Iranian/proxy strikes ON Israel/US = score 1 or 2 (good for Iran)",
    "- Iran being hit, bombed, killed, struck, destroyed = score 4 or 5",
    "- Iran hitting, striking, destroying enemy targets = score 1 or 2",
    "- Iran firing missiles (regardless of interception) = score 2",
    "- Iranian assets sunk/destroyed/killed = score 4 or 5",
    "- Diplomatic, opinion, economic, domestic political articles = score 3",
    "Return ONLY JSON array: [{\"i\":0,\"m\":3}]",
    "",
    "Headlines:",
    list,
  ].join("\n");
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "anthropic-version": "2023-06-01", "x-api-key": anthropicKey },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1200,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return articles;
    const data = await res.json();
    const text = (data.content||[]).filter(b=>b.type==="text").map(b=>b.text).join("");
    const clean = text.replace(/```[\w]*\n?/g,"").replace(/```/g,"").trim();
    const scores = JSON.parse(clean.match(/\[[\s\S]*\]/)?.[0] || "[]");
    return articles.map((a, i) => {
      const s = scores.find(x => x.i === i);
      return { ...a, momentum: s?.m ?? 3 };
    });
  } catch(e) { return articles.map(a => ({ ...a, momentum: 3 })); }
}

async function fetchSide(side, braveKey) {
  const results = await Promise.all(
    SOURCES[side].map(async ({ name, query }) => {
      const articles = await braveSearch(query, braveKey).catch(() => []);
      return articles.map(a => ({ ...a, source: name }));
    })
  );
  const flat = results.flat().map(a => ({
    ...a, hoursAgo: parseAgeToHours(a.age),
  })).filter(a => a.hoursAgo <= 72 && a.headline.length > 5);
  if (!flat.length) return [];
  const categorised = categoriseArticles(flat);
  return categorised.map(a => {
    const bonus = a.hoursAgo <= 3 ? 3 : a.hoursAgo <= 12 ? 2 : a.hoursAgo <= 24 ? 1 : a.hoursAgo <= 48 ? 0 : -1;
    return { ...a, score: Math.max(1, Math.min(7, a.score + bonus)) };
  }).sort((a, b) => a.hoursAgo - b.hoursAgo);
}

async function fetchAllSides(braveKey, anthropicKey) {
  // Step 1: fetch all sides in parallel
  const [west, iran, rucn] = await Promise.all([
    fetchSide("west", braveKey).catch(() => []),
    fetchSide("iran", braveKey).catch(() => []),
    fetchSide("rucn", braveKey).catch(() => []),
  ]);
  // Step 2: score momentum for all articles in one Claude call
  const allArticles = [...west, ...iran, ...rucn];
  const scored = await scoreMomentum(allArticles, anthropicKey);
  // Step 3: split back into sides preserving order
  const wLen = west.length, iLen = iran.length;
  return {
    west: scored.slice(0, wLen),
    iran: scored.slice(wLen, wLen + iLen),
    rucn: scored.slice(wLen + iLen),
    cachedAt: Date.now(),
  };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(200).end();

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const braveKey = process.env.BRAVE_API_KEY;
  if (!anthropicKey) return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });
  if (!braveKey) return res.status(500).json({ error: "BRAVE_API_KEY not configured" });

  // Debug endpoint — safe by default
  if (req.query.debug === "1") {
    if (req.query.live !== "1") {
      return res.status(200).json({
        cacheStatus: cache.data ? "populated" : "empty",
        cachedAt: cache.cachedAt ? new Date(cache.cachedAt).toISOString() : null,
        cacheAgeSeconds: cache.cachedAt ? Math.round((Date.now() - cache.cachedAt) / 1000) : null,
        cooldownRemainingSeconds: Math.max(0, Math.ceil((FETCH_COOLDOWN_MS - (Date.now() - lastFetchStarted)) / 1000)),
        articleCounts: cache.data ? { west: cache.data.west?.length || 0, iran: cache.data.iran?.length || 0, rucn: cache.data.rucn?.length || 0 } : null,
        sampleHeadlines: cache.data ? { west: cache.data.west?.[0]?.headline || null, iran: cache.data.iran?.[0]?.headline || null, rucn: cache.data.rucn?.[0]?.headline || null } : null,
      });
    }
    // ?debug=1&live=1 — test one Brave search + categorisation
    try {
      const src = SOURCES.west[0];
      const articles = await braveSearch(src.query, braveKey);
      const withAge = articles.map(a => ({ ...a, source: src.name, hoursAgo: parseAgeToHours(a.age) }));
      const categorised = categoriseArticles(withAge);
      return res.status(200).json({ source: src.name, raw: articles, categorised });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  const force = req.query.force === "1";
  const now = Date.now();
  const stale = now - cache.cachedAt > CACHE_TTL_MS;

  // Cooldown check on force refresh
  if (force) {
    const timeSince = now - lastFetchStarted;
    if (timeSince < FETCH_COOLDOWN_MS) {
      return res.status(429).json({ cooldown: true, secondsRemaining: Math.ceil((FETCH_COOLDOWN_MS - timeSince) / 1000) });
    }
  }

  if (!force && !stale && cache.data) {
    res.setHeader("X-Cache", "HIT");
    return res.status(200).json(cache.data);
  }
  if (!force && stale && cache.data && !cache.inFlight) {
    res.setHeader("X-Cache", "STALE");
    cache.inFlight = fetchAllSides(braveKey, anthropicKey)
      .then(data => { cache = { data, cachedAt: Date.now(), inFlight: null }; })
      .catch(() => { cache.inFlight = null; });
    return res.status(200).json(cache.data);
  }
  if (!force && cache.inFlight && cache.data) {
    res.setHeader("X-Cache", "STALE-INFLIGHT");
    return res.status(200).json(cache.data);
  }

  try {
    res.setHeader("X-Cache", "MISS");
    lastFetchStarted = Date.now();
    const data = await fetchAllSides(braveKey, anthropicKey);
    cache = { data, cachedAt: Date.now(), inFlight: null };
    return res.status(200).json(data);
  } catch(e) {
    if (cache.data) return res.status(200).json({ ...cache.data, error: e.message });
    return res.status(500).json({ error: e.message });
  }
}
