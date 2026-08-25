const $ = (id) => document.getElementById(id);

const state = {
  league: null,
  rosters: [],
  users: [],
  tradedPicks: [],
  values: [],
  valuesBySleeper: new Map(),
  rosterById: new Map(),
  userById: new Map(),
  ownerByPlayer: new Map(),
  currentRosterId: null,
  picks: [],
  tradeHistory: [],
  managerProfiles: new Map(),
  lastResults: []
};

function fmtValue(n) {
  if (!Number.isFinite(n)) return "—";
  return Math.round(n).toLocaleString();
}

function escapeHtml(v) {
  return String(v ?? "").replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"
  }[c]));
}

function ownerName(roster) {
  const user = state.userById.get(String(roster.owner_id));
  return user?.metadata?.team_name || user?.display_name || user?.username || `Team ${roster.roster_id}`;
}

function leagueFormat() {
  const rp = state.league?.roster_positions || [];
  const superflex = rp.includes("SUPER_FLEX") || rp.filter(x => x === "QB").length >= 2;
  const pprSetting = Number(state.league?.scoring_settings?.rec || 0);
  const ppr = pprSetting >= .75 ? 1 : pprSetting >= .25 ? .5 : 0;
  return { superflex, numQbs: superflex ? 2 : 1, ppr };
}

async function getJson(url) {
  const r = await fetch(url);
  if (!r.ok) {
    let detail = "";
    try { detail = (await r.json()).detail || ""; } catch {}
    throw new Error(`Request failed (${r.status})${detail ? `: ${detail}` : ""}`);
  }
  return r.json();
}

async function importLeague(leagueId) {
  $("importButton").disabled = true;
  $("importMessage").className = "message";
  $("importMessage").textContent = "Importing league, rosters, draft picks, and market values…";
  $("dataStatus").textContent = "Connecting…";
  $("dataStatus").className = "status-pill";

  try {
    const league = await getJson(`/api/league?id=${leagueId}`);
    if (!league || !league.league_id) throw new Error("Sleeper did not return a valid league.");

    state.league = league;
    const format = leagueFormat();

    const [rosters, users, tradedPicks, values, history] = await Promise.all([
      getJson(`/api/league?id=${leagueId}&resource=rosters`),
      getJson(`/api/league?id=${leagueId}&resource=users`),
      getJson(`/api/league?id=${leagueId}&resource=traded_picks`),
      getJson(`/api/values?numQbs=${format.numQbs}&numTeams=${league.total_rosters || 12}&ppr=${format.ppr}`),
      getJson(`/api/history?id=${leagueId}`).catch(() => ({trades: []}))
    ]);

    state.rosters = rosters || [];
    state.users = users || [];
    state.tradedPicks = tradedPicks || [];
    state.values = values || [];
    state.tradeHistory = history?.trades || [];
    indexData();
    buildManagerProfiles();
    renderImportedLeague();

    $("importMessage").textContent = "League imported successfully.";
    $("dataStatus").textContent = "Live league loaded";
    $("dataStatus").className = "status-pill live";
    $("workspace").classList.remove("hidden");
  } catch (err) {
    console.error(err);
    $("importMessage").className = "message error";
    $("importMessage").textContent = `Could not import this league. ${err.message}`;
    $("dataStatus").textContent = "Connection failed";
  } finally {
    $("importButton").disabled = false;
  }
}

function indexData() {
  state.rosterById = new Map(state.rosters.map(r => [Number(r.roster_id), r]));
  state.userById = new Map(state.users.map(u => [String(u.user_id), u]));
  state.ownerByPlayer = new Map();
  for (const roster of state.rosters) {
    for (const pid of (roster.players || [])) state.ownerByPlayer.set(String(pid), Number(roster.roster_id));
  }

  state.valuesBySleeper = new Map();
  for (const row of state.values) {
    const id = row?.player?.sleeperId;
    if (!id) continue;
    state.valuesBySleeper.set(String(id), {
      id: String(id),
      name: row.player.name || `Player ${id}`,
      position: row.player.position || "NA",
      team: row.player.maybeTeam || "FA",
      age: row.player.maybeAge ?? null,
      yoe: row.player.maybeYoe ?? null,
      value: Number(row.value || 0),
      overallRank: row.overallRank ?? null,
      positionRank: row.positionRank ?? null
    });
  }

  state.picks = buildPickInventory();
}

function buildPickInventory() {
  const baseSeason = Number(state.league?.season || new Date().getFullYear());
  const rounds = Math.min(4, Math.max(3, Number(state.league?.settings?.draft_rounds || 3)));
  const picks = [];

  for (let season = baseSeason + 1; season <= baseSeason + 3; season++) {
    for (const roster of state.rosters) {
      for (let round = 1; round <= rounds; round++) {
        let ownerId = Number(roster.roster_id);
        const moved = state.tradedPicks.find(p =>
          Number(p.season) === season &&
          Number(p.round) === round &&
          Number(p.roster_id) === Number(roster.roster_id)
        );
        if (moved) ownerId = Number(moved.owner_id);
        picks.push({
          type: "pick",
          season,
          round,
          originalRosterId: Number(roster.roster_id),
          ownerRosterId: ownerId,
          name: `${season} Round ${round} (${ownerName(roster)} original)`,
          shortName: `${season} ${ordinal(round)}`,
          value: pickValue(season, round, baseSeason)
        });
      }
    }
  }
  return picks;
}

