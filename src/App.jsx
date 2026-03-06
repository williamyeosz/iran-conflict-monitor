import { useState, useEffect, useCallback, useRef } from "react";

// ── Constants ──────────────────────────────────────────────────────────────
const CATEGORIES = ["Top", "Military", "Diplomatic", "Civilian", "Political", "Economic", "Oil"];
const CAT_COLORS = {
  Military: "#c0392b", Diplomatic: "#1a5276", Civilian: "#b7770d",
  Political: "#6c3483", Economic: "#1e8449", Oil: "#ca6f1e",
};
const SIDE_CONFIG = {
  west: { label: "Western & International", short: "Western & Intl",  color: "#1a3a6b", dot: "#2e6da4", subtitle: "BBC · CNN · AP · Reuters · NYT · CBS · NPR · Al Jazeera · Guardian · Times of Israel" },
  iran: { label: "Iran & Pro-Iran Media",   short: "Iran & Pro-Iran", color: "#1a5c38", dot: "#27a05a", subtitle: "Press TV · Al Mayadeen · IRNA · Tasnim · Mehr · Tehran Times" },
  rucn: { label: "Russia & China",          short: "Russia & China",  color: "#6b1a1a", dot: "#c0392b", subtitle: "RT · Sputnik · TASS · CGTN · Xinhua · Global Times" },
};
const TABS = ["west", "iran", "rucn"];

// ── News: fetch from server cache (/api/news) ─────────────────────────────
// Server runs Claude searches once per 15 min, caches result.
// All users get instant response. force=1 triggers a fresh search.
async function fetchNews(force = false) {
  const url = force ? "/api/news?force=1" : "/api/news";
  const res = await fetch(url, { signal: AbortSignal.timeout(70000) });
  if (res.status === 429) {
    const data = await res.json();
    if (data.cooldown) throw new CooldownError(data.secondsRemaining);
  }
  if (!res.ok) throw new Error(`Server error ${res.status}`);
  return res.json();
}

class CooldownError extends Error {
  constructor(seconds) {
    super(`Please wait ${seconds} more second${seconds === 1 ? "" : "s"} before refreshing.`);
    this.isCooldown = true;
    this.seconds = seconds;
  }
}

