function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];

    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
      } else {
        field += c;
      }
    } else {
      if (c === '"') quoted = true;
      else if (c === ',') {
        row.push(field);
        field = "";
      } else if (c === '\n') {
        row.push(field.replace(/\r$/, ""));
        rows.push(row);
        row = [];
        field = "";
      } else {
        field += c;
      }
    }
  }

  if (field.length || row.length) {
    row.push(field.replace(/\r$/, ""));
    rows.push(row);
  }

  if (!rows.length) return [];

  const headers = rows.shift().map(h => h.trim());

  return rows
    .filter(r => r.some(x => x !== ""))
    .map(r => {
      const obj = {};
      headers.forEach((h, i) => {
        obj[h] = r[i] ?? "";
      });
      return obj;
    });
}

function numberValue(v) {
  const x = Number(String(v ?? "").replace(/,/g, ""));
  return Number.isFinite(x) ? x : null;
}

function normalizeName(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[.'â\-]/g, "")
    .replace(/\b(jr|sr|ii|iii|iv)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { "User-Agent": "DynastyTradeLab/1.1" }
  });

  if (!response.ok) {
    throw new Error(`${response.status} from ${url}`);
  }

  return response.json();
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: { "User-Agent": "DynastyTradeLab/1.1" }
  });

  if (!response.ok) {
    throw new Error(`${response.status} from ${url}`);
  }

  return response.text();
}

module.exports = async function handler(req, res) {
  const numQbs = req.query.numQbs === "2" ? "2" : "1";

  const teamsRaw = Number(req.query.numTeams || 12);
  const numTeams = Math.min(
    32,
    Math.max(4, Number.isFinite(teamsRaw) ? teamsRaw : 12)
  );

  const pprRaw = Number(req.query.ppr || 1);
  const ppr = [0, 0.5, 1].includes(pprRaw) ? pprRaw : 1;

  // FantasyCalc remains the identity/base dataset because it includes Sleeper IDs.
  let fantasyCalc;

  try {
    fantasyCalc = await fetchJson(
      `https://api.fantasycalc.com/values/current?isDynasty=true&numQbs=${numQbs}&numTeams=${numTeams}&ppr=${ppr}`
    );
  } catch (err) {
    return res.status(502).json({
      error: "FantasyCalc is currently unavailable.",
      detail: err.message
    });
  }

  // The other two sources are allowed to fail independently.
  // If one is down, the remaining live sources are automatically reweighted.
  let dynastyProcessValues = [];
  let dynastyProcessIds = [];
  let dynastyDealerValues = [];

  const [dpResult, dealerResult] = await Promise.allSettled([
    Promise.all([
      fetchText(
        "https://raw.githubusercontent.com/DynastyProcess/data/master/files/values-players.csv"
      ),
      fetchText(
        "https://raw.githubusercontent.com/DynastyProcess/data/master/files/db_playerids.csv"
      )
    ]),
    fetchJson("https://www.dynastydealer.com/api/player-values")
  ]);

  if (dpResult.status === "fulfilled") {
    dynastyProcessValues = parseCsv(dpResult.value[0]);
    dynastyProcessIds = parseCsv(dpResult.value[1]);
  }

  if (dealerResult.status === "fulfilled") {
    const payload = dealerResult.value;
    dynastyDealerValues = Array.isArray(payload)
      ? payload
      : (payload.players || []);
  }

  // DynastyProcess stores FantasyPros IDs, so join its official ID table
  // to Sleeper IDs for accurate player matching.
  const fpToSleeper = new Map();

  for (const row of dynastyProcessIds) {
    const fantasyProsId = String(
      row.fantasypros_id || row.fp_id || ""
    ).trim();

    const sleeperId = String(row.sleeper_id || "").trim();

    if (fantasyProsId && sleeperId) {
      fpToSleeper.set(fantasyProsId, sleeperId);
    }
  }

  const dpBySleeper = new Map();
  const dpByName = new Map();

  for (const row of dynastyProcessValues) {
    const value =
      numQbs === "2"
        ? numberValue(row.value_2qb)
        : numberValue(row.value_1qb);

    if (!value || value <= 0) continue;

    const fantasyProsId = String(
      row.fp_id || row.fantasypros_id || ""
    ).trim();

    const sleeperId = fpToSleeper.get(fantasyProsId);

    const item = {
      value,
      updated: row.scrape_date || null
    };

    if (sleeperId) {
      dpBySleeper.set(String(sleeperId), item);
    }

    const nameKey = normalizeName(row.player);

    if (nameKey) {
      dpByName.set(nameKey, item);
    }
  }

  const dealerBySleeper = new Map();
  const dealerByName = new Map();

  for (const row of dynastyDealerValues) {
    const value = numberValue(
      row.current_value ?? row.value ?? row.base_value
    );

    if (!value || value <= 0) continue;

    const item = {
      value,
      updated: row.updated_at || null
    };

    const sleeperId = String(
      row.sleeper_id ?? row.sleeperId ?? ""
    ).trim();

    if (sleeperId) {
      dealerBySleeper.set(sleeperId, item);
    }

    const nameKey = normalizeName(
      row.name ?? row.player_name
    );

    if (nameKey) {
      dealerByName.set(nameKey, item);
    }
  }

  /*
    CONSENSUS WEIGHTS

    FantasyCalc:     40%
    DynastyProcess:  30%
    Dynasty Dealer:  30%

    If a source does not have a value for a player, its weight is
    automatically removed and the available sources are rebalanced.
  */
  const sourceWeights = {
    fantasycalc: 0.40,
    dynastyprocess: 0.30,
    dynastydealer: 0.30
  };

  const combined = fantasyCalc.map(row => {
    const sleeperId = String(row?.player?.sleeperId || "");
    const playerName = row?.player?.name || "";
    const nameKey = normalizeName(playerName);

    const sourceValues = {};

    const fantasyCalcValue = numberValue(row.value);

    if (fantasyCalcValue && fantasyCalcValue > 0) {
      sourceValues.fantasycalc = fantasyCalcValue;
    }

    const dp =
      dpBySleeper.get(sleeperId) ||
      dpByName.get(nameKey);

    if (dp?.value) {
      sourceValues.dynastyprocess = dp.value;
    }

    const dealer =
      dealerBySleeper.get(sleeperId) ||
      dealerByName.get(nameKey);

    if (dealer?.value) {
      sourceValues.dynastydealer = dealer.value;
    }

    let weightedTotal = 0;
    let activeWeight = 0;

    for (const [source, value] of Object.entries(sourceValues)) {
      const weight = sourceWeights[source] || 0;

      weightedTotal += value * weight;
      activeWeight += weight;
    }

    const consensusValue =
      activeWeight > 0
        ? Math.round(weightedTotal / activeWeight)
        : Math.round(fantasyCalcValue || 0);

    // Keep the same response shape the original app already expects.
    // Extra fields are included for future UI upgrades but do not break V1.
    return {
      ...row,
      value: consensusValue,
      consensusValue,
      sourceValues,
      sourceCount: Object.keys(sourceValues).length
    };
  });

  res.setHeader(
    "Cache-Control",
    "s-maxage=900, stale-while-revalidate=1800"
  );

  return res.status(200).json(combined);
};
