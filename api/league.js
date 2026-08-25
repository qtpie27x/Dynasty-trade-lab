module.exports = async function handler(req, res) {
  const leagueId = String(req.query.id || "");
  const resource = String(req.query.resource || "");

  if (!/^[0-9]+$/.test(leagueId)) {
    return res.status(400).json({ error: "Invalid Sleeper league ID" });
  }

  const allowed = new Set(["", "rosters", "users", "traded_picks"]);
  if (!allowed.has(resource)) {
    return res.status(400).json({ error: "Invalid league resource" });
  }

  const suffix = resource ? `/${resource}` : "";
  const target = `https://api.sleeper.app/v1/league/${leagueId}${suffix}`;

  try {
    const upstream = await fetch(target, {
      headers: { "User-Agent": "DynastyTradeLabV1/1.0" }
    });

    if (!upstream.ok) {
      const text = await upstream.text();
      return res.status(upstream.status).json({
        error: "Sleeper request failed",
        detail: text.slice(0, 300)
      });
    }

    res.setHeader("Cache-Control", "s-maxage=120, stale-while-revalidate=300");
    return res.status(200).json(await upstream.json());
  } catch (err) {
    return res.status(502).json({
      error: "Unable to reach Sleeper",
      detail: err.message
    });
  }
};