function ordinal(n) {
  return n === 1 ? "1st" : n === 2 ? "2nd" : n === 3 ? "3rd" : `${n}th`;
}

function pickValue(season, round, baseSeason) {
  const yearsOut = Math.max(1, season - baseSeason);
  const base = {1: 4200, 2: 1800, 3: 750, 4: 350}[round] || 180;
  return Math.round(base * Math.pow(.88, yearsOut - 1));
}

function renderImportedLeague() {
  const f = leagueFormat();
  const formatText = f.superflex ? "Superflex / 2QB" : "1QB";
  const pprText = f.ppr === 1 ? "PPR" : f.ppr === .5 ? "Half-PPR" : "Standard";

  $("leagueSummary").innerHTML = `
    <div class="summary-stat"><strong>${escapeHtml(state.league.name)}</strong><span>League</span></div>
    <div class="summary-stat"><strong>${state.rosters.length}</strong><span>Teams</span></div>
    <div class="summary-stat"><strong>${formatText}</strong><span>QB format</span></div>
    <div class="summary-stat"><strong>${pprText}</strong><span>Scoring</span></div>`;
  $("leagueSummary").classList.remove("hidden");

  $("myTeam").innerHTML = state.rosters
    .map(r => `<option value="${r.roster_id}">${escapeHtml(ownerName(r))}</option>`).join("");

  const first = state.rosters[0];
  state.currentRosterId = Number(first?.roster_id || 0);
  refreshTeamContext();
}

function getPlayer(pid) {
  const p = state.valuesBySleeper.get(String(pid));
  if (p) return p;
  return { id:String(pid), name:`Sleeper player ${pid}`, position:"NA", team:"", age:null, value:0, overallRank:null, positionRank:null };
}

function rosterPlayers(rosterId) {
  const r = state.rosterById.get(Number(rosterId));
  return (r?.players || []).map(getPlayer).filter(p => ["QB","RB","WR","TE"].includes(p.position));
}

function refreshTeamContext() {
  state.currentRosterId = Number($("myTeam").value);
  const roster = state.rosterById.get(state.currentRosterId);
  if (!roster) return;
  $("teamNameHeading").textContent = ownerName(roster);
  $("teamBadge").textContent = `${roster.settings?.wins ?? 0}-${roster.settings?.losses ?? 0}${roster.settings?.ties ? `-${roster.settings.ties}` : ""}`;

  const needs = assessNeeds(state.currentRosterId);
  $("needChips").innerHTML = Object.entries(needs)
    .sort((a,b) => b[1] - a[1])
    .map(([pos, score], i) => `<span class="chip ${i < 2 ? "need" : ""}">${pos} need ${Math.round(score*100)}%</span>`).join("");

  const players = rosterPlayers(state.currentRosterId);
  $("rosterGrid").innerHTML = ["QB","RB","WR","TE"].map(pos => {
    const list = players.filter(p => p.position === pos).sort((a,b) => b.value-a.value);
    return `<div class="pos-card"><h3>${pos}</h3>${list.slice(0,7).map(p =>
      `<div class="player-line"><span class="name">${escapeHtml(p.name)}</span><span class="value">${fmtValue(p.value)}</span></div>`
    ).join("") || `<div class="muted">No valued players</div>`}</div>`;
  }).join("");

  populateTargetPlayers();
  populateShopAssets();
  populateUntouchables();
  populateMustReceive();
  renderManagerTendencies();
}

function populateTargetPlayers(query = "") {
  const q = query.trim().toLowerCase();
  const mine = state.currentRosterId;
  const candidates = state.rosters.flatMap(r =>
    Number(r.roster_id) === mine ? [] :
    rosterPlayers(r.roster_id).map(p => ({...p, ownerRosterId:Number(r.roster_id)}))
  ).filter(p => !q || p.name.toLowerCase().includes(q))
   .sort((a,b) => b.value-a.value)
   .slice(0,80);

  $("targetPlayer").innerHTML = candidates.map(p =>
    `<option value="${p.id}">${escapeHtml(p.name)} · ${p.position} · ${fmtValue(p.value)} · ${escapeHtml(ownerName(state.rosterById.get(p.ownerRosterId)))}</option>`
  ).join("");
}


function populateShopAssets() {
  const players = rosterPlayers(state.currentRosterId).sort((a,b) => b.value-a.value);

  $("shopAssetList").innerHTML = players.map(p => `
    <label class="asset-check">
      <input type="checkbox" class="shop-player-check" value="${p.id}">
      <span class="asset-check-main">
        <span class="asset-check-name">${escapeHtml(p.name)}</span>
        <span class="asset-check-meta">${p.position}${p.team ? ` · ${escapeHtml(p.team)}` : ""}</span>
      </span>
      <span class="asset-check-value">${fmtValue(p.value)}</span>
    </label>
  `).join("");

  document.querySelectorAll(".shop-player-check").forEach(el => {
    el.addEventListener("change", updateSelectedAssetSummary);
  });

  updateSelectedAssetSummary();
}

