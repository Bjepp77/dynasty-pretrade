// Two-team trade suggester. Searches my roster and one partner's (players + picks, 1-for-1 up to 3-for-2) for
// trades near market-fair where BOTH sides gain by their own lens: team-type value (scoring.js) and title odds
// (sim.js). Output is a skeleton to negotiate from, never a verdict to accept. Pure, runs in browser and node.
(function (root) {
  const node = typeof module !== "undefined";
  const DPT = node ? require("./scoring.js") : root.DPT, Sim = node ? require("./sim.js") : root.Sim, League = node ? require("./league.js") : root.League;
  const POS = ["QB", "RB", "WR", "TE"];
  // Search limits (hand-set): top K assets per side by market value, at most 3 per side, never 3-for-3.
  // Every asset must carry MIN_SHARE of its side's plain value, so a package is not padded with filler.
  const K = 14, MAX_SIDE = 3, MIN_SHARE = 0.1;
  // Near market-fair = Fair or Slight edge on the package-discounted market (gap under 17%, scoring.js BANDS).
  const FAIR_MAX = 0.17;
  const TOP = 5, MAX_REPEAT = 2, SIM_MAX = 60, SIM_N = 4000, SEED = 7;
  // Title-odds noise with common random numbers at SIM_N (points). Moves inside this band count as no change.
  const NOISE = 0.3;
  // How much a team type cares about title odds vs long-term value when ranking (hand-set, ranking only).
  // 1 title-odds point ~ 5% lens value.
  const W_TITLE = { Contender: 0.6, Retooler: 0.3, Rebuilder: 0 }, PT_TO_PCT = 5;
  // Title-odds loss a side tolerates while still counting as a gain on value (points).
  const TOL = { Contender: NOISE, Retooler: 1.0, Rebuilder: Infinity };

  // Team type from baseline odds: at or above the title floor (1/teams) contends, under 30% playoff odds rebuilds.
  const teamType = (o, nTeams) => (o.title >= 1 / nTeams ? "Contender" : o.playoff < 0.3 ? "Rebuilder" : "Retooler");

  // Pick slot estimate from the original owner's power rank: top third picks late, bottom third early.
  const pickSlot = (rank, n) => (rank <= n / 3 ? "late" : rank > (2 * n) / 3 ? "early" : "mid");

  function asset(db, id, extra) {
    const r = DPT.analyze(db, id), p = r.p, lens = {};
    DPT.TYPES.forEach((k) => (lens[k] = p.value * (0.5 + r.overall[k] / 100) / (0.5 + p.market / 100)));
    return Object.assign({ key: id, id, name: p.name, pos: p.isPick ? "PICK" : p.pos, isPick: !!p.isPick, value: p.value, market: p.market, lens, lowConf: r.lowConf, archetype: r.archetype }, extra);
  }

  // Tradeable assets for a roster with a market value. Picks are keyed by season/round/original owner so two
  // picks that map to the same market entry stay distinct.
  function assetsOf(db, L, rid, rankOf) {
    const t = L.teams.find((x) => x.rid === rid), out = [];
    t.players.forEach((id) => { const p = db.byId[id]; if (p && !p.isPick && p.value > 0) out.push(asset(db, id)); });
    const nm = (r) => (L.teams.find((x) => x.rid === r) || {}).owner || "Team " + r;
    L.picks.filter((pk) => pk.owner === rid).forEach((pk) => {
      const slot = pickSlot(rankOf[pk.orig] || L.numTeams / 2, L.numTeams), id = `${pk.season}_${pk.round}_${slot}`;
      if (!db.byId[id]) return;
      out.push(asset(db, id, { key: `pick:${pk.season}_${pk.round}_${pk.orig}`, name: `${pk.season} R${pk.round} (${pk.orig === rid ? "own" : "from " + nm(pk.orig)}, est. ${slot})` }));
    });
    return out.sort((a, b) => b.value - a.value);
  }

  function combos(arr, k, start = 0, cur = [], out = []) {
    if (cur.length === k) { out.push(cur.slice()); return out; }
    for (let i = start; i < arr.length; i++) { cur.push(arr[i]); combos(arr, k, i + 1, cur, out); cur.pop(); }
    return out;
  }
  const gap = (a, b) => (a + b > 0 ? (b - a) / ((a + b) / 2) : 0); // signed: positive when b > a

  // Sides gain test after the sim. lensGain is a fraction, dTitle in points.
  function sideGains(type, lensGain, dTitle) {
    return (lensGain > 0 && dTitle > -TOL[type]) || (type !== "Rebuilder" && dTitle >= NOISE && lensGain > -0.085);
  }
  const sideScore = (type, lensGain, dTitle) => 100 * lensGain * (1 - W_TITLE[type]) + W_TITLE[type] * PT_TO_PCT * dTitle;

  // db: scoring.js DB in the league's format. L: League.load result. me, them: roster ids. opts.n: sims per trade.
  function suggest(db, L, me, them, opts) {
    opts = opts || {};
    const n = opts.n || SIM_N, t0 = Date.now();
    const pw = League.power(L), rankOf = {}; pw.forEach((r) => (rankOf[r.rid] = r.rank));
    const base = Sim.run(League.toSimInput(L), { n, seed: SEED }), odds = {}; base.teams.forEach((t) => (odds[t.id] = t));
    const type = { [me]: teamType(odds[me], L.numTeams), [them]: teamType(odds[them], L.numTeams) };
    const A = assetsOf(db, L, me, rankOf).slice(0, K), B = assetsOf(db, L, them, rankOf).slice(0, K);
    const active = (rid) => { const t = L.teams.find((x) => x.rid === rid); return t.players.filter((id) => !t.taxi.has(id)); };
    const pe = {}; const entry = (id) => (pe[id] = pe[id] || { id, pos: L.pinfo(id).pos, ppg: L.ppg(id) });
    const lineup = (ids) => Sim.bestLineup(ids.map(entry).filter((p) => POS.includes(p.pos)), L.slots).total;
    const actA = active(me), actB = active(them), ppgA = lineup(actA), ppgB = lineup(actB);
    const after = (give, get, act) => { const out = new Set(give.filter((a) => !a.isPick).map((a) => a.id)); return act.filter((id) => !out.has(id)).concat(get.filter((a) => !a.isPick).map((a) => a.id)); };

    const sideCombos = (S) => { const c = []; for (let k = 1; k <= MAX_SIDE; k++) combos(S, k).forEach((x) => c.push(x)); return c; };
    const keep = (side) => { const tot = side.reduce((s, a) => s + a.value, 0); return side.every((a) => a.value >= MIN_SHARE * tot); };
    const CA = sideCombos(A).filter(keep), CB = sideCombos(B).filter(keep);
    const cons = (side, k) => DPT.consolidate(side.map((a) => (k ? a.lens[k] : a.value)));
    const pre = CA.map((g) => ({ g, m: cons(g), lm: cons(g, type[me]), lt: cons(g, type[them]) }));
    const preB = CB.map((g) => ({ g, m: cons(g), lm: cons(g, type[me]), lt: cons(g, type[them]) }));
    let searched = 0; const cands = [];
    for (const x of pre) for (const y of preB) {
      if (x.g.length === MAX_SIDE && y.g.length === MAX_SIDE) continue;
      searched++;
      const pct = Math.abs(gap(x.m, y.m)); if (pct >= FAIR_MAX) continue;
      const lgMe = gap(x.lm, y.lm), lgThem = gap(y.lt, x.lt); // me receives y, partner receives x
      const movesPlayers = x.g.some((a) => !a.isPick) || y.g.some((a) => !a.isPick);
      const dA = movesPlayers ? lineup(after(x.g, y.g, actA)) - ppgA : 0, dB = movesPlayers ? lineup(after(y.g, x.g, actB)) - ppgB : 0;
      const pg = (t, lg, d) => lg > 0 || (t !== "Rebuilder" && d > 0.5);
      if (!pg(type[me], lgMe, dA) || !pg(type[them], lgThem, dB)) continue;
      const ppgW = { Contender: 1, Retooler: 0.5, Rebuilder: 0 };
      const s = Math.min(100 * lgMe + ppgW[type[me]] * dA, 100 * lgThem + ppgW[type[them]] * dB) - 20 * pct;
      cands.push({ give: x.g, get: y.g, mkt: { give: x.m, get: y.m, pct, band: DPT.bandOf(pct) }, lgMe, lgThem, dA, dB, pre: s });
    }
    cands.sort((a, b) => b.pre - a.pre);

    // Title odds for pre-screened candidates in pre-score order: both rosters change, same seed as the baseline.
    // Diversity: skip a candidate whose assets already sit in MAX_REPEAT accepted skeletons. Stop at TOP or SIM_MAX sims.
    const iMe = base.teams.findIndex((t) => t.id === me), iThem = base.teams.findIndex((t) => t.id === them);
    const out = [], used = {}, simMax = opts.simMax || SIM_MAX; let sims = 0;
    for (const c of cands) {
      if (out.length >= TOP || sims >= simMax) break;
      const all = c.give.concat(c.get), keys = all.map((a) => a.key);
      if (keys.some((k) => (used[k] || 0) >= MAX_REPEAT)) continue;
      const ov = { [me]: new Set(after(c.give, c.get, actA)), [them]: new Set(after(c.get, c.give, actB)) };
      const r = Sim.run(League.toSimInput(L, ov), { n, seed: SEED }); sims++;
      const dMe = 100 * (r.teams[iMe].title - base.teams[iMe].title), dThem = 100 * (r.teams[iThem].title - base.teams[iThem].title);
      const side = (rid, i, lg, dP, dT) => ({ rid, type: type[rid], lensGain: lg, dPPG: dP, titleBefore: base.teams[i].title, titleAfter: r.teams[i].title, dTitle: dT });
      const s = { give: c.give, get: c.get, market: c.mkt, me: side(me, iMe, c.lgMe, c.dA, dMe), them: side(them, iThem, c.lgThem, c.dB, dThem) };
      if (!(sideGains(s.me.type, s.me.lensGain, s.me.dTitle) && sideGains(s.them.type, s.them.lensGain, s.them.dTitle))) continue;
      s.score = Math.min(sideScore(s.me.type, s.me.lensGain, s.me.dTitle), sideScore(s.them.type, s.them.lensGain, s.them.dTitle)) - 20 * c.mkt.pct;
      s.lowConf = all.some((a) => a.lowConf) || Math.abs(dMe) < NOISE || Math.abs(dThem) < NOISE;
      s.why = why(s, L);
      keys.forEach((k) => (used[k] = (used[k] || 0) + 1)); out.push(s);
    }
    out.sort((a, b) => b.score - a.score);
    return { me, them, type, assets: { me: A.length, them: B.length }, searched, fair: cands.length, simulated: sims, n, ms: Date.now() - t0, suggestions: out };
  }

  const pctS = (x) => (x >= 0 ? "+" : "") + (100 * x).toFixed(0) + "%", ptS = (x) => (x >= 0 ? "+" : "") + x.toFixed(1);
  function why(s, L) {
    const nm = (rid) => L.teams.find((t) => t.rid === rid).owner;
    const one = (who, x) => {
      const parts = [`${x.type} lens value ${pctS(x.lensGain)}`];
      if (Math.abs(x.dPPG) >= 0.1) parts.push(`lineup ${ptS(x.dPPG)} PPG`);
      parts.push(Math.abs(x.dTitle) < NOISE ? "title odds flat (inside noise)" : `title odds ${ptS(x.dTitle)} pts`);
      return `${who}: ${parts.join(", ")}.`;
    };
    return `${one("You", s.me)} ${one(nm(s.them.rid), s.them)} Market ${s.market.band.toLowerCase()} (${(100 * s.market.pct).toFixed(1)}% gap).`;
  }

  // CSV: one row per asset, trade-level numbers repeated, plus a source/snapshot header line.
  function toCSV(res, meta) {
    const q = (v) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const rows = [["# " + (meta.note || "Skeleton to negotiate from, not a recommendation to accept.")], ["# Market sources: " + (meta.sources || "") + "; snapshot " + (meta.snapshot || "") + "; league " + (meta.league || "")],
      ["rank", "side", "asset", "pos", "market_value", "market_gap_pct", "band", "you_type", "you_lens_gain_pct", "you_lineup_dppg", "you_title_before", "you_title_after", "partner_type", "partner_lens_gain_pct", "partner_lineup_dppg", "partner_title_before", "partner_title_after", "low_confidence", "why"]];
    res.suggestions.forEach((s, i) => {
      const f = (x) => x.toFixed(4);
      const tr = [(100 * s.market.pct).toFixed(1), s.market.band, s.me.type, (100 * s.me.lensGain).toFixed(1), s.me.dPPG.toFixed(2), f(s.me.titleBefore), f(s.me.titleAfter), s.them.type, (100 * s.them.lensGain).toFixed(1), s.them.dPPG.toFixed(2), f(s.them.titleBefore), f(s.them.titleAfter), s.lowConf ? "yes" : "no", s.why];
      s.give.forEach((a) => rows.push([i + 1, "you give", a.name, a.pos, Math.round(a.value)].concat(tr)));
      s.get.forEach((a) => rows.push([i + 1, "you get", a.name, a.pos, Math.round(a.value)].concat(tr)));
    });
    return rows.map((r) => r.map(q).join(",")).join("\n") + "\n";
  }

  // Share-link state: league, my roster, partner roster. The search is deterministic (fixed seed), so the link
  // reproduces the same skeletons for anyone with the same market snapshot.
  const encodeShare = (st) => `sug=1&league=${encodeURIComponent(st.league)}&me=${st.me}&with=${st.them}`;
  function decodeShare(qs) {
    const p = new URLSearchParams(String(qs || "").replace(/^[#?]/, ""));
    if (p.get("sug") !== "1" || !/^\d+$/.test(p.get("league") || "")) return null;
    const me = +p.get("me"), them = +p.get("with");
    return Number.isInteger(me) && Number.isInteger(them) && me !== them ? { league: p.get("league"), me, them } : null;
  }

  const api = { suggest, assetsOf, sideGains, teamType, pickSlot, toCSV, encodeShare, decodeShare, FAIR_MAX, MAX_SIDE, NOISE, TOP, MAX_REPEAT };
  if (node) module.exports = api; else root.Suggest = api;
})(typeof window !== "undefined" ? window : globalThis);
