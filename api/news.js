// api/news.js — Google News RSS (real-time) + Brave Search (coverage), Claude for momentum scoring

const CACHE_TTL_MS = 2 * 60 * 60 * 1000;
let cache = { data: null, cachedAt: 0, inFlight: null };
let lastFetchStarted = 0;
const FETCH_COOLDOWN_MS = 5000;

// Google News RSS queries — near real-time, no API key needed
const GNEWS_QUERIES = [
  { q: "Iran Israel war",          label: "Google News" },
  { q: "Iran strike attack",       label: "Google News" },
  { q: "Iran missile bomb",        label: "Google News" },
  { q: "Iran US military",         label: "Google News" },
  { q: "Iran nuclear deal sanction",label: "Google News" },
  { q: "Tehran Beirut conflict",   label: "Google News" },
];

// Western news sites mapped for source attribution from Google RSS
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
  "washingtonpost.com": "Washington Post",
  "wsj.com": "Wall Street Journal",
  "axios.com": "Axios",
  "politico.com": "Politico",
  "nbcnews.com": "NBC News",
  "abcnews.go.com": "ABC News",
  "foxnews.com": "Fox News",
  "thehill.com": "The Hill",
  "haaretz.com": "Haaretz",
  "jpost.com": "Jerusalem Post",
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

// Brave sources as backup / for Iran & Russian sources
const BRAVE_SOURCES = {
  west: [
    { name: "BBC News",        query: "Iran war site:bbc.com" },
    { name: "Reuters",         query: "Iran war site:reuters.com" },
    { name: "CNN",             query: "Iran war site:cnn.com" },
    { name: "AP News",         query: "Iran war site:apnews.com" },
    { name: "CBS News",        query: "Iran war site:cbsnews.com" },
    { name: "New York Times",  query: "Iran war site:nytimes.com" },
    { name: "Al Jazeera",      query: "Iran conflict site:aljazeera.com" },
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

// ── Google News RSS fetch ──────────────────────────────────────────────────────
function getDomainSource(url, domainMap) {
  try {
    const hostname = new URL(url).hostname.replace("www.", "");
    for (const [domain, name] of Object.entries(domainMap)) {
      if (hostname.includes(domain)) return name;
    }
  } catch {}
  return null;
}

function parseRSSDate(dateStr) {
  if (!dateStr) return 999;
  try {
    const ms = Date.now() - new Date(dateStr).getTime();
    return Math.max(0, Math.round(ms / 3600000));
  } catch { return 999; }
}

// Parse Google News RSS XML — extract items with title, link, pubDate, source
function parseRSSXML(xml) {
  const items = [];
  const itemMatches = xml.matchAll(/<item>([\s\S]*?)<\/item>/g);
  for (const match of itemMatches) {
    const block = match[1];
    const title   = (block.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) || block.match(/<title>(.*?)<\/title>/))?.[1]?.trim() || "";
    const link    = (block.match(/<link>(.*?)<\/link>/) || block.match(/<feedburner:origLink>(.*?)<\/feedburner:origLink>/))?.[1]?.trim() || "";
    const pubDate = block.match(/<pubDate>(.*?)<\/pubDate>/)?.[1]?.trim() || "";
    const sourceName = block.match(/<source[^>]*>(.*?)<\/source>/)?.[1]?.trim() || "";
    const desc    = (block.match(/<description><!\[CDATA\[(.*?)\]\]><\/description>/) || block.match(/<description>(.*?)<\/description>/))?.[1]?.trim() || "";
    // Clean HTML from description
    const summary = desc.replace(/<[^>]*>/g, "").replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&quot;/g,'"').trim();
    if (title && link) items.push({ title, link, pubDate, sourceName, summary });
  }
  return items;
}

async function fetchGoogleNewsRSS() {
  const results = await Promise.all(
    GNEWS_QUERIES.map(async ({ q }) => {
      try {
        const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;
        const res = await fetch(url, {
          headers: { "User-Agent": "Mozilla/5.0 (compatible; NewsBot/1.0)", "Accept": "application/rss+xml, application/xml, text/xml" },
          signal: AbortSignal.timeout(6000),
        });
        if (!res.ok) return [];
        const xml = await res.text();
        return parseRSSXML(xml);
      } catch { return []; }
    })
  );

  const allItems = results.flat();
  // Deduplicate by URL
  const seen = new Set();
  const unique = allItems.filter(item => {
    if (seen.has(item.link)) return false;
    seen.add(item.link);
    return true;
  });

  // Classify each item into west/iran/rucn based on domain
  const west = [], iran = [], rucn = [], other = [];
  for (const item of unique) {
    const hoursAgo = parseRSSDate(item.pubDate);
    if (hoursAgo > 72) continue;
    // Try to get real URL from Google redirect
    const realUrl = item.link;
    const westSource = getDomainSource(realUrl, WESTERN_DOMAINS) || (item.sourceName && Object.values(WESTERN_DOMAINS).includes(item.sourceName) ? item.sourceName : null);
    const iranSource = getDomainSource(realUrl, IRAN_DOMAINS) || (item.sourceName && Object.values(IRAN_DOMAINS).includes(item.sourceName) ? item.sourceName : null);
    const rucnSource = getDomainSource(realUrl, RUCN_DOMAINS) || (item.sourceName && Object.values(RUCN_DOMAINS).includes(item.sourceName) ? item.sourceName : null);

    const article = {
      headline: item.title.replace(/\s*-\s*[^-]+$/, "").trim(), // strip " - Source Name" suffix
      url: realUrl,
      summary: item.summary || "",
      age: item.pubDate,
      hoursAgo,
      source: westSource || iranSource || rucnSource || item.sourceName || "Google News",
      fromRSS: true,
    };

    if (iranSource) iran.push(article);
    else if (rucnSource) rucn.push(article);
    else if (westSource) west.push(article);
    else west.push(article); // default to west if unknown (Google News tends to surface western sources)
  }

  return { west, iran, rucn };
}