function updateSelectedAssetSummary() {
  const selected = selectedShopAssets();
  const summary = $("selectedAssetSummary");
  if (!summary) return;

  if (!selected.length) {
    summary.textContent = "No players selected";
    return;
  }

  const total = selected.reduce((sum, p) => sum + (p.value || 0), 0);
  summary.textContent = `${selected.length} player${selected.length === 1 ? "" : "s"} selected · ${fmtValue(total)} raw value`;
}


function populateUntouchables() {
  const players = rosterPlayers(state.currentRosterId).sort((a,b)=>b.value-a.value);
  const existing = new Set(
    [...document.querySelectorAll(".untouchable-check:checked")].map(el => el.value)
  );

  $("untouchableList").innerHTML = players.map(p => `
    <label class="asset-check">
      <input type="checkbox" class="untouchable-check" value="${p.id}" ${existing.has(p.id) ? "checked" : ""}>
      <span class="asset-check-main">
        <span class="asset-check-name">${escapeHtml(p.name)}</span>
        <span class="asset-check-meta">${p.position}${p.team ? ` · ${escapeHtml(p.team)}` : ""}</span>
      </span>
      <span class="asset-check-value">${fmtValue(p.value)}</span>
    </label>
  `).join("");
}

function untouchableIds() {
  return new Set(
    [...document.querySelectorAll(".untouchable-check:checked")].map(el => el.value)
  );
}

function populateMustReceive() {
  const current = $("mustReceive")?.value || "";
  const options = [];

  for (const roster of state.rosters) {
    const rid = Number(roster.roster_id);
    if (rid === state.currentRosterId) continue;
    for (const p of rosterPlayers(rid).sort((a,b)=>b.value-a.value)) {
      options.push({
        value: `player:${p.id}`,
        label: `${p.name} · ${p.position} · ${ownerName(roster)}`
      });
    }
  }

  if ($("allowPicks")?.checked) {
    for (const p of state.picks.filter(p=>p.ownerRosterId !== state.currentRosterId)) {
      options.push({
        value: `pick:${state.picks.indexOf(p)}`,
        label: `${p.shortName} · ${ownerName(state.rosterById.get(p.ownerRosterId))}`
      });
    }
  }

  $("mustReceive").innerHTML =
    `<option value="">No required return asset</option>` +
    options.slice(0, 500).map(o =>
      `<option value="${o.value}" ${o.value === current ? "selected" : ""}>${escapeHtml(o.label)}</option>`
    ).join("");
}

function requiredReceiveAsset() {
  const raw = $("mustReceive")?.value;
  if (!raw) return null;
  const [kind, id] = raw.split(":");
  if (kind === "player") return {...getPlayer(id), type:"player"};
  if (kind === "pick") return state.picks[Number(id)] || null;
  return null;
}

function buildManagerProfiles() {
  state.managerProfiles = new Map();

  for (const roster of state.rosters) {
    state.managerProfiles.set(Number(roster.roster_id), {
      trades: 0,
      picksReceived: 0,
      picksSent: 0,
      playersReceived: 0,
      playersSent: 0,
      youthReceived: 0,
      veteransReceived: 0
    });
  }

  for (const tx of state.tradeHistory) {
    for (const ridRaw of tx.roster_ids || []) {
      const rid = Number(ridRaw);
      if (!state.managerProfiles.has(rid)) continue;
      state.managerProfiles.get(rid).trades++;
    }

    for (const [pid, ridRaw] of Object.entries(tx.adds || {})) {
      const rid = Number(ridRaw);
      const profile = state.managerProfiles.get(rid);
      if (!profile) continue;
      profile.playersReceived++;
      const p = getPlayer(pid);
      if (p.age != null && p.age <= 24) profile.youthReceived++;
      if (p.age != null && p.age >= 28) profile.veteransReceived++;
    }

    for (const [pid, ridRaw] of Object.entries(tx.drops || {})) {
      const rid = Number(ridRaw);
      const profile = state.managerProfiles.get(rid);
      if (profile) profile.playersSent++;
    }

    for (const pick of tx.draft_picks || []) {
      const newOwner = Number(pick.owner_id);
      const oldOwner = Number(pick.previous_owner_id ?? pick.roster_id);
      if (state.managerProfiles.has(newOwner)) state.managerProfiles.get(newOwner).picksReceived++;
      if (state.managerProfiles.has(oldOwner)) state.managerProfiles.get(oldOwner).picksSent++;
    }
  }
}

function managerPreference(rosterId) {
  const p = state.managerProfiles.get(Number(rosterId));
  if (!p || p.trades < 2) return "unknown";
  if (p.picksReceived >= p.playersReceived * .55) return "picks";
  if (p.youthReceived > p.veteransReceived * 1.5) return "youth";
  if (p.veteransReceived > p.youthReceived * 1.5) return "veterans";
  return "balanced";
}

