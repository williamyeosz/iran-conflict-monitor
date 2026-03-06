export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const base = `https://${req.headers.host}`;
  const newsRes = await fetch(`${base}/api/news`);
  const data = await newsRes.json();
  const all = [...(data.west||[]), ...(data.iran||[]), ...(data.rucn||[])];
  const withMomentum = all.filter(a => a.momentum != null);
  const breakdown = {1:[], 2:[], 3:[], 4:[], 5:[]};
  withMomentum.forEach(a => { if (breakdown[a.momentum]) breakdown[a.momentum].push({ source: a.source, headline: a.headline }); });
  return res.status(200).json({
    total: all.length,
    withMomentum: withMomentum.length,
    countByScore: Object.fromEntries(Object.entries(breakdown).map(([k,v]) => [k, v.length])),
    nonNeutral: withMomentum.filter(a => a.momentum !== 3).length,
    breakdown,
  });
}
