async function getJson(url) {
  const r = await fetch(url, {
    headers: { "User-Agent": "DynastyTradeLab/1.3" }
  });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

async function getLeagueChain(startId, maxLeagues = 4) {
  const leagues = [];
  let id = String(startId);

  for (let i = 0; i < maxLeagues && id; i++) {
    try {
      const league = await getJson(`https://api.sleeper.app/v1/league/${id}`);
      leagues.push(league);
      id = league.previous_league_id ? String(league.previous_league_id) : "";
    } catch {
      break;
    }
  }
  return leagues;
}

async function tradesForLeague(leagueId) {
  const weeks = Array.from({ length: 19 }, (_, i) => i);
  const settled = await Promise.allSettled(
    weeks.map(week =>
      getJson(`https://api.sleeper.app/v1/league/${leagueId}/transactions/${week}`)
    )
  );

  const out = [];
  settled.forEach((result, week) => {
    if (result.status !== "fulfilled") return;
    for (const tx of result.value || []) {
      if (tx?.type === "trade") out.push({ ...tx, week });
    }
  });

  return out;
}

module.exports = async function handler(req, res) {
  const leagueId = String(req.query.id || "");
  if (!/^[0-9]+$/.test(leagueId)) {
    return res.status(400).json({ error: "Invalid Sleeper league ID" });
  }

  try {
    const leagues = await getLeagueChain(leagueId, 4);
    const all = [];

    for (const league of leagues) {
      const trades = await tradesForLeague(league.league_id);
      for (const tx of trades) {
        all.push({
          league_id: league.league_id,
          season: league.season,
          transaction_id: tx.transaction_id,
          roster_ids: tx.roster_ids || [],
          adds: tx.adds || {},
          drops: tx.drops || {},
          draft_picks: tx.draft_picks || [],
          week: tx.week,
          status_updated: tx.status_updated || null
        });
      }
    }

    res.setHeader("Cache-Control", "s-maxage=900, stale-while-revalidate=1800");
    return res.status(200).json({
      trades: all,
      seasons: leagues.map(l => l.season),
      leagueCount: leagues.length
    });
  } catch (err) {
    return res.status(502).json({
      error: "Unable to load league trade history",
      detail: err.message
    });
  }
};