function renderManagerTendencies() {
  const cards = [];
  for (const roster of state.rosters) {
    const rid = Number(roster.roster_id);
    if (rid === state.currentRosterId) continue;
    const p = state.managerProfiles.get(rid) || {};
    const pref = managerPreference(rid);
    cards.push(`
      <div class="tendency-card">
        <h3>${escapeHtml(ownerName(roster))}</h3>
        <p>${p.trades || 0} historical trade${p.trades === 1 ? "" : "s"} analyzed.</p>
        <div class="tendency-tags">
          <span class="tendency-tag">${pref === "unknown" ? "Limited sample" : `Leans ${pref}`}</span>
          ${p.picksReceived ? `<span class="tendency-tag">${p.picksReceived} picks acquired</span>` : ""}
          ${p.playersReceived ? `<span class="tendency-tag">${p.playersReceived} players acquired</span>` : ""}
        </div>
      </div>
    `);
  }

  $("managerTendencies").innerHTML = cards.join("") || `<div class="muted">No historical trades found.</div>`;
  $("historyStatus").textContent = state.tradeHistory.length
    ? `${state.tradeHistory.length} trades analyzed`
    : "No history found";
}

function pickQualityMultiplier(pick) {
  const mode = $("pickQuality")?.value || "auto";
  let quality = mode;

  if (mode === "auto") {
    const roster = state.rosterById.get(pick.originalRosterId);
    const wins = Number(roster?.settings?.wins || 0);
    const losses = Number(roster?.settings?.losses || 0);
    const total = wins + losses;
    const pct = total ? wins / total : .5;
    quality = pct < .38 ? "early" : pct > .62 ? "late" : "mid";
  }

  if (quality === "early") return 1.18;
  if (quality === "late") return .84;
  return 1.0;
}

function complexityLimit() {
  const c = $("complexity")?.value || "normal";
  if (c === "simple") return 2;
  if (c === "blockbuster") return 4;
  return 3;
}

function tradeStyleBonus(asset, rosterId, direction="receive") {
  const style = $("tradeStyle")?.value || "balanced";
  let mult = 1;

  if (asset.type === "pick") {
    if (style === "retool") mult *= 1.12;
    if (style === "winnow") mult *= .92;
    if (style === "tierup") mult *= .95;
    if (style === "tierdown") mult *= 1.05;
    return mult;
  }

  if (style === "winnow") {
    if (asset.age != null && asset.age >= 26 && asset.value >= 2500) mult *= 1.06;
    if (asset.age != null && asset.age <= 22) mult *= .97;
  }
  if (style === "retool") {
    if (asset.age != null && asset.age <= 24) mult *= 1.08;
    if (asset.age != null && asset.age >= 29) mult *= .90;
  }
  if (style === "tierup") {
    if (asset.value >= 6500) mult *= 1.09;
    if (asset.value < 2500) mult *= .94;
  }
  if (style === "tierdown") {
    if (asset.value >= 1800 && asset.value <= 5500) mult *= 1.04;
  }
  return mult;
}

function assessNeeds(rosterId) {
  const players = rosterPlayers(rosterId);
  const starterTargets = inferStarterTargets();
  const out = {};
  for (const pos of ["QB","RB","WR","TE"]) {
    const vals = players.filter(p => p.position === pos).sort((a,b)=>b.value-a.value);
    const needed = starterTargets[pos];
    const starterValue = vals.slice(0, needed).reduce((s,p)=>s+p.value,0);
    const depthValue = vals.slice(needed, needed+2).reduce((s,p)=>s+p.value,0);
    const benchmark = {QB: 6500, RB: 9000, WR: 11500, TE: 5200}[pos] * Math.max(1, needed/2);
    out[pos] = Math.max(.05, Math.min(1, 1 - (starterValue + depthValue*.25) / benchmark));
  }
  return out;
}

function inferStarterTargets() {
  const rp = state.league?.roster_positions || [];
  const count = x => rp.filter(v => v === x).length;
  return {
    QB: Math.max(1, count("QB") + (rp.includes("SUPER_FLEX") ? 1 : 0)),
    RB: Math.max(2, count("RB")),
    WR: Math.max(2, count("WR")),
    TE: Math.max(1, count("TE"))
  };
}

function adjustedValue(asset, rosterId, direction = "receive") {
  let v = asset.value || 0;
  if (asset.type === "pick") {
    v *= pickQualityMultiplier(asset);
    const strategy = rosterId === state.currentRosterId ? $("strategy").value : inferTeamWindow(rosterId);
    if (strategy === "rebuild") v *= 1.12;
    if (strategy === "contender") v *= .93;
    v *= tradeStyleBonus(asset, rosterId, direction);
    return v;
  }

  const needs = assessNeeds(rosterId);
  const need = needs[asset.position] ?? .4;
  v *= 0.94 + need * .14;

  const strategy = rosterId === state.currentRosterId ? $("strategy").value : inferTeamWindow(rosterId);
  if (strategy === "rebuild") {
    if (asset.age != null && asset.age <= 24) v *= 1.08;
    if (asset.age != null && asset.age >= 29) v *= .90;
  } else if (strategy === "contender") {
    if (asset.value >= 4500) v *= 1.04;
  }
  v *= tradeStyleBonus(asset, rosterId, direction);
  return v;
}

