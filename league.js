// Sleeper league import: settings, rosters, standings, pick ownership, rest-of-season projections
// scored with the league's own scoring settings, best lineups, power ranking, chip efficiency.
// Pure functions + read-only public Sleeper API (no login). Runs in browser and node.
(function (root) {
  const Sim = typeof module !== "undefined" ? require("./sim.js") : root.Sim;
  const V1 = "https://api.sleeper.app/v1", PROJ = "https://api.sleeper.app/projections/nfl";
  const POSITIONS = ["QB", "RB", "WR", "TE"];
  const GRAY = 1.5; // percentage points around the title-odds floor

  async function getJson(u) { const r = await fetch(u); if (!r.ok) throw new Error(u + " " + r.status); return r.json(); }

  // Σ stat × weight over the league's scoring settings (only keys the league scores)
  function scoreStats(stats, scoring) {
    let t = 0;
    for (const k in scoring) { const v = stats[k]; if (typeof v === "number") t += v * scoring[k]; }
    return t;
  }

  // roster_positions -> slot counts. REC_FLEX is approximated as FLEX; K, DEF, IDP and bench are ignored.
  function slotsOf(rp) {
    const s = { QB: 0, RB: 0, WR: 0, TE: 0, FLEX: 0, SF: 0 };
    rp.forEach((x) => { if (x === "SUPER_FLEX") s.SF++; else if (x === "FLEX" || x === "REC_FLEX" || x === "WRRBTE") s.FLEX++; else if (s[x] !== undefined) s[x]++; });
    return s;
  }

  // players: optional Sleeper map { id: { name, pos, age } } (ages are not in the projections feed)
  async function load(leagueId, opts) {
    opts = opts || {};
    const get = opts.getJson || getJson, say = opts.onStatus || (() => {}), pm = opts.players || {};
    say("Loading league...");
    const [lg, users, rosters, traded, state] = await Promise.all([
      get(`${V1}/league/${leagueId}`), get(`${V1}/league/${leagueId}/users`), get(`${V1}/league/${leagueId}/rosters`),
      get(`${V1}/league/${leagueId}/traded_picks`), get(`${V1}/state/nfl`)]);
    const st = lg.settings, scoring = lg.scoring_settings, slots = slotsOf(lg.roster_positions);
    const lastWeek = (st.playoff_week_start || 15) - 1;
    const scored = st.last_scored_leg != null ? st.last_scored_leg : Math.max(0, (state.week || 1) - 1);
    const fromWeek = Math.max(scored + 1, st.start_week || 1);
    const weeks = []; for (let w = fromWeek; w <= lastWeek; w++) weeks.push(w);
    say(`Loading projections for weeks ${fromWeek}-${lastWeek}...`);
    const posQ = POSITIONS.map((p) => "position[]=" + p).join("&");
    const season = lg.season;
    const [projs, mus] = await Promise.all([
      Promise.all(weeks.map((w) => get(`${PROJ}/${season}/${w}?season_type=regular&${posQ}`).catch(() => []))),
      Promise.all(weeks.map((w) => get(`${V1}/league/${leagueId}/matchups/${w}`).catch(() => [])))]);

    // per-player rest-of-season projection: mean of weekly league-scored points over weeks he is projected to play
    const info = {}, sums = {};
    projs.forEach((rows, wi) => (Array.isArray(rows) ? rows : []).forEach((r) => {
      if (!r.stats || !r.player_id) return;
      const pts = scoreStats(r.stats, scoring), id = String(r.player_id), pl = r.player || {};
      info[id] = info[id] || { id, name: [pl.first_name, pl.last_name].filter(Boolean).join(" "), pos: pl.position, team: r.team || pl.team, injury: pl.injury_status };
      if (pts > 0) { const s = (sums[id] = sums[id] || { t: 0, n: 0, wk: {} }); s.t += pts; s.n++; s.wk[weeks[wi]] = pts; }
    }));
    const pinfo = (id) => {
      const i = info[id] || {}, p = pm[id] || {};
      return { id, name: i.name || p.name || "Player " + id, pos: i.pos || p.pos || p.position, team: i.team || p.team, age: p.age != null ? p.age : null, injury: i.injury || p.injury };
    };
    const ppgRaw = (id) => (sums[id] ? sums[id].t / sums[id].n : 0);
    // shaded rest-of-season PPG used everywhere downstream (age 30+: -1.5)
    const ppg = (id) => Sim.shade(ppgRaw(id), pinfo(id).age);

    const userBy = {}; users.forEach((u) => (userBy[u.user_id] = u));
    const teams = rosters.map((r) => {
      const u = userBy[r.owner_id] || {}, s = r.settings;
      return { rid: r.roster_id, owner: u.display_name || "Team " + r.roster_id, team: (u.metadata && u.metadata.team_name) || u.display_name || "Team " + r.roster_id,
        players: (r.players || []).map(String), taxi: new Set((r.taxi || []).map(String)), reserve: new Set((r.reserve || []).map(String)),
        w: s.wins, l: s.losses, t: s.ties || 0, pf: s.fpts + (s.fpts_decimal || 0) / 100, pa: s.fpts_against + (s.fpts_against_decimal || 0) / 100 };
    });
    // remaining schedule: pair roster ids by matchup_id, week by week
    const schedule = mus.map((rows) => { const g = {}; (rows || []).forEach((m) => { if (m.matchup_id != null) (g[m.matchup_id] = g[m.matchup_id] || []).push(m.roster_id); });
      return Object.values(g).filter((x) => x.length === 2); });

    const L = { id: leagueId, name: lg.name, season, status: lg.status, week: state.week, weeks, fromWeek, lastWeek, settings: st, scoring, slots,
      numTeams: st.num_teams, playoffTeams: st.playoff_teams, playoffStart: st.playoff_week_start, reseed: st.playoff_seed_type === 1,
      teams, schedule, ppg, ppgRaw, pinfo, picks: pickOwnership(lg, traded, teams), format: formatOf(lg) };
    return L;
  }

  function formatOf(lg) {
    const sc = lg.scoring_settings, rp = lg.roster_positions;
    const sf = rp.filter((x) => x === "SUPER_FLEX").length, qb = rp.filter((x) => x === "QB").length;
    const rec = sc.rec == null ? 0 : sc.rec;
    return { qbs: sf > 0 || qb >= 2 ? 2 : 1, ppr: rec >= 0.75 ? 1 : rec >= 0.25 ? 0.5 : 0, tePremium: sc.bonus_rec_te || 0, passTd: sc.pass_td };
  }

  // Current owner of every upcoming pick by year and round (default: original owner, then apply traded_picks)
  function pickOwnership(lg, traded, teams) {
    const rounds = lg.settings.draft_rounds || 4, first = lg.status === "pre_draft" || lg.status === "drafting" ? +lg.season : +lg.season + 1;
    const seasons = [first, first + 1, first + 2], own = {};
    seasons.forEach((y) => { for (let r = 1; r <= rounds; r++) teams.forEach((t) => (own[`${y}_${r}_${t.rid}`] = t.rid)); });
    (traded || []).forEach((p) => { const k = `${p.season}_${p.round}_${p.roster_id}`; if (own[k] !== undefined) own[k] = p.owner_id; });
    return Object.entries(own).map(([k, owner]) => { const [season, round, orig] = k.split("_").map(Number); return { season, round, orig, owner }; });
  }

  // Lineup pool for a roster: everyone except taxi (taxi players cannot start). override = Set of ids.
  function pool(L, team, override) {
    const ids = override || team.players.filter((id) => !team.taxi.has(id));
    return Array.from(ids).map((id) => ({ id, pos: L.pinfo(id).pos, ppg: L.ppg(id) })).filter((p) => POSITIONS.includes(p.pos));
  }

  // Power table: best healthy lineup PPG, rank, gap to the last playoff seed (by projected PPG)
  function power(L) {
    const rows = L.teams.map((t) => ({ rid: t.rid, owner: t.owner, team: t.team, w: t.w, l: t.l, t: t.t, pf: t.pf, ppg: Sim.bestLineup(pool(L, t), L.slots).total }));
    rows.sort((a, b) => b.ppg - a.ppg);
    const cut = rows[Math.min(L.playoffTeams, rows.length) - 1].ppg;
    rows.forEach((r, i) => { r.rank = i + 1; r.gap = r.ppg - cut; });
    return rows;
  }

  // Chip efficiency: lineup PPG lost if the asset is removed (picks cost 0). Sorted by cost, free chips last.
  function chips(L, rid) {
    const t = L.teams.find((x) => x.rid === rid), pl = pool(L, t), base = Sim.bestLineup(pl, L.slots).total;
    const rows = pl.map((p) => ({ id: p.id, name: L.pinfo(p.id).name, pos: p.pos, age: L.pinfo(p.id).age, ppg: p.ppg, loss: base - Sim.bestLineup(pl.filter((x) => x !== p), L.slots).total }));
    rows.sort((a, b) => b.loss - a.loss || b.ppg - a.ppg);
    rows.forEach((r) => (r.free = r.loss < 0.05));
    return { base, rows };
  }

  // Build the simulator input. override = { rid: Set(playerIds) } replaces that roster's pool (trades).
  function toSimInput(L, override) {
    override = override || {};
    const idx = {}; L.teams.forEach((t, i) => (idx[t.rid] = i));
    return {
      slots: L.slots,
      teams: L.teams.map((t) => ({ id: t.rid, w: t.w, l: t.l, t: t.t, pf: t.pf,
        players: pool(L, t, override[t.rid]).map((p) => ({ pos: p.pos, ppg: p.ppg, pMiss: Sim.missP(p.pos, L.pinfo(p.id).age) })) })),
      weeks: L.schedule.map((wk) => wk.map((g) => [idx[g[0]], idx[g[1]]])),
      playoff: { teams: L.playoffTeams, reseed: L.reseed } };
  }

  // Rosters after a trade: side A (ids given by my team) and side B (ids received). The counterparty is the
  // owner of the first received rostered player. Picks do not change any lineup, so they are ignored here.
  function tradeOverride(L, myRid, giveIds, getIds) {
    const owner = {}; L.teams.forEach((t) => t.players.forEach((id) => (owner[id] = t.rid)));
    const sets = {}; const base = (t) => (sets[t.rid] = sets[t.rid] || new Set(t.players.filter((id) => !t.taxi.has(id))));
    const me = L.teams.find((t) => t.rid === myRid); base(me);
    const gets = getIds.filter((id) => L.pinfo(id).pos && POSITIONS.includes(L.pinfo(id).pos));
    const gives = giveIds.filter((id) => owner[id] === myRid);
    const cp = gets.map((id) => owner[id]).find((r) => r != null && r !== myRid);
    gives.forEach((id) => sets[myRid].delete(id));
    gets.forEach((id) => { const o = owner[id]; if (o != null && o !== myRid) { base(L.teams.find((t) => t.rid === o)).delete(id); } sets[myRid].add(id); });
    if (cp != null) gives.forEach((id) => base(L.teams.find((t) => t.rid === cp)).add(id));
    return { override: sets, counterparty: cp, gives, gets };
  }

  // Title-odds floor (1 / teams) with a +/- 1.5 point gray zone. costsValue: my side gives more market value.
  function titleVerdict(before, after, nTeams, costsValue) {
    const floor = 1 / nTeams, pp = (x) => (100 * x).toFixed(1) + "%", d = (after - before) * 100;
    const zone = after >= floor + GRAY / 100 ? "above" : after >= floor - GRAY / 100 ? "gray" : "below";
    let text = `Title odds ${pp(before)} to ${pp(after)} (${d >= 0 ? "+" : ""}${d.toFixed(1)} pts). Floor ${pp(floor)}. `;
    if (zone === "above") text += d < -0.5 ? "Still above the floor, but the trade lowers title odds." : "Clears the floor.";
    else if (zone === "gray") text += `Gray zone (within ${GRAY} pts of the floor): ${costsValue ? "a value-costing trade should clear it, treat as a coin flip" : "fine for a value-neutral trade"}.`;
    else text += costsValue ? "Below the floor and the trade costs value: do not pay." : "Below the floor, acceptable only because the trade does not cost value.";
    if (Math.abs(d) < 0.5) text += " Change is inside simulation noise (about 0.3 pts).";
    return { floor, zone, delta: d, text };
  }

  const api = { load, scoreStats, slotsOf, formatOf, pickOwnership, pool, power, chips, toSimInput, tradeOverride, titleVerdict, GRAY };
  if (typeof module !== "undefined") module.exports = api; else root.League = api;
})(typeof window !== "undefined" ? window : globalThis);
