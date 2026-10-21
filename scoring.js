// Dynasty Pre-Trade scoring. Pure functions, runs in browser and node.
// Overall score per team type = market value (data/values.json, aggregate of public calculators)
// blended with the statistical model (data/stats.json, fitted on nflverse data).
(function (root) {
  const POS = ["QB", "RB", "WR", "TE"];
  const TYPES = ["Contender", "Retooler", "Rebuilder"];
  // m = weight on market score; now = weight of statScoreNow inside the stats half (rest is statScoreLong).
  // Hand-set: contenders care about this season, rebuilders about years 2-3 and resale.
  const W = { Contender: { m: 0.4, now: 0.8 }, Retooler: { m: 0.5, now: 0.5 }, Rebuilder: { m: 0.6, now: 0.15 } };
  // A pick adds nothing to this season's lineup: shift its market score per team type (hand-set).
  const PICK_ADJ = { Contender: -25, Retooler: -5, Rebuilder: 10 };
  // Points off the Contender score for current injury status (hand-set).
  const INJ = { out: 12, ir: 15, pup: 12, sus: 10, doubtful: 8, questionable: 3 };
  // Consolidation (package) discount: a side's value is the power-sum (sum v_i^P)^(1/P), P > 1, so many
  // small pieces add up to less than their plain sum (roster spots, lineup slots). One asset is unchanged.
  // P = 1.3 fitted to FantasyCalc's own trade calculator rule (docs/market-model.md): 1QB 1.31, Superflex 1.24.
  const CONSOL_P = 1.3;
  const consolidate = (vals, p = CONSOL_P) => Math.pow(vals.reduce((s, v) => s + Math.pow(Math.max(v, 0), p), 0), 1 / p);
  // Fairness bands on gap / average of the two adjusted side values (upper edge exclusive).
  const BANDS = [[0.085, "Fair"], [0.17, "Slight edge"], [0.425, "Clear win"], [Infinity, "Lopsided"]];
  const bandOf = (pct) => BANDS.find((b) => pct < b[0])[1];
  // 30-day market trend hint. Needs a real market value: % moves on cheap players are noise.
  const TREND_MIN_VALUE = 1500, TREND_PCT = 10;
  function trendHint(p) {
    const t = p && p.trend;
    if (t == null || !(p.value >= TREND_MIN_VALUE)) return null;
    if (t >= TREND_PCT) return "Rising: sell high if moving";
    if (t <= -TREND_PCT) return "Falling: buy the dip";
    return null;
  }
  const clamp =(x, a = 0, b = 100) => Math.max(a, Math.min(b, x));
  const fmtKey = (qbs, ppr) => `${qbs == 2 ? "sf" : "1qb"}_${{ 1: "ppr", 0.5: "half", 0: "std" }[ppr] || "ppr"}`;

  // raw = {values, stats, players (slim Sleeper map), fmt}
  function buildDB(raw) {
    const vals = raw.values.formats[raw.fmt] || {}, sp = raw.players || {}, st = (raw.stats && raw.stats.players) || {};
    const list = [], picks = [];
    Object.entries(vals).forEach(([id, v]) => {
      const base = { id, name: v.name, pos: v.pos, market: v.marketScore, value: v.aggValue, n: v.n, spread: v.spread, by: v.by || {}, trend: v.trend30 == null ? null : v.trend30 };
      if (v.pos === "PICK") return picks.push({ ...base, team: "", isPick: true });
      if (!POS.includes(v.pos)) return;
      const p = sp[id] || {}, s = st[id] || null;
      list.push({ ...base, team: p.team || "FA", age: (s && s.age) || p.age || null, exp: p.years_exp,
        injury: p.injury_status || null, depth: p.depth_chart_order, st: s });
    });
    list.sort((a, b) => b.market - a.market);
    picks.sort((a, b) => a.name.localeCompare(b.name));
    // Survival reference per position: 75th percentile of P(still a regular in 3 seasons).
    // A rebuilder only keeps market value that lasts, so market is scaled by survival / this reference.
    const survRef = {};
    POS.forEach((pos) => {
      const xs = list.filter((p) => p.pos === pos && p.st && p.st.survival).map((p) => p.st.survival[2]).sort((a, b) => a - b);
      survRef[pos] = xs.length ? xs[Math.floor(0.75 * (xs.length - 1))] : 1;
    });
    const byId = {}; list.concat(picks).forEach((p) => (byId[p.id] = p));
    return { list, picks, byId, survRef, fmt: raw.fmt, generated: raw.values.generated, sources: raw.values.sources, statsMeta: raw.stats && raw.stats.meta };
  }

  function analyze(db, id) {
    const p = db.byId[String(id)];
    if (!p) return null;
    const overall = {};
    let now = null, long = null, persist = 1;
    const hasStats = !!(p.st && p.st.statScoreNow != null);
    if (p.isPick) TYPES.forEach((k) => (overall[k] = clamp(p.market + PICK_ADJ[k])));
    else {
      if (hasStats) { now = p.st.statScoreNow; long = p.st.statScoreLong; }
      // persistence: 1 for a typical young starter, near 0 for a player unlikely to last 3 seasons
      persist = hasStats && p.st.survival ? clamp(p.st.survival[2] / (db.survRef[p.pos] || 1), 0, 1) : 1;
      const mkt = { Contender: p.market, Retooler: p.market * (1 + persist) / 2, Rebuilder: p.market * persist };
      TYPES.forEach((k) => {
        const stats = hasStats ? W[k].now * now + (1 - W[k].now) * long : null;
        overall[k] = hasStats ? W[k].m * mkt[k] + (1 - W[k].m) * stats : p.market;
      });
      overall.Contender = clamp(overall.Contender - (INJ[(p.injury || "").toLowerCase()] || 0));
    }
    const d = overall.Contender - overall.Rebuilder;
    let archetype = d > 5 ? "Contender" : d < -5 ? "Rebuilder" : "Retooler";
    // Aging asset (under 65% of the typical 3-season survival at its position): its only use is now.
    if (persist < 0.65) archetype = "Contender";
    if (TYPES.every((k) => overall[k] >= 85)) archetype = "Core";
    const surv = hasStats ? p.st.survival || [] : [];
    let tag = { Contender: "Buy for contenders", Rebuilder: "Rebuilder stash", Retooler: "Hold", Core: "Core hold for anyone" }[archetype];
    if (p.isPick) tag = "Draft pick";
    else if (hasStats && surv[1] != null && surv[1] < 0.5 && now >= 50) tag = "Sell before cliff";
    else if (Math.max(...TYPES.map((k) => overall[k])) < 40) tag = archetype === "Contender" ? "Contender depth only" : "Low value";

    let explanation;
    if (p.isPick) explanation = `Draft pick, market score ${Math.round(p.market)} across ${p.n} calculators. Worth most to a rebuilder; a contender gets nothing this season.`;
    else {
      const proj = hasStats ? `projected ${p.st.projPPG1.toFixed(1)} PPG next season, ${Math.round(100 * (surv[2] || 0))}% chance still a regular in 3 seasons` : "no NFL stats yet, so the score is market value only";
      explanation = `${p.age ? Math.floor(p.age) + "-yo " : ""}${p.pos}, market score ${Math.round(p.market)} across ${p.n} calculators, ${proj}.` +
        (archetype === "Core" ? " Elite now and later: a core asset for any team."
          : tag === "Sell before cliff" ? " Still producing, but the odds of lasting fall fast: sell to a contender."
          : archetype === "Contender" ? " Worth the most to a contender; rebuilders should sell."
          : archetype === "Rebuilder" ? " Value is in future seasons: best for a rebuilder."
          : " Balanced: fits a fringe team or holds for anyone.");
    }
    return { p, overall, fit: overall, market: p.market, now, long, hasStats, archetype, tag, explanation, trend: p.trend, trendHint: trendHint(p) };
  }

  // Trade: each asset's aggregate value is scaled by its overall score for the team type, then each side is
  // consolidated with the power-sum. total/rawAdj = plain sums, cons/adj = consolidated. The verdict per team
  // type uses the consolidated values: pct = |A - B| / mean(A, B), mapped to a band.
  function analyzeTrade(db, aIds, bIds) {
    const side = (ids) => {
      const rs = ids.map((i) => analyze(db, i)).filter(Boolean);
      const vals = rs.map((r) => r.p.value);
      const total = vals.reduce((s, v) => s + v, 0), cons = consolidate(vals);
      const adj = {}, rawAdj = {};
      TYPES.forEach((k) => {
        const sc = rs.map((r) => r.p.value * (0.5 + r.overall[k] / 100));
        rawAdj[k] = sc.reduce((s, v) => s + v, 0); adj[k] = consolidate(sc);
      });
      return { rs, total, cons, adj, rawAdj };
    };
    const A = side(aIds), B = side(bIds);
    const judge = (a, b) => {
      const d = a - b, avg = (a + b) / 2, pct = avg > 0 ? Math.abs(d) / avg : 0, band = bandOf(pct);
      return { winner: band === "Fair" ? "Even" : d > 0 ? "A" : "B", band, pct, delta: d };
    };
    const verdict = {}; TYPES.forEach((k) => (verdict[k] = judge(A.adj[k], B.adj[k])));
    return { A, B, verdict, market: judge(A.cons, B.cons), valueWinner: A.total === B.total ? "Even" : A.total > B.total ? "A" : "B" };
  }

  const api = { buildDB, analyze, analyzeTrade, fmtKey, consolidate, bandOf, trendHint, CONSOL_P, BANDS, W, PICK_ADJ, INJ, TYPES,
    LABEL: { Core: "Core asset (any team)", Contender: "Contender", Retooler: "Retooler", Rebuilder: "Rebuilder" } };
  if (typeof module !== "undefined") module.exports = api; else root.DPT = api;
})(typeof window !== "undefined" ? window : globalThis);