function inferTeamWindow(rosterId) {
  const players = rosterPlayers(rosterId).sort((a,b)=>b.value-a.value);
  const top = players.slice(0,10);
  const avgAge = top.filter(p=>p.age!=null).reduce((s,p)=>s+p.age,0) / Math.max(1, top.filter(p=>p.age!=null).length);
  const core = top.reduce((s,p)=>s+p.value,0);
  if (avgAge && avgAge < 25.2) return "rebuild";
  if (core > 47000) return "contender";
  return "balanced";
}

function assetLabel(a) {
  return a.type === "pick" ? a.shortName : a.name;
}

function myTradeableAssets(excludeIds = []) {
  const protect = $("protectElite").checked;
  const untouchable = untouchableIds();
  const mandatory = new Set(selectedShopAssets().map(p=>p.id));
  const players = rosterPlayers(state.currentRosterId)
    .filter(p => !excludeIds.includes(p.id))
    .filter(p => !untouchable.has(p.id) || mandatory.has(p.id))
    .filter(p => !(protect && p.value >= 8000 && !mandatory.has(p.id)))
    .map(p => ({...p, type:"player"}));

  const picks = $("allowPicks").checked
    ? state.picks.filter(p => p.ownerRosterId === state.currentRosterId)
    : [];
  return [...players, ...picks];
}

function otherTradeableAssets(rosterId, excludeIds = []) {
  const players = rosterPlayers(rosterId)
    .filter(p => !excludeIds.includes(p.id))
    .map(p => ({...p, type:"player"}));
  const picks = $("allowPicks").checked
    ? state.picks.filter(p => p.ownerRosterId === rosterId)
    : [];
  return [...players, ...picks];
}

function combinations(items, maxSize = 3) {
  const out = [];
  for (const a of items) out.push([a]);
  if (maxSize >= 2) {
    for (let i=0;i<items.length;i++) for (let j=i+1;j<items.length;j++) out.push([items[i],items[j]]);
  }
  if (maxSize >= 3) {
    const top = items.slice(0,18);
    for (let i=0;i<top.length;i++) for (let j=i+1;j<top.length;j++) for (let k=j+1;k<top.length;k++) {
      if (out.length > 3500) return out;
      out.push([top[i],top[j],top[k]]);
    }
  }
  return out;
}


function packageHasPick(pkg) {
  return pkg.some(a => a.type === "pick");
}

function pickTargetShare() {
  if (!$("allowPicks").checked) return 0;
  const mix = $("pickMix")?.value || "balanced";
  if (mix === "active") return 0.65;
  if (mix === "players") return 0.20;
  return 0.42;
}

function creativeCombinations(items, maxSize = 3, targetValue = 0) {
  const players = items.filter(a => a.type !== "pick").sort((a,b)=>b.value-a.value);
  const picks = items.filter(a => a.type === "pick").sort((a,b)=>b.value-a.value);

  const normalPool = [...players.slice(0,18), ...picks.slice(0,10)];
  const out = combinations(normalPool, maxSize);

  if ($("allowPicks").checked && picks.length) {
    // Explicitly add player + pick and player + two-pick structures.
    for (const player of players.slice(0,16)) {
      for (const pick of picks.slice(0,8)) {
        out.push([player, pick]);
      }
    }

    if (maxSize >= 3) {
      for (const player of players.slice(0,12)) {
        for (let i = 0; i < Math.min(7, picks.length); i++) {
          for (let j = i + 1; j < Math.min(7, picks.length); j++) {
            out.push([player, picks[i], picks[j]]);
          }
        }
      }
    }

    // Picks-only offers are useful for rebuilders and expensive targets.
    for (let i = 0; i < Math.min(9, picks.length); i++) {
      for (let j = i + 1; j < Math.min(9, picks.length); j++) {
        out.push([picks[i], picks[j]]);
      }
    }

    if (maxSize >= 3) {
      for (let i = 0; i < Math.min(7, picks.length); i++) {
        for (let j = i + 1; j < Math.min(7, picks.length); j++) {
          for (let k = j + 1; k < Math.min(7, picks.length); k++) {
            out.push([picks[i], picks[j], picks[k]]);
          }
        }
      }
    }
  }

  const seen = new Set();
  return out.filter(pkg => {
    const key = pkg.map(assetLabel).sort().join("|");
    if (seen.has(key)) return false;
    seen.add(key);

    if (!targetValue) return true;
    const raw = packageRaw(pkg);
    return raw >= targetValue * .35 && raw <= targetValue * 1.75;
  });
}


function satisfiesMustReceive(result) {
  const required = requiredReceiveAsset();
  if (!required) return true;
  return result.receive.some(a => {
    if (required.type !== a.type) return false;
    if (a.type === "player") return String(a.id) === String(required.id);
    return a.season === required.season &&
           a.round === required.round &&
           a.originalRosterId === required.originalRosterId;
  });
}

