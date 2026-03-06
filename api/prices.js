// api/prices.js — fetch market prices via Yahoo Finance (free, no key needed)

let cache = { data: null, cachedAt: 0 };
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 min

const SYMBOLS = [
  { key: "brent", symbol: "BZ=F",  label: "Brent" },
  { key: "ewy",   symbol: "EWY",   label: "EWY" },
  { key: "kospi", symbol: "^KS11", label: "KOSPI" },
  { key: "gold",  symbol: "GC=F",  label: "Gold" },
  { key: "sp500", symbol: "^GSPC", label: "S&P 500" },
];

async function fetchYahoo(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=2d`;
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0" },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Yahoo ${symbol} ${res.status}`);
  const data = await res.json();
  const meta = data?.chart?.result?.[0]?.meta;
  if (!meta) throw new Error(`No meta for ${symbol}`);

  const price = meta.regularMarketPrice ?? meta.previousClose;
  const prevClose = meta.chartPreviousClose ?? meta.previousClose;
  const change = prevClose ? ((price - prevClose) / prevClose) * 100 : 0;

  return { price: Math.round(price * 100) / 100, change: Math.round(change * 100) / 100 };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(200).end();

  const now = Date.now();
  if (cache.data && now - cache.cachedAt < CACHE_TTL_MS) {
    res.setHeader("X-Cache", "HIT");
    return res.status(200).json(cache.data);
  }

  try {
    const results = await Promise.all(
      SYMBOLS.map(async ({ key, symbol }) => {
        try {
          const data = await fetchYahoo(symbol);
          return [key, data];
        } catch(e) {
          const cached = cache.data?.[key];
          return [key, cached ?? null];
        }
      })
    );

    const prices = Object.fromEntries(results.filter(([, v]) => v !== null));
    cache = { data: prices, cachedAt: Date.now() };
    res.setHeader("X-Cache", "MISS");
    return res.status(200).json(prices);
  } catch(e) {
    if (cache.data) return res.status(200).json(cache.data);
    return res.status(500).json({ error: e.message });
  }
}
