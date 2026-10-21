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
  const clamp = (x, a = 0, b = 100) => Math.max(a, Math.min(b, x));
  const fmtKey = (qbs, ppr) => `${qbs == 2 ? "sf" : "1qb"}_${{ 1: "ppr", 0.5: "half", 0: "std" }[ppr] || "ppr"}`;

  // raw = {values, stats, players (slim Sleeper map), fmt}
  function buildDB(raw) {
    const vals = raw.values.formats[raw.fmt] || {}, sp = raw.players || {}, st = (raw.stats && raw.stats.players) || {};
    const list = [], picks = [];
    Object.entries(vals).forEach(([id, v]) => {
      const base = { id, name: v.name, pos: v.pos, market: v.marketScore, value: v.aggValue, n: v.n, spread: v.spread, by: v.by || {} };
      if (v.pos === "PICK") return picks.push({ ...base, team: "", isPick: true });
      if (!POS.includes(v.pos)) return;
      const p = sp[id] || {}, s = st[id] || null;
      list.push({ ...base, team: p.team || "FA", age: (s && s.age) || p.age || null, exp: p.years_exp,
        injury: p.injury_status || null, depth: p.depth_chart_order, st: s });
    });
    list.sort((a, b) => b.market - a.market);
    picks.sort((a, b) => a.name.localeCompare(b.name));
    const byId = {}; list.concat(picks).forEach((p) => (byId[p.id] = p));
    return { list, picks, byId, fmt: raw.fmt, generated: raw.values.generated, sources: raw.values.sources, statsMeta: raw.stats && raw.stats.meta };
  }

  function analyze(db, id) {
    const p = db.byId[String(id)];
    if (!p) return null;
    const overall = {};
    let now = null, long = null;
    const hasStats = !!(p.st && p.st.statScoreNow != null);
    if (p.isPick) TYPES.forEach((k) => (overall[k] = clamp(p.market + PICK_ADJ[k])));
    else {
      if (hasStats) { now = p.st.statScoreNow; long = p.st.statScoreLong; }
      TYPES.forEach((k) => {
        const stats = hasStats ? W[k].now * now + (1 - W[k].now) * long : null;
        overall[k] = hasStats ? W[k].m * p.market + (1 - W[k].m) * stats : p.market;
      });
      overall.Contender = clamp(overall.Contender - (INJ[(p.injury || "").toLowerCase()] || 0));
    }
    const d = overall.Contender - overall.Rebuilder;
    let archetype = d > 5 ? "Contender" : d < -5 ? "Rebuilder" : "Retooler";
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
    return { p, overall, fit: overall, market: p.market, now, long, hasStats, archetype, tag, explanation };
  }

  // Trade: each asset's aggregate value scaled by its overall score for that team type.
  function analyzeTrade(db, aIds, bIds) {
    const side = (ids) => {
      const rs = ids.map((i) => analyze(db, i)).filter(Boolean);
      const total = rs.reduce((s, r) => s + r.p.value, 0);
      const adj = {}; TYPES.forEach((k) => (adj[k] = rs.reduce((s, r) => s + r.p.value * (0.5 + r.overall[k] / 100), 0)));
      return { rs, total, adj };
    };
    const A = side(aIds), B = side(bIds);
    const verdict = {};
    TYPES.forEach((k) => {
      const d = A.adj[k] - B.adj[k];
      verdict[k] = { winner: Math.abs(d) < 0.03 * Math.max(A.adj[k], B.adj[k], 1) ? "Even" : d > 0 ? "A" : "B", delta: d };
    });
    return { A, B, verdict, valueWinner: A.total === B.total ? "Even" : A.total > B.total ? "A" : "B" };
  }

  const api = { buildDB, analyze, analyzeTrade, fmtKey, W, PICK_ADJ, INJ, TYPES,
    LABEL: { Core: "Core asset (any team)", Contender: "Contender", Retooler: "Retooler", Rebuilder: "Rebuilder" } };
  if (typeof module !== "undefined") module.exports = api; else root.DPT = api;
})(typeof window !== "undefined" ? window : globalThis);