function diversifyResults(results, limit = 10) {
  const sorted = dedupeResults(results)
    .filter(satisfiesMustReceive)
    .sort((a,b)=>b.score-a.score);
  if (!$("allowPicks").checked) return sorted.slice(0, limit);

  const targetShare = pickTargetShare();
  const desiredPickCount = Math.round(limit * targetShare);

  const withPicks = sorted.filter(r => packageHasPick(r.send) || packageHasPick(r.receive));
  const withoutPicks = sorted.filter(r => !packageHasPick(r.send) && !packageHasPick(r.receive));

  const chosen = [
    ...withPicks.slice(0, desiredPickCount),
    ...withoutPicks.slice(0, Math.max(0, limit - Math.min(desiredPickCount, withPicks.length)))
  ];

  const chosenKeys = new Set(chosen.map(r =>
    [...r.send.map(assetLabel).sort(), "=>", ...r.receive.map(assetLabel).sort()].join("|")
  ));

  for (const r of sorted) {
    if (chosen.length >= limit) break;
    const key = [...r.send.map(assetLabel).sort(), "=>", ...r.receive.map(assetLabel).sort()].join("|");
    if (!chosenKeys.has(key)) {
      chosen.push(r);
      chosenKeys.add(key);
    }
  }

  return chosen.sort((a,b)=>b.score-a.score).slice(0, limit);
}

function packageValue(pkg, rosterId) {
  return pkg.reduce((s,a)=>s+adjustedValue(a, rosterId, "receive"),0);
}

function packageRaw(pkg) {
  return pkg.reduce((s,a)=>s+(a.value||0),0);
}

function proposalScore(sendPkg, receivePkg, otherRosterId) {
  const myReceive = packageValue(receivePkg, state.currentRosterId);
  const mySend = packageValue(sendPkg, state.currentRosterId);
  const theirReceive = packageValue(sendPkg, otherRosterId);
  const theirSend = packageValue(receivePkg, otherRosterId);

  if (!myReceive || !theirReceive) return -Infinity;
  const myRatio = myReceive / mySend;
  const theirRatio = theirReceive / theirSend;
  const fairness = 1 - Math.min(1, Math.abs(Math.log((mySend || 1)/(myReceive || 1))) / .45);
  const accept = 1 - Math.min(1, Math.abs(Math.log((theirReceive || 1)/(theirSend || 1))) / .55);
  const benefit = Math.min(1.2, myRatio);
  const overpayPenalty = mySend > myReceive * 1.18 ? (mySend/myReceive - 1.18) * 1.2 : 0;

  let structureBonus = 0;

  // Two-sided fit: reward packages that address needs for both managers.
  const theirNeeds = assessNeeds(otherRosterId);
  const ourNeeds = assessNeeds(state.currentRosterId);
  const theirFit = sendPkg
    .filter(a => a.type === "player")
    .reduce((s,a)=>s+(theirNeeds[a.position] || 0), 0) / Math.max(1, sendPkg.length);
  const ourFit = receivePkg
    .filter(a => a.type === "player")
    .reduce((s,a)=>s+(ourNeeds[a.position] || 0), 0) / Math.max(1, receivePkg.length);
  structureBonus += Math.min(.04, (theirFit + ourFit) * .02);

  // Historical manager preference: small nudge only, never enough to rescue a bad trade.
  const pref = managerPreference(otherRosterId);
  const theyReceivePicks = sendPkg.some(a=>a.type==="pick");
  const theyReceiveYouth = sendPkg.some(a=>a.type==="player" && a.age != null && a.age <= 24);
  const theyReceiveVeterans = sendPkg.some(a=>a.type==="player" && a.age != null && a.age >= 28);
  if (pref === "picks" && theyReceivePicks) structureBonus += .025;
  if (pref === "youth" && theyReceiveYouth) structureBonus += .02;
  if (pref === "veterans" && theyReceiveVeterans) structureBonus += .02;

  if ($("allowPicks").checked) {
    const mix = $("pickMix")?.value || "balanced";
    const hasPick = packageHasPick(sendPkg) || packageHasPick(receivePkg);
    if (hasPick && mix === "active") structureBonus = .035;
    else if (hasPick && mix === "balanced") structureBonus = .015;
    else if (hasPick && mix === "players") structureBonus = -.01;
  }

  return 100 * (fairness*.36 + accept*.34 + benefit*.30 - overpayPenalty + structureBonus);
}

function explainProposal(sendPkg, receivePkg, otherRosterId) {
  const other = state.rosterById.get(otherRosterId);
  const theirNeeds = assessNeeds(otherRosterId);
  const ourNeeds = assessNeeds(state.currentRosterId);

  const incomingPlayers = receivePkg.filter(a=>a.type==="player");
  const outgoingPlayers = sendPkg.filter(a=>a.type==="player");
  const bestIncoming = incomingPlayers.sort((a,b)=>b.value-a.value)[0];

  const incomingPicks = receivePkg.filter(a=>a.type==="pick");
  const outgoingPicks = sendPkg.filter(a=>a.type==="pick");

  let whyUs = bestIncoming
    ? `${bestIncoming.name} addresses a ${bestIncoming.position} need (${Math.round((ourNeeds[bestIncoming.position]||.4)*100)}% need score).${incomingPicks.length ? ` You also add ${incomingPicks.length} future pick${incomingPicks.length === 1 ? "" : "s"} to the return.` : ""}`
    : `The return improves your future flexibility with ${incomingPicks.length || "additional"} draft-pick asset${incomingPicks.length === 1 ? "" : "s"}.`;

  const helpfulOut = outgoingPlayers
    .slice()
    .sort((a,b)=>(theirNeeds[b.position]||0)-(theirNeeds[a.position]||0))[0];
  let whyThem = helpfulOut
    ? `${ownerName(other)} is comparatively thinner at ${helpfulOut.position}, so ${helpfulOut.name} fits their roster construction.${outgoingPicks.length ? ` The added pick${outgoingPicks.length === 1 ? "" : "s"} help bridge the remaining value gap.` : ""}`
    : `The package gives ${ownerName(other)} additional market value and flexibility.`;

  return { whyUs, whyThem };
}

