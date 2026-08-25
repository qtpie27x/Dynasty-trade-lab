module.exports = async function handler(req, res) {
  const numQbs = req.query.numQbs === "2" ? "2" : "1";
  const teamsRaw = Number(req.query.numTeams || 12);
  const numTeams = Math.min(32, Math.max(4, Number.isFinite(teamsRaw) ? teamsRaw : 12));
  const pprRaw = Number(req.query.ppr || 1);
  const ppr = [0, 0.5, 1].includes(pprRaw) ? pprRaw : 1;

  const target = `https://api.fantasycalc.com/values/current?isDynasty=true&numQbs=${numQbs}&numTeams=${numTeams}&ppr=${ppr}`;

  try {
    const upstream = await fetch(target, {
      headers: { "User-Agent": "DynastyTradeLabV1/1.0" }
    });

    if (!upstream.ok) {
      const text = await upstream.text();
      return res.status(upstream.status).json({
        error: "FantasyCalc request failed",
        detail: text.slice(0, 300)
      });
    }

    res.setHeader("Cache-Control", "s-maxage=900, stale-while-revalidate=1800");
    return res.status(200).json(await upstream.json());
  } catch (err) {
    return res.status(502).json({
      error: "Unable to reach FantasyCalc",
      detail: err.message
    });
  }
};