// ── Prices via server (/api/prices uses Brave) ───────────────────────────
async function fetchPrices() {
  try {
    const res = await fetch("/api/prices", { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return {};
    return res.json();
  } catch(e) { return {}; }
}

// ── PriceTicker ────────────────────────────────────────────────────────────
function PriceTicker({ prices, loading, isMobile }) {
  const items = [
    { key: "brent", label: "Brent",   decimals: 2 },
    { key: "ewy",   label: "EWY",     decimals: 2 },
    { key: "kospi", label: "KOSPI",   decimals: 0 },
    { key: "gold",  label: "Gold",    decimals: 0 },
    { key: "sp500", label: "S&P 500", decimals: 0 },
  ];
  return (
    <div style={{
      background: "#1c1c1c", display: "flex", alignItems: "center",
      overflowX: "auto", WebkitOverflowScrolling: "touch",
      padding: isMobile ? "0 16px" : "0 28px",
      height: "36px", msOverflowStyle: "none", scrollbarWidth: "none",
    }}>
      {items.map(({ key, label, decimals }, i) => {
        const d = prices[key];
        const up = d?.change >= 0;
        const chColor = !d ? "#555" : up ? "#5cb87a" : "#e06060";
        return (
          <div key={key} style={{
            display: "flex", alignItems: "center",
            gap: isMobile ? "6px" : "10px",
            padding: isMobile ? "0 12px" : "0 20px",
            borderLeft: i > 0 ? "1px solid #333" : "none",
            whiteSpace: "nowrap",
          }}>
            <span style={{ fontSize: "9.5px", color: "#888", fontFamily: "sans-serif" }}>{label}</span>
            {loading || !d ? (
              <span style={{ fontSize: "10px", color: "#444", fontFamily: "monospace", animation: "pulse 1.2s infinite" }}>···</span>
            ) : (
              <>
                <span style={{ fontSize: "10.5px", color: "#e0e0e0", fontFamily: "monospace", fontWeight: 600 }}>
                  {d.price != null ? d.price.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals }) : "—"}
                </span>
                <span style={{ fontSize: "9.5px", color: chColor, fontFamily: "monospace", fontWeight: 600 }}>
                  {up ? "▲" : "▼"}{Math.abs(d.change).toFixed(2)}%
                </span>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── MomentumBanner ────────────────────────────────────────────────────────
function MomentumBanner({ sentiment, brentChange }) {
  if (sentiment === null) return null;

  const momentumLabel = sentiment <= 1.5 ? "Iran Surging" : sentiment <= 2.5 ? "Iran Gaining" : sentiment >= 4.5 ? "US/Israel Surging" : sentiment >= 3.5 ? "US/Israel Gaining" : "Neutral";
  const momentumColor = sentiment <= 2 ? "#1a5c38" : sentiment >= 4 ? "#1a3a6b" : "#b7770d";
  const numFilled = sentiment === 1 ? 5 : sentiment === 2 ? 4 : sentiment === 3 ? 3 : sentiment === 4 ? 4 : 5;

  // Interpret the combination
  const brentUp = brentChange > 0.5;
  const brentDown = brentChange < -0.5;
  const iranGaining = sentiment <= 2.5;
  const usGaining = sentiment >= 3.5;

  let signal = null;
  if (iranGaining && brentUp)   signal = { text: "Iran gaining + Brent rising — supply disruption risk elevated", color: "#1a5c38", icon: "⚠" };
  else if (usGaining && brentDown) signal = { text: "US/Israel dominant + Brent falling — supply disruption risk easing", color: "#1a3a6b", icon: "↓" };
  else if (iranGaining && brentDown) signal = { text: "Iran gaining militarily but markets pricing in de-escalation", color: "#b7770d", icon: "~" };
  else if (usGaining && brentUp) signal = { text: "US/Israel winning but Brent rising — Iran threatening oil routes", color: "#b7770d", icon: "~" };

  return (
    <div style={{ background: "#111", borderBottom: "1px solid #2a2a2a", padding: "6px 24px", display: "flex", alignItems: "center", gap: "16px", flexWrap: "wrap" }}>
      {/* Momentum dots */}
      <div style={{ display: "flex", alignItems: "center", gap: "8px", flexShrink: 0 }}>
        <span style={{ fontSize: "8.5px", color: "#666", fontFamily: "sans-serif", textTransform: "uppercase", letterSpacing: "0.08em" }}>Momentum</span>
        <div style={{ display: "flex", gap: "3px" }}>
          {[1,2,3,4,5].map(n => {
            let filled = false;
            if (sentiment <= 2) filled = n <= numFilled;
            else if (sentiment >= 4) filled = n > (5 - numFilled);
            else filled = n >= 2 && n <= 4;
            return <div key={n} style={{ width: "7px", height: "7px", borderRadius: "50%", background: filled ? momentumColor : "#333" }} />;
          })}
        </div>
        <span style={{ fontSize: "8.5px", color: momentumColor, fontFamily: "sans-serif", fontWeight: 700, letterSpacing: "0.04em" }}>{momentumLabel}</span>
      </div>

      {/* Divider */}
      <div style={{ width: "1px", height: "14px", background: "#333", flexShrink: 0 }} />

      {/* Brent change */}
      {brentChange !== null && (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: "6px", flexShrink: 0 }}>
            <span style={{ fontSize: "8.5px", color: "#666", fontFamily: "sans-serif", textTransform: "uppercase", letterSpacing: "0.08em" }}>Brent</span>
            <span style={{ fontSize: "8.5px", fontFamily: "monospace", fontWeight: 700, color: brentUp ? "#5cb87a" : brentDown ? "#e06060" : "#888" }}>
              {brentUp ? "▲" : brentDown ? "▼" : "–"}{Math.abs(brentChange).toFixed(1)}% today
            </span>
          </div>
          <div style={{ width: "1px", height: "14px", background: "#333", flexShrink: 0 }} />
        </>
      )}

      {/* Combined signal */}
      {signal && (
        <div style={{ fontSize: "8.5px", color: signal.color, fontFamily: "sans-serif", fontStyle: "italic", flex: 1 }}>
          {signal.icon} {signal.text}
        </div>
      )}
    </div>
  );
}

// ── NewsCard ───────────────────────────────────────────────────────────────
function NewsCard({ item, side, aiSummary, summaryLoading }) {
  const cfg = SIDE_CONFIG[side];
  const catColor = CAT_COLORS[item.category] || "#555";
  const url = item.url || null;
  return (
    <div style={{ padding: "16px 0", borderBottom: "1px solid #e8e8e8" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "7px" }}>
        <span style={{ fontSize: "9px", fontWeight: 700, letterSpacing: "0.1em", color: catColor, textTransform: "uppercase", fontFamily: "sans-serif" }}>{item.category}</span>
        <span style={{ fontSize: "10px", color: "#ccc" }}>·</span>
        <span style={{ fontSize: "10px", color: "#aaa", fontFamily: "monospace" }}>
          {!item.hoursAgo || item.hoursAgo >= 999 ? "" :
           item.hoursAgo < 1 ? "Just now" :
           item.hoursAgo < 24 ? `${Math.round(item.hoursAgo)}h ago` :
           item.hoursAgo < 48 ? "Yesterday" :
           `${Math.round(item.hoursAgo / 24)}d ago`}
        </span>
      </div>
      {url ? (
        <a href={url} target="_blank" rel="noopener noreferrer" style={{ textDecoration: "none" }}>
          <h3 className="headline" style={{ fontSize: "16px", fontWeight: 700, color: "#111", lineHeight: 1.3, margin: "0 0 7px 0", fontFamily: "'Playfair Display', Georgia, serif", cursor: "pointer" }}>
            {item.headline}
          </h3>
        </a>
      ) : (
        <h3 style={{ fontSize: "16px", fontWeight: 700, color: "#111", lineHeight: 1.3, margin: "0 0 7px 0", fontFamily: "'Playfair Display', Georgia, serif" }}>
          {item.headline}
        </h3>
      )}
      {summaryLoading ? (
        <p style={{ fontSize: "12px", color: "#ccc", fontStyle: "italic", margin: "0 0 9px 0", animation: "pulse 1.2s infinite", fontFamily: "Georgia, serif" }}>Generating summary…</p>
      ) : (
        <p style={{ fontSize: "13px", color: "#444", lineHeight: 1.7, margin: "0 0 9px 0", fontFamily: "Georgia, serif" }}>{aiSummary || item.summary}</p>
      )}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
          <div style={{ width: "5px", height: "5px", borderRadius: "50%", background: cfg.dot, flexShrink: 0 }} />
          <span style={{ fontSize: "10.5px", color: "#999", fontStyle: "italic", fontFamily: "Georgia, serif" }}>{item.source}</span>
        </div>
        {url && (
          <a href={url} target="_blank" rel="noopener noreferrer" style={{
            background: "none", border: "none", cursor: "pointer",
            fontSize: "10px", color: "#aaa", fontFamily: "sans-serif",
            letterSpacing: "0.04em", padding: "2px 0", textDecoration: "none",
          }}>READ MORE ›</a>
        )}
      </div>
    </div>
  );
}

// ── NewsPane ───────────────────────────────────────────────────────────────
const PAGE_SIZE = 10;
const LOAD_SIZE = 5;

function NewsPane({ side, news, loading, loadingStatus, error, filter, isMobile, aiSummaries, summaryCache, summaryLoading }) {
  const cfg = SIDE_CONFIG[side];
  const [visible, setVisible] = useState(PAGE_SIZE);
  // Reset visible count when filter or tab changes
  useEffect(() => { setVisible(PAGE_SIZE); }, [filter, side]);

  const allFiltered = filter === "Top"
    ? [...news].sort((a, b) => (a.hoursAgo ?? 999) - (b.hoursAgo ?? 999))
    : [...news].filter(n => n.category === filter).sort((a, b) => (a.hoursAgo ?? 999) - (b.hoursAgo ?? 999));

  const shown   = allFiltered.slice(0, visible);
  const hasMore = visible < allFiltered.length;

  const loadMore = () => setVisible(v => Math.min(v + LOAD_SIZE, allFiltered.length));

  // Desktop: auto-load on scroll to bottom
  const bottomRef = useRef(null);
  const touchStartY = useRef(0);
  useEffect(() => {
    if (isMobile || !bottomRef.current) return;
    const obs = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting && hasMore) loadMore();
    }, { threshold: 0.5 });
    obs.observe(bottomRef.current);
    return () => obs.disconnect();
  }, [hasMore, isMobile, visible, filter, side]);

  // Mobile: overscroll past bottom to load more
  useEffect(() => {
    if (!isMobile) return;
    const onTouchStart = e => { touchStartY.current = e.touches[0].clientY; };
    const onTouchEnd = e => {
      const dy = touchStartY.current - e.changedTouches[0].clientY;
      const atBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 20;
      if (dy > 60 && atBottom && hasMore) loadMore();
    };
    window.addEventListener("touchstart", onTouchStart, { passive: true });
    window.addEventListener("touchend", onTouchEnd, { passive: true });
    return () => {
      window.removeEventListener("touchstart", onTouchStart);
      window.removeEventListener("touchend", onTouchEnd);
    };
  }, [hasMore, isMobile, visible, filter, side]);

  return (
    <div>
      {loading && (
        <div style={{ textAlign: "center", padding: "48px 0" }}>
          <div style={{ width: "20px", height: "20px", borderRadius: "50%", border: `2px solid ${cfg.color}30`, borderTopColor: cfg.color, animation: "spin 0.8s linear infinite", margin: "0 auto" }} />
          <p style={{ color: "#aaa", fontSize: "12px", marginTop: "12px", fontStyle: "italic", fontFamily: "Georgia, serif" }}>{loadingStatus}</p>
        </div>
      )}
      {error && (
        <div style={{ background: "#fef2f2", border: "1px solid #fecaca", borderRadius: "4px", padding: "10px 12px", color: "#991b1b", fontSize: "11px", fontFamily: "monospace", wordBreak: "break-all", margin: "12px 0" }}>{error}</div>
      )}
      <div style={{ animation: "fadeIn 0.4s ease" }}>
        {!loading && shown.length === 0 && !error && (
          <p style={{ padding: "40px 0", color: "#bbb", textAlign: "center", fontSize: "13px", fontStyle: "italic", fontFamily: "Georgia, serif" }}>No articles match this filter.</p>
        )}
        {shown.map((item, i) => <NewsCard key={i} item={item} side={side} aiSummary={aiSummaries ? (summaryCache?.[item.url] || null) : null} summaryLoading={aiSummaries && summaryLoading && !summaryCache?.[item.url]} />)}
      </div>

      {/* Sentinel / Load More */}
      {!loading && hasMore && (
        <div ref={bottomRef} style={{ textAlign: "center", padding: "20px 0 8px" }}>
          <button onClick={loadMore} style={{
            background: "none", border: "1px solid #ddd", cursor: "pointer",
            padding: "7px 20px", fontSize: "10px", color: "#999",
            fontFamily: "sans-serif", letterSpacing: "0.06em", fontWeight: 600,
          }}>LOAD MORE ›</button>
        </div>
      )}
      {!loading && !hasMore && allFiltered.length > 0 && (
        <p style={{ textAlign: "center", padding: "20px 0 8px", fontSize: "10px", color: "#ccc", fontFamily: "sans-serif", letterSpacing: "0.04em" }}>— END —</p>
      )}
    </div>
  );
}

// ── App ────────────────────────────────────────────────────────────────────
export default function App() {
  const [news,          setNews]          = useState({ west: [], iran: [], rucn: [] });
  const [loading,       setLoading]       = useState({ west: true, iran: true, rucn: true });
  const [loadingStatus, setLoadingStatus] = useState({ west: "Fetching feeds…", iran: "Fetching feeds…", rucn: "Fetching feeds…" });
  const [error,         setError]         = useState({ west: null, iran: null, rucn: null });
  const [prices,        setPrices]        = useState({});
  const [pricesLoading, setPricesLoading] = useState(true);
  const [filter,        setFilter]        = useState("Top");
  const [activeTab,     setActiveTab]     = useState("west");
  const [lastUpdated,   setLastUpdated]   = useState(null);
  const [isMobile,      setIsMobile]      = useState(false);
  const [aiSummaries,   setAiSummaries]   = useState(false);
  const [sentiment,     setSentiment]     = useState(null);
  const [summaryCache,  setSummaryCache]  = useState({ west: {}, iran: {}, rucn: {} });
  const [summaryLoading,setSummaryLoading]= useState(false);


  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 680);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  const fetchAll = useCallback(async (force = false) => {
    setPricesLoading(true);
    setLoading({ west: true, iran: true, rucn: true });
    setError({ west: null, iran: null, rucn: null });
    setLoadingStatus({ west: "Loading…", iran: "Loading…", rucn: "Loading…" });

    // Prices and news in parallel
    fetchPrices().then(p => { setPrices(p); setPricesLoading(false); });

    try {
      const data = await fetchNews(force);
      setNews({ west: data.west || [], iran: data.iran || [], rucn: data.rucn || [] });
      setError({
        west:  (!data.west  || data.west.length  === 0) ? "No articles found." : null,
        iran:  (!data.iran  || data.iran.length  === 0) ? "No articles found." : null,
        rucn:  (!data.rucn  || data.rucn.length  === 0) ? "No articles found." : null,
      });
      if (data.cachedAt) setLastUpdated(new Date(data.cachedAt));
      else setLastUpdated(new Date());
      // Compute momentum from Claude-scored articles
      const allArticles = [...(data.west||[]), ...(data.iran||[]), ...(data.rucn||[])];
      const now12  = allArticles.filter(a => (a.hoursAgo||99) <= 12  && a.momentum != null);
      const prev12 = allArticles.filter(a => (a.hoursAgo||99) > 12  && (a.hoursAgo||99) <= 24 && a.momentum != null);
      const avg = arr => arr.length ? arr.reduce((s, a) => s + a.momentum, 0) / arr.length : null;
      const m0 = avg(now12), m1 = avg(prev12);
      // Use recent average, adjusted by trend vs previous period
      const base = m0 ?? avg(allArticles.filter(a => a.momentum != null)) ?? 3;
      const trend = (m0 != null && m1 != null) ? (m0 - m1) * 0.5 : 0;
      setSentiment(Math.max(1, Math.min(5, Math.round((base + trend) * 2) / 2)));
    } catch(e) {
      if (e.isCooldown) {
        // Show cooldown message on active tab only, don't wipe existing articles
        setError(p => ({ ...p, [activeTab]: e.message }));
        setLoading({ west: false, iran: false, rucn: false });
        return;
      }
      setError({ west: e.message, iran: e.message, rucn: e.message });
    }
    setLoading({ west: false, iran: false, rucn: false });
  }, []);
  useEffect(() => { fetchAll(); }, [fetchAll]);

  const fetchSummaries = useCallback(async (tab) => {
    const articles = news[tab];
    if (!articles?.length) return;
    const needed = articles.filter(a => a.url && !summaryCache[tab][a.url]);
    if (!needed.length) return;
    setSummaryLoading(true);
    try {
      const res = await fetch("/api/summaries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ articles: needed.map(a => ({ url: a.url, headline: a.headline, source: a.source, summary: a.summary })) }),
        signal: AbortSignal.timeout(60000),
      });
      const data = await res.json();
      if (data.summaries) {
        setSummaryCache(prev => {
          const updated = { ...prev[tab] };
          data.summaries.forEach((s, i) => { if (needed[i]) updated[needed[i].url] = s.summary; });
          return { ...prev, [tab]: updated };
        });
      }
    } catch(e) { console.error("Summary fetch failed:", e); }
    setSummaryLoading(false);
  }, [news, summaryCache]);

  useEffect(() => {
    if (aiSummaries) fetchSummaries(activeTab);
  }, [aiSummaries, activeTab]);


  const isLoading = Object.values(loading).some(Boolean);
  const cfg       = SIDE_CONFIG[activeTab];
  const brentChange = prices?.brent?.change ?? null;

  return (
    <div style={{ minHeight: "100vh", background: "#f5f4f0", fontFamily: "Georgia, serif" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;600;700;900&family=Source+Sans+3:ital,wght@0,300;0,400;0,600;1,400&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        @keyframes pulse  { 0%,100%{opacity:1} 50%{opacity:0.35} }
        @keyframes fadeIn { from{opacity:0;transform:translateY(5px)} to{opacity:1;transform:translateY(0)} }
        @keyframes spin   { from{transform:rotate(0deg)} to{transform:rotate(360deg)} }
        ::-webkit-scrollbar { display: none; }
        .headline:hover  { color: #1a3a6b !important; transition: color 0.15s; }
        .tab-btn         { transition: background 0.12s, color 0.12s, border-color 0.12s; }
        .filter-btn      { transition: background 0.12s, color 0.12s, border-color 0.12s; }
        .tab-btn:hover   { background: #f0ede6 !important; }
        .filter-btn:hover{ border-color: #999 !important; color: #333 !important; }
        .drawer-overlay { animation: overlayIn 0.2s ease; }
        .drawer-panel   { animation: drawerUp 0.28s cubic-bezier(0.32,0.72,0,1); }
        @keyframes overlayIn { from{opacity:0} to{opacity:1} }
        @keyframes drawerUp  { from{transform:translateY(100%)} to{transform:translateY(0)} }
        .close-btn:hover { background: #e5e5e5 !important; }
        .read-btn:hover  { background: #333 !important; }
      `}</style>

      <PriceTicker prices={prices} loading={pricesLoading} isMobile={isMobile} />
      {/* Sticky header */}
      <div style={{ position: "sticky", top: 0, zIndex: 100, background: "#fff", borderBottom: "1px solid #ddd", boxShadow: "0 1px 6px rgba(0,0,0,0.06)" }}>
        <MomentumBanner sentiment={sentiment} brentChange={brentChange} />
        <div style={{ maxWidth: "720px", margin: "0 auto", padding: isMobile ? "10px 16px 0" : "12px 24px 0" }}>

          {/* Title row — full width, no buttons */}
          <div style={{ marginBottom: "6px" }}>
            {!isMobile && (
              <div style={{ fontSize: "9px", color: "#bbb", letterSpacing: "0.12em", fontFamily: "sans-serif", textTransform: "uppercase", marginBottom: "4px" }}>
                {new Date().toLocaleDateString("en-GB", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}
                {lastUpdated && <span style={{ marginLeft: "10px", fontFamily: "monospace" }}>· Updated {lastUpdated.toLocaleTimeString()}</span>}
              </div>
            )}
            <div style={{ borderTop: isMobile ? "2px solid #111" : "3px solid #111", paddingTop: isMobile ? "4px" : "6px" }}>
              <h1 style={{ fontSize: isMobile ? "22px" : "30px", fontWeight: 900, color: "#111", fontFamily: "'Playfair Display', Georgia, serif", letterSpacing: "-0.02em", lineHeight: 1 }}>
                Iran Conflict Monitor
              </h1>
            </div>
          </div>

          {/* Subtitle + buttons row */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
            {!isMobile && (
              <p style={{ fontSize: "10.5px", color: "#aaa", fontStyle: "italic", lineHeight: 1.5, fontFamily: "sans-serif" }}>
                AI-powered news · Understand the conflict from different perspectives
              </p>
            )}
            {isMobile && <div />}
            <div style={{ display: "flex", alignItems: "center", gap: "8px", flexShrink: 0 }}>
              <span style={{ fontSize: "8px", color: "#bbb", fontFamily: "sans-serif", textAlign: "right", lineHeight: 1.4, maxWidth: "90px" }}>
                {aiSummaries ? "AI summaries on" : "Summarizes with AI. May take a few seconds."}
              </span>
              <button onClick={() => setAiSummaries(v => !v)} style={{
                background: aiSummaries ? "#1a3a6b" : "transparent",
                color: aiSummaries ? "#fff" : "#aaa",
                border: `1px solid ${aiSummaries ? "#1a3a6b" : "#ddd"}`,
                padding: "5px 9px", fontSize: "10px", fontWeight: 600,
                cursor: "pointer", letterSpacing: "0.04em", fontFamily: "sans-serif",
                whiteSpace: "nowrap",
              }}>
                ✦ {aiSummaries ? "AI ON" : "AI"}
              </button>
              <button onClick={() => fetchAll(true)} disabled={isLoading} style={{
                background: "#111", color: isLoading ? "#888" : "#fff", border: "none",
                padding: isMobile ? "6px 11px" : "6px 14px",
                fontSize: isMobile ? "10px" : "10.5px", fontWeight: 600,
                cursor: isLoading ? "not-allowed" : "pointer",
                letterSpacing: "0.06em", fontFamily: "sans-serif",
                display: "flex", alignItems: "center", gap: "5px",
                whiteSpace: "nowrap",
              }}>
                <span style={isLoading ? { animation: "spin 1s linear infinite", display: "inline-block" } : {}}>↻</span>
                {isLoading ? "LOADING…" : "REFRESH"}
              </button>
            </div>
          </div>

          {/* Category filters */}
          <div style={{ display: "flex", gap: "5px", flexWrap: isMobile ? "nowrap" : "wrap", overflowX: isMobile ? "auto" : "visible", WebkitOverflowScrolling: "touch", marginBottom: isMobile ? "10px" : "12px" }}>
            {CATEGORIES.filter(cat => {
              if (cat === "Top") return true;
              const articles = Array.isArray(news[activeTab]) ? news[activeTab] : [];
              return articles.some(a => a.category === cat);
            }).map(cat => {
              const active = filter === cat;
              const cc = CAT_COLORS[cat] || "#333";
              return (
                <button key={cat} className="filter-btn" onClick={() => setFilter(cat)} style={{
                  padding: "3px 10px", fontSize: "10px", fontWeight: active ? 700 : 400,
                  cursor: "pointer", whiteSpace: "nowrap", flexShrink: 0,
                  border: `1px solid ${active ? cc : "#ddd"}`,
                  background: active ? `${cc}10` : "transparent",
                  color: active ? cc : "#999",
                  fontFamily: "sans-serif", letterSpacing: "0.02em",
                }}>{cat}</button>
              );
            })}
          </div>

          {aiSummaries && summaryLoading && (
            <p style={{ fontSize: "10px", color: "#888", fontStyle: "italic", fontFamily: "sans-serif", marginBottom: "8px" }}>
              ✦ Fetching full articles and generating AI summaries…
            </p>
          )}
          {/* Perspective tabs */}
          <div style={{ display: "flex", borderTop: "1px solid #eee" }}>
            {TABS.map((tab, i) => {
              const c = SIDE_CONFIG[tab];
              const active = activeTab === tab;
              return (
                <button key={tab} className="tab-btn" onClick={() => { setActiveTab(tab); setFilter("Top"); }} style={{
                  flex: 1, padding: isMobile ? "9px 4px 8px" : "10px 8px 9px",
                  background: active ? "#fff" : "#f9f8f5", border: "none",
                  borderTop: active ? `2px solid ${c.color}` : "2px solid transparent",
                  borderRight: i < 2 ? "1px solid #eee" : "none",
                  color: active ? c.color : "#999",
                  fontSize: isMobile ? "10px" : "11px", fontWeight: active ? 700 : 400,
                  cursor: "pointer", fontFamily: "sans-serif", letterSpacing: "0.02em", lineHeight: 1.3,
                }}>
                  <div>{c.short.toUpperCase()}</div>
                  {active && !isMobile && (
                    <div style={{ fontSize: "9px", color: "#bbb", fontWeight: 400, marginTop: "2px", fontStyle: "italic" }}>{c.subtitle}</div>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Article list */}
      <div style={{ maxWidth: "720px", margin: "0 auto", background: "#fff", borderLeft: "1px solid #ddd", borderRight: "1px solid #ddd", borderBottom: "1px solid #ddd" }}>
        <div style={{ padding: isMobile ? "0 16px 32px" : "0 24px 48px" }}>
          <div style={{ borderTop: `2px solid ${cfg.color}` }} />
          <NewsPane
            side={activeTab}
            news={news[activeTab]}
            loading={loading[activeTab]}
            loadingStatus={loadingStatus[activeTab]}
            error={error[activeTab]}
            filter={filter}
            isMobile={isMobile}
            aiSummaries={aiSummaries}
            summaryCache={summaryCache[activeTab]}
            summaryLoading={summaryLoading}
          />
        </div>
      </div>

      <footer style={{ background: "#111", color: "#555", padding: isMobile ? "12px 16px" : "14px 24px", fontSize: "9.5px", fontFamily: "sans-serif", textAlign: "center", letterSpacing: "0.08em" }}>
        IRAN CONFLICT MONITOR &nbsp;·&nbsp; LIVE RSS FEEDS &nbsp;·&nbsp; CLICK HEADLINE TO READ SOURCE
      </footer>

    </div>
  );
}