function findPackagesForTarget(target) {
  const ownerId = state.ownerByPlayer.get(String(target.id));
  if (!ownerId || ownerId === state.currentRosterId) return [];
  const targetAsset = {...target, type:"player"};
  const receives = [[targetAsset]];
  const myAssets = myTradeableAssets([target.id]).sort((a,b)=>b.value-a.value);

  const targetVal = adjustedValue(targetAsset, ownerId);
  const candidates = myAssets
    .filter(a => {
      if (a.type === "pick") return a.value >= targetVal * .04 && a.value <= targetVal * 1.35;
      return a.value >= targetVal * .10 && a.value <= targetVal * 1.35;
    })
    .slice(0,30);

  const pkgs = creativeCombinations(candidates, complexityLimit(), targetVal);

  const results = [];
  for (const send of pkgs) {
    const theirReceive = packageValue(send, ownerId);
    if (theirReceive < targetVal*.84 || theirReceive > targetVal*1.24) continue;
    const score = proposalScore(send, [targetAsset], ownerId);
    if (!Number.isFinite(score)) continue;
    results.push(makeResult(send, [targetAsset], ownerId, score));
  }
  return diversifyResults(results, 10);
}

function makeResult(send, receive, otherRosterId, score) {
  const explanation = explainProposal(send, receive, otherRosterId);
  return {
    send, receive, otherRosterId,
    otherName: ownerName(state.rosterById.get(otherRosterId)),
    score: Math.max(1, Math.min(99, Math.round(score))),
    sendValue: packageRaw(send),
    receiveValue: packageRaw(receive),
    ...explanation
  };
}