// ── Brave Search ──────────────────────────────────────────────────────────────
async function braveSearch(query, braveKey, force = false) {
  const freshness = force ? "pd1" : "pd3";
  const url = `https://api.search.brave.com/res/v1/news/search?q=${encodeURIComponent(query)}&count=3&freshness=${freshness}`;
  const res = await fetch(url, {
    headers: {
      "Accept": "application/json",
      "Accept-Encoding": "gzip",
      "X-Subscription-Token": braveKey,
      ...(force ? { "Cache-Control": "no-cache" } : {}),
    },
    signal: AbortSignal.timeout(4000),
  });
  if (!res.ok) return [];
  const data = await res.json();
  if (force && (!data.results || data.results.length === 0)) {
    const fallback = await fetch(
      `https://api.search.brave.com/res/v1/news/search?q=${encodeURIComponent(query)}&count=3&freshness=pd3`,
      { headers: { "Accept": "application/json", "Accept-Encoding": "gzip", "X-Subscription-Token": braveKey }, signal: AbortSignal.timeout(4000) }
    ).catch(() => null);
    if (!fallback?.ok) return [];
    const fb = await fallback.json();
    return (fb.results || []).map(r => ({ headline: r.title || "", url: r.url || "", summary: r.description || "", age: r.age || r.page_age || "" }));
  }
  return (data.results || []).map(r => ({ headline: r.title || "", url: r.url || "", summary: r.description || "", age: r.age || r.page_age || "" }));
}

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
  try {
    const ms = Date.now() - new Date(age).getTime();
    return Math.round(ms / 3600000);
  } catch { return 999; }
}

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
    for (const rule of rules) {
      if (rule.words.some(w => text.includes(w))) return { ...a, category: rule.cat, score: rule.score };
    }
    return { ...a, category: "Political", score: 3 };
  });
}

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
    "CRITICAL RULES:",
    "- Israeli/US strikes ON Iran = score 4 or 5",
    "- Iranian/proxy strikes ON Israel/US = score 1 or 2",
    "- Iran being hit, bombed, killed, struck, destroyed = score 4 or 5",
    "- Iran hitting, striking, destroying enemy targets = score 1 or 2",
    "- Diplomatic, opinion, economic articles = score 3",
    "Return ONLY JSON array: [{\"i\":0,\"m\":3}]",
    "Headlines:", list,
  ].join("\n");
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "anthropic-version": "2023-06-01", "x-api-key": anthropicKey },
      body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 1200, messages: [{ role: "user", content: prompt }] }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return articles;
    const data = await res.json();
    const text = (data.content||[]).filter(b=>b.type==="text").map(b=>b.text).join("");
    const clean = text.replace(/```[\w]*\n?/g,"").replace(/```/g,"").trim();
    const scores = JSON.parse(clean.match(/\[[\s\S]*\]/)?.[0] || "[]");
    return articles.map((a, i) => { const s = scores.find(x => x.i === i); return { ...a, momentum: s?.m ?? 3 }; });
  } catch { return articles.map(a => ({ ...a, momentum: 3 })); }
}

async function fetchBraveSide(side, braveKey, force = false) {
  const results = await Promise.all(
    BRAVE_SOURCES[side].map(async ({ name, query }) => {
      const articles = await braveSearch(query, braveKey, force).catch(() => []);
      return articles.map(a => ({ ...a, source: name }));
    })
  );
  return results.flat().map(a => ({ ...a, hoursAgo: parseAgeToHours(a.age) }))
    .filter(a => a.hoursAgo <= 72 && a.headline.length > 5);
}

// Merge RSS + Brave, deduplicate by URL and similar headlines
function mergeAndDedupe(rssArticles, braveArticles) {
  const seen = new Set();
  const all = [];

  // RSS first (fresher)
  for (const a of rssArticles) {
    const key = a.url || a.headline.toLowerCase().slice(0, 60);
    if (!seen.has(key)) { seen.add(key); all.push(a); }
  }
  // Brave fills gaps
  for (const a of braveArticles) {
    const key = a.url || a.headline.toLowerCase().slice(0, 60);
    if (!seen.has(key)) { seen.add(key); all.push(a); }
  }
  return all;
}

