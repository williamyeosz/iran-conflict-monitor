// api/momentum-calibrate.js — test Claude momentum scoring with hypothetical headlines

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });

  const testArticles = [
    // Strait of Hormuz scenarios
    { source: "Reuters",       headline: "Iran closes Strait of Hormuz; oil tanker traffic halts completely" },
    { source: "BBC News",      headline: "Iran threatens to close Strait of Hormuz but ships continue passage" },
    { source: "Al Jazeera",    headline: "US Navy reopens Strait of Hormuz after Iranian blockade attempt fails" },
    // Proxy scenarios
    { source: "Reuters",       headline: "Hezbollah fires 500 rockets into northern Israel in largest barrage yet" },
    { source: "BBC News",      headline: "Israel destroys Hezbollah command structure in Lebanon ground offensive" },
    { source: "Al Mayadeen",   headline: "Houthi missiles hit Israeli port of Eilat, suspending operations" },
    // Nuclear scenarios
    { source: "Reuters",       headline: "Iran announces successful uranium enrichment to 90%; weapons-grade threshold crossed" },
    { source: "NYT",           headline: "US-Israel strike destroys Fordow nuclear facility; Iran enrichment capability eliminated" },
    // Diplomatic/political
    { source: "Reuters",       headline: "Iran agrees to ceasefire terms; withdraws missiles from forward positions" },
    { source: "Al Jazeera",    headline: "Arab states rally behind Iran; Saudi Arabia cuts US military ties" },
    // Ambiguous ones to test calibration
    { source: "BBC News",      headline: "IDF special forces conduct extraordinary operations deep inside Iran" },
    { source: "Times of Israel", headline: "Iranian missile barrage intercepted; Iron Dome performs at 94% efficiency" },
    { source: "TASS",          headline: "Iran fires 200 ballistic missiles at Israel in overnight salvo" },
    { source: "Reuters",       headline: "Iran's supreme leader Khamenei killed in Israeli airstrike" },
    { source: "Press TV",      headline: "IRGC destroys second US aircraft carrier in Gulf of Oman" },
  ];

  const list = testArticles.map((a, i) =>
    `${i}: [${a.source}] ${a.headline}`
  ).join("\n");

  const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
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
        `Score each headline for momentum in the Iran conflict on a scale 1-5:
1 = Iran/proxies achieving major victory OR US/Israel suffering major losses
2 = Iran/proxies making meaningful gains OR US/Israel under meaningful pressure
3 = Neutral — diplomatic, economic, analytical, or unclear military impact
4 = US/Israel making meaningful gains OR Iran/proxies suffering setbacks
5 = US/Israel achieving major victory OR Iran/proxies suffering major losses

CRITICAL RULES:
- First ask: WHO is performing the action? WHO suffers the consequence?
- Israeli/US strikes ON Iran = score 4 or 5 (bad for Iran)
- Iranian/proxy strikes ON Israel/US = score 1 or 2 (good for Iran)
- Iran being hit, bombed, killed, struck, destroyed = score 4 or 5
- Iran hitting, striking, destroying enemy targets = score 1 or 2
- Iranian assets sunk/destroyed/killed = score 4 or 5
- Diplomatic, opinion, economic, domestic political articles = score 3

Return ONLY JSON array, no markdown:
[{"i":0,"score":3,"reason":"one sentence explanation"}]

Headlines:
${list}` }],
    }),
    signal: AbortSignal.timeout(20000),
  });

  const data = await claudeRes.json();
  const text = (data.content||[]).filter(b=>b.type==="text").map(b=>b.text).join("");
  const clean = text.replace(/```[\w]*\n?/g,"").replace(/```/g,"").trim();

  let scores;
  try {
    scores = JSON.parse(clean.match(/\[[\s\S]*\]/)?.[0] || "[]");
  } catch(e) {
    return res.status(200).json({ error: "Parse failed", raw: text.substring(0,500) });
  }

  const results = testArticles.map((a, i) => {
    const s = scores.find(x => x.i === i) || { score: "?", reason: "not scored" };
    return { score: s.score, source: a.source, headline: a.headline, reason: s.reason };
  });

  return res.status(200).json({ results });
}