function dedupeResults(results) {
  const seen = new Set();
  return results.filter(r => {
    const key = [...r.send.map(assetLabel).sort(), "=>", ...r.receive.map(assetLabel).sort()].join("|");
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}

function positionTargets(position, tier) {
  const all = state.rosters.flatMap(r =>
    Number(r.roster_id) === state.currentRosterId ? [] :
    rosterPlayers(r.roster_id).filter(p=>p.position===position).map(p=>({...p, ownerRosterId:Number(r.roster_id)}))
  ).sort((a,b)=>b.value-a.value);

  if (!all.length) return [];
  if (tier === "elite") return all.filter(p=>p.value >= 6500).slice(0,14);
  if (tier === "starter") return all.filter(p=>p.value >= 3000 && p.value < 7500).slice(0,22);
  return all.filter(p=>p.value >= 700 && p.value < 4200).slice(0,28);
}

function findPositionTrades(position, tier) {
  const targets = positionTargets(position, tier);
  const results = targets.flatMap(t => findPackagesForTarget(t).slice(0,2));
  return diversifyResults(results, 10);
}

function bestUpgradeTrades() {
  const needs = assessNeeds(state.currentRosterId);
  const positions = Object.entries(needs).sort((a,b)=>b[1]-a[1]).slice(0,2).map(([p])=>p);
  const results = positions.flatMap(pos => findPositionTrades(pos, "starter"));
  return diversifyResults(results, 10);
}


function selectedShopAssets() {
  return [...document.querySelectorAll(".shop-player-check:checked")]
    .map(el => {
      const p = getPlayer(el.value);
      return {...p, type:"player"};
    })
    .filter(Boolean);
}

function optionalOutgoingPickPackages(baseOutgoing, otherRosterId) {
  if (!$("allowPicks").checked) return [baseOutgoing];

  const myPicks = state.picks
    .filter(p => p.ownerRosterId === state.currentRosterId)
    .sort((a,b)=>b.value-a.value)
    .slice(0,8);

  const packages = [baseOutgoing];

  // Selected players always remain in the deal. Picks may be added as sweeteners.
  for (const pick of myPicks) {
    packages.push([...baseOutgoing, pick]);
  }

  // For large bundles, avoid absurd 4+ asset outgoing offers.
  if (baseOutgoing.length + 2 <= complexityLimit()) {
    for (let i = 0; i < Math.min(5, myPicks.length); i++) {
      for (let j = i + 1; j < Math.min(5, myPicks.length); j++) {
        packages.push([...baseOutgoing, myPicks[i], myPicks[j]]);
      }
    }
  }

  return packages;
}

function findShopTrades(outgoingPlayers) {
  const results = [];
  if (!outgoingPlayers.length) return results;

  for (const roster of state.rosters) {
    const rid = Number(roster.roster_id);
    if (rid === state.currentRosterId) continue;

    const baseTarget = packageValue(outgoingPlayers, rid);

    // Include more picks than the old engine and allow 3-asset returns.
    const pool = otherTradeableAssets(rid)
      .sort((a,b)=>b.value-a.value)
      .filter(a => {
        if (a.type === "pick") return a.value >= baseTarget * .035;
        return a.value >= baseTarget * .08;
      })
      .slice(0,30);

    const incomingPkgs = creativeCombinations(pool, complexityLimit(), baseTarget);
    const outgoingPkgs = optionalOutgoingPickPackages(outgoingPlayers, rid);

    for (const outgoing of outgoingPkgs) {
      const theirReceive = packageValue(outgoing, rid);

      for (const receive of incomingPkgs) {
        const theirGive = packageValue(receive, rid);

        if (theirReceive < theirGive * .82 || theirReceive > theirGive * 1.24) continue;

        // Avoid pick-for-pick noise unless a selected player is part of the core deal.
        if (!outgoingPlayers.length) continue;

        const score = proposalScore(outgoing, receive, rid);
        if (!Number.isFinite(score)) continue;

        results.push(makeResult(outgoing, receive, rid, score));
      }
    }
  }

  return diversifyResults(results, 12);
}

function runSearch() {
  const mode = document.querySelector('input[name="mode"]:checked')?.value || "player";
  let results = [];

  if (mode === "player") {
    const id = $("targetPlayer").value;
    if (!id) return renderResults([], "Choose a target player first.");
    results = findPackagesForTarget(getPlayer(id));
  } else if (mode === "position") {
    results = findPositionTrades($("targetPosition").value, $("targetTier").value);
  } else if (mode === "shop") {
    const assets = selectedShopAssets();
    if (!assets.length) return renderResults([], "Select at least one player you want to move.");
    results = findShopTrades(assets);
  } else {
    results = bestUpgradeTrades();
  }
  state.lastResults = results;
  renderResults(results);
}

function renderResults(results, emptyMessage = "") {
  $("tradeResults").innerHTML = "";
  $("resultCount").textContent = results.length ? `${results.length} ideas` : "";

  if (!results.length) {
    $("resultsEmpty").classList.remove("hidden");
    $("resultsEmpty").querySelector("h3").textContent = emptyMessage || "No balanced proposal found";
    $("resultsEmpty").querySelector("p").textContent = emptyMessage
      ? "Adjust your filters or choose another asset."
      : "Try allowing draft picks, turning off elite-player protection, or choosing a different target tier.";
    return;
  }

  $("resultsEmpty").classList.add("hidden");
  $("tradeResults").innerHTML = results.map((r,i) => {
    const total = Math.max(1, r.sendValue + r.receiveValue);
    const sendPct = Math.max(8, Math.min(92, r.sendValue/total*100));
    const recvPct = 100-sendPct;
    return `
      <article class="trade-card">
        <div class="trade-head">
          <strong>#${i+1} with ${escapeHtml(r.otherName)}</strong>
          <span class="score">${r.score}/100 fit</span>
        </div>
        <div class="trade-body">
          <div class="side">
            <h4>YOU RECEIVE</h4>
            ${r.receive.map(a=>`<div class="asset"><span class="asset-name">${escapeHtml(assetLabel(a))}${a.type === "pick" ? '<span class="pick-tag">PICK</span>' : ''}</span><span class="asset-value">${fmtValue(a.value)}</span></div>`).join("")}
          </div>
          <div class="side">
            <h4>YOU SEND</h4>
            ${r.send.map(a=>`<div class="asset"><span class="asset-name">${escapeHtml(assetLabel(a))}${a.type === "pick" ? '<span class="pick-tag">PICK</span>' : ''}</span><span class="asset-value">${fmtValue(a.value)}</span></div>`).join("")}
          </div>
        </div>
        <div class="trade-foot">
          <b>Why it works for you:</b> ${escapeHtml(r.whyUs)}<br>
          <b>Why they may consider it:</b> ${escapeHtml(r.whyThem)}
          <div class="value-bar" title="Raw market value balance"><span style="width:${sendPct}%"></span><span style="width:${recvPct}%"></span></div>
        </div>
      </article>`;
  }).join("");
}

function updateModeUI() {
  const mode = document.querySelector('input[name="mode"]:checked')?.value;
  $("playerTargetFields").classList.toggle("hidden", mode !== "player");
  $("positionTargetFields").classList.toggle("hidden", mode !== "position");
  $("shopFields").classList.toggle("hidden", mode !== "shop");
}

$("leagueForm").addEventListener("submit", e => {
  e.preventDefault();
  const id = $("leagueId").value.trim();
  if (!/^[0-9]+$/.test(id)) {
    $("importMessage").className = "message error";
    $("importMessage").textContent = "Enter a numeric Sleeper league ID.";
    return;
  }
  importLeague(id);
});

$("myTeam").addEventListener("change", refreshTeamContext);
$("targetPlayerSearch").addEventListener("input", e => populateTargetPlayers(e.target.value));
document.querySelectorAll('input[name="mode"]').forEach(el => el.addEventListener("change", updateModeUI));
$("findTrades").addEventListener("click", runSearch);
$("allowPicks").addEventListener("change", populateMustReceive);

updateModeUI();