async function fetchAllSides(braveKey, anthropicKey, force = false) {
  // Fetch RSS and all Brave sides in parallel
  const [rssData, braveWest, braveIran, braveRucn] = await Promise.all([
    fetchGoogleNewsRSS().catch(() => ({ west: [], iran: [], rucn: [] })),
    fetchBraveSide("west", braveKey, force).catch(() => []),
    fetchBraveSide("iran", braveKey, force).catch(() => []),
    fetchBraveSide("rucn", braveKey, force).catch(() => []),
  ]);

  // Merge RSS + Brave per side
  const westRaw  = mergeAndDedupe(rssData.west,  braveWest);
  const iranRaw  = mergeAndDedupe(rssData.iran,  braveIran);
  const rucnRaw  = mergeAndDedupe(rssData.rucn,  braveRucn);

  // Categorise
  const applyScoring = (articles) => {
    const categorised = categoriseArticles(articles);
    return categorised.map(a => {
      const bonus = a.hoursAgo <= 1 ? 4 : a.hoursAgo <= 3 ? 3 : a.hoursAgo <= 12 ? 2 : a.hoursAgo <= 24 ? 1 : a.hoursAgo <= 48 ? 0 : -1;
      return { ...a, score: Math.max(1, Math.min(7, a.score + bonus)) };
    }).sort((a, b) => (a.hoursAgo ?? 999) - (b.hoursAgo ?? 999));
  };

  const west = applyScoring(westRaw);
  const iran = applyScoring(iranRaw);
  const rucn = applyScoring(rucnRaw);

  // Score momentum in one Claude call
  const allArticles = [...west, ...iran, ...rucn];
  const scored = await scoreMomentum(allArticles, anthropicKey);
  const wLen = west.length, iLen = iran.length;

  return {
    west: scored.slice(0, wLen),
    iran: scored.slice(wLen, wLen + iLen),
    rucn: scored.slice(wLen + iLen),
    cachedAt: Date.now(),
    rssCount: rssData.west.length + rssData.iran.length + rssData.rucn.length,
  };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(200).end();

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const braveKey = process.env.BRAVE_API_KEY;
  if (!anthropicKey) return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });
  if (!braveKey) return res.status(500).json({ error: "BRAVE_API_KEY not configured" });

  if (req.query.debug === "1") {
    if (req.query.live !== "1") {
      return res.status(200).json({
        cacheStatus: cache.data ? "populated" : "empty",
        cachedAt: cache.cachedAt ? new Date(cache.cachedAt).toISOString() : null,
        cacheAgeSeconds: cache.cachedAt ? Math.round((Date.now() - cache.cachedAt) / 1000) : null,
        articleCounts: cache.data ? { west: cache.data.west?.length || 0, iran: cache.data.iran?.length || 0, rucn: cache.data.rucn?.length || 0 } : null,
        rssCount: cache.data?.rssCount ?? 0,
      });
    }
    // Test RSS only
    try {
      const rss = await fetchGoogleNewsRSS();
      return res.status(200).json({ rssWest: rss.west.slice(0,3), rssIran: rss.iran.slice(0,3), rssRucn: rss.rucn.slice(0,3), totalRSS: rss.west.length + rss.iran.length + rss.rucn.length });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  const force = req.query.force === "1";
  const now = Date.now();
  const stale = now - cache.cachedAt > CACHE_TTL_MS;

  if (force) {
    const timeSince = now - lastFetchStarted;
    if (timeSince < FETCH_COOLDOWN_MS) {
      return res.status(429).json({ cooldown: true, secondsRemaining: Math.ceil((FETCH_COOLDOWN_MS - timeSince) / 1000) });
    }
  }

  if (!force && !stale && cache.data) { res.setHeader("X-Cache", "HIT"); return res.status(200).json(cache.data); }
  if (!force && stale && cache.data && !cache.inFlight) {
    res.setHeader("X-Cache", "STALE");
    cache.inFlight = fetchAllSides(braveKey, anthropicKey, false)
      .then(data => { cache = { data, cachedAt: Date.now(), inFlight: null }; })
      .catch(() => { cache.inFlight = null; });
    return res.status(200).json(cache.data);
  }
  if (!force && cache.inFlight && cache.data) { res.setHeader("X-Cache", "STALE-INFLIGHT"); return res.status(200).json(cache.data); }

  try {
    res.setHeader("X-Cache", "MISS");
    lastFetchStarted = Date.now();
    const data = await fetchAllSides(braveKey, anthropicKey, force);
    cache = { data, cachedAt: Date.now(), inFlight: null };
    return res.status(200).json(data);
  } catch(e) {
    if (cache.data) return res.status(200).json({ ...cache.data, error: e.message });
    return res.status(500).json({ error: e.message });
  }
}
