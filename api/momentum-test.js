// api/momentum-test.js — test Claude momentum scoring on cached articles

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });

  // Pull from cache via internal fetch
  const base = `https://${req.headers.host}`;
  const newsRes = await fetch(`${base}/api/news`);
  if (!newsRes.ok) return res.status(500).json({ error: "Could not fetch cached news" });
  const data = await newsRes.json();

  const allArticles = [
    ...(data.west||[]).map(a => ({...a, tab:"west"})),
    ...(data.iran||[]).map(a => ({...a, tab:"iran"})),
    ...(data.rucn||[]).map(a => ({...a, tab:"rucn"})),
  ];

  if (!allArticles.length) return res.status(200).json({ error: "No cached articles found. Fetch news first." });

  const list = allArticles.map((a, i) =>
    `${i}: [${a.source}] ${a.headline}\nSnippet: ${a.summary || ""}`
  ).join("\n\n");

  const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
      "x-api-key": anthropicKey,
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 3000,
      messages: [{ role: "user", content:
        `Score each article for Iran's military/strategic MOMENTUM in the conflict on a scale 1-5:
5 = Iran or its allies clearly gaining ground, achieving objectives, or inflicting losses on opponents
4 = Iran/allies making meaningful progress or showing strength
3 = Neutral, diplomatic, or unclear impact on momentum
2 = Iran/allies suffering setbacks, losses, or pressure
1 = Iran or its allies clearly losing ground, suffering significant losses, or facing major defeats

Be strict — only score 5 or 1 if the article clearly indicates strong momentum shift.
Consider proxy success/failure (Hezbollah, Houthis, Hamas, Iraqi militias) as part of Iran's momentum.

Return ONLY JSON array, no markdown:
[{"i":0,"score":3,"reason":"one sentence why"}]

Articles:
${list}` }],
    }),
    signal: AbortSignal.timeout(30000),
  });

  const claudeData = await claudeRes.json();
  const text = (claudeData.content||[]).filter(b=>b.type==="text").map(b=>b.text).join("");
  const clean = text.replace(/```[\w]*\n?/g,"").replace(/```/g,"").trim();

  let scores;
  try {
    scores = JSON.parse(clean.match(/\[[\s\S]*\]/)?.[0] || "[]");
  } catch(e) {
    return res.status(200).json({ error: "Parse failed", raw: text.substring(0,500) });
  }

  // Attach scores back to articles
  const scored = allArticles.map((a, i) => {
    const s = scores.find(x => x.i === i) || { score: 3, reason: "" };
    return { ...a, momentumScore: s.score, reason: s.reason };
  });

  // Return top gaining and top losing examples
  const gaining = scored.filter(a => a.momentumScore >= 4).sort((a,b) => b.momentumScore - a.momentumScore).slice(0,8);
  const losing  = scored.filter(a => a.momentumScore <= 2).sort((a,b) => a.momentumScore - b.momentumScore).slice(0,8);
  const all_scores = scored.map(a => ({ score: a.momentumScore, source: a.source, tab: a.tab, headline: a.headline, reason: a.reason }));

  return res.status(200).json({
    total: allArticles.length,
    scored: scores.length,
    gaining: gaining.map(a => ({ score: a.momentumScore, source: a.source, tab: a.tab, headline: a.headline, reason: a.reason })),
    losing:  losing.map(a =>  ({ score: a.momentumScore, source: a.source, tab: a.tab, headline: a.headline, reason: a.reason })),
    all_scores,
  });
}
