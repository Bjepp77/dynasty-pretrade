// Dynasty Pre-Trade scoring. Pure functions, runs in browser and node.
(function (root) {
  const POS = ["QB", "RB", "WR", "TE"];
  // [age, ageScore] anchors, linearly interpolated. Peak ~95-100, cliff = steep fall.
  const AGE_CURVE = {
    RB: { cliff: 27, pts: [[20, 80], [22, 95], [25, 95], [26, 70], [27, 40], [28, 20], [30, 5]] },
    WR: { cliff: 31, pts: [[20, 75], [23, 95], [27, 95], [29, 75], [31, 40], [33, 10]] },
    TE: { cliff: 31, pts: [[21, 55], [25, 90], [29, 90], [31, 50], [33, 15]] },
    QB: { cliff: 36, pts: [[21, 60], [25, 95], [32, 95], [34, 75], [36, 35], [39, 5]] },
  };
  const clamp = (x, a = 0, b = 100) => Math.max(a, Math.min(b, x));
  function interp(pts, x) {
    if (x <= pts[0][0]) return pts[0][1];
    for (let i = 1; i < pts.length; i++) {
      if (x <= pts[i][0]) {
        const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
        return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
      }
    }
    return pts[pts.length - 1][1];
  }
  const pctile = (arr, v) => (arr.length ? (100 * arr.filter((x) => x < v).length) / arr.length : 50);

  // raw = {players, dyn, red, stats, statsYear, sos}
  function buildDB(raw) {
    const redMap = {};
    (raw.red || []).forEach((r) => (redMap[r.player.sleeperId] = r.value));
    const list = [];
    (raw.dyn || []).forEach((r) => {
      const id = String(r.player.sleeperId);
      const sp = raw.players[id];
      if (!sp || !POS.includes(r.player.position)) return;
      const st = raw.stats[id] || {};
      const gp = st.gp || 0;
      list.push({
        id, name: r.player.name, pos: r.player.position, team: sp.team || r.player.maybeTeam,
        age: r.player.maybeAge || sp.age || 25, exp: sp.years_exp,
        injury: sp.injury_status || null, depth: sp.depth_chart_order,
        dynValue: r.value, redValue: redMap[id] != null ? redMap[id] : r.redraftValue,
        posRank: r.positionRank, overallRank: r.overallRank,
        gp, ppg: gp >= 1 ? (st.pts_ppr || 0) / gp : 0,
      });
    });
    list.sort((a, b) => b.dynValue - a.dynValue);
    const byId = {}; list.forEach((p) => (byId[p.id] = p));
    // production percentile per position (min 4 GP to count)
    const ppgByPos = {};
    POS.forEach((pos) => (ppgByPos[pos] = list.filter((p) => p.pos === pos && p.gp >= 4).map((p) => p.ppg)));
    // team offense quality = sum dynasty value of QB/WR/TE; percentile across teams
    const teamOff = {};
    list.forEach((p) => { if (p.pos !== "RB") teamOff[p.team] = (teamOff[p.team] || 0) + p.dynValue; });
    const teamVals = Object.values(teamOff);
    list.forEach((p) => (p.offQuality = pctile(teamVals, teamOff[p.team] || 0)));
    const maxVal = list[0] ? list[0].dynValue : 10000;
    return { list, byId, ppgByPos, maxVal, sos: raw.sos || {}, statsYear: raw.statsYear };
  }

  function analyze(db, id) {
    const p = db.byId[String(id)];
    if (!p) return null;
    const curve = AGE_CURVE[p.pos];
    const yearsToCliff = Math.max(0, +(curve.cliff - p.age).toFixed(1));
    const age = interp(curve.pts, p.age);

    // Health
    const injPen = { out: 50, ir: 60, pup: 45, sus: 40, doubtful: 30, questionable: 15 }[(p.injury || "").toLowerCase()] || 0;
    const gpScore = clamp((Math.min(p.gp, 17) / 17) * 100);
    const health = clamp(0.6 * gpScore + 40 - injPen);

    // Production
    const production = p.gp >= 4 ? pctile(db.ppgByPos[p.pos], p.ppg) : 35;

    // Situation: depth + offense + target competition
    const depthScore = p.depth == null ? 50 : { 1: 100, 2: 65, 3: 35 }[p.depth] || 20;
    const mates = db.list.filter((q) => q.team === p.team && q.pos === p.pos && q.id !== p.id && q.dynValue > p.dynValue);
    const compScore = [100, 65, 35][mates.length] != null ? [100, 65, 35][mates.length] : 15;
    const situation = 0.4 * depthScore + 0.3 * p.offQuality + 0.3 * compScore;

    // SOS (1 easiest -> 100)
    const rank = db.sos[p.team];
    const sos = rank ? clamp(((32 - rank) / 31) * 100) : 50;

    // Value + future premium (dynasty value minus redraft value)
    const value = clamp((p.dynValue / db.maxVal) * 100 * 1.15);
    const premiumPct = p.dynValue ? (p.dynValue - p.redValue) / p.dynValue : 0;
    const futurePremium = clamp(50 + premiumPct * 400);

    const winNow = 0.35 * production + 0.2 * health + 0.2 * situation + 0.1 * sos + 0.1 * value + 0.05 * age;
    const longTerm = 0.35 * age + 0.25 * futurePremium + 0.25 * value + 0.1 * health + 0.05 * situation;
    const diff = winNow - longTerm;
    let archetype = "Retooler", tag = "Hold";
    if (diff > 10) { archetype = "Contender"; tag = "Buy for contenders"; }
    else if (diff < -10) { archetype = "Rebuilder"; tag = "Rebuilder stash"; }
    if (archetype === "Retooler" && winNow >= 75 && longTerm >= 75) tag = "Buy for anyone (core hold)";
    if (yearsToCliff <= 1.5 && winNow >= 50 && archetype !== "Rebuilder") { tag = "Sell before cliff"; if (diff > 0) archetype = "Contender"; }
    const fit = { Contender: winNow, Retooler: (winNow + longTerm) / 2, Rebuilder: longTerm };

    const ppgRankTxt = p.gp >= 4 ? `top-${Math.max(1, Math.round((100 - production) / 100 * db.ppgByPos[p.pos].length) + 1)} ${p.pos} in PPG` : "limited games last year";
    const explanation = `${Math.floor(p.age)}-yo ${p.pos}, ${yearsToCliff} seasons from the cliff, ${ppgRankTxt}` +
      (archetype === "Contender" ? `: max value to a contender now${tag === "Sell before cliff" ? "; sell before the cliff hits" : ""}; rebuilders should sell.`
        : archetype === "Rebuilder" ? ": long runway and future premium, best value to a rebuilder; contenders gain little."
        : ": balanced profile, fits a fringe team or holds for anyone.");
    return { p, yearsToCliff, scores: { production, health, situation, sos, age, value, futurePremium }, detail: { depthScore, offQuality: p.offQuality, compScore, teammatesAhead: mates.length, premiumPct },
      winNow, longTerm, diff, archetype, tag, fit, explanation };
  }

  // Archetype-adjusted value: raw dynasty value scaled by how well each player fits that team type.
  function analyzeTrade(db, aIds, bIds) {
    const side = (ids) => {
      const rs = ids.map((i) => analyze(db, i)).filter(Boolean);
      const total = rs.reduce((s, r) => s + r.p.dynValue, 0);
      const adj = (k) => rs.reduce((s, r) => s + r.p.dynValue * (0.5 + r.fit[k] / 100), 0);
      return { rs, total, adj: { Contender: adj("Contender"), Retooler: adj("Retooler"), Rebuilder: adj("Rebuilder") } };
    };
    const A = side(aIds), B = side(bIds);
    const verdict = {};
    ["Contender", "Retooler", "Rebuilder"].forEach((k) => {
      const d = A.adj[k] - B.adj[k];
      verdict[k] = { winner: Math.abs(d) < 0.03 * Math.max(A.adj[k], B.adj[k], 1) ? "Even" : d > 0 ? "A" : "B", delta: d };
    });
    return { A, B, verdict, valueWinner: A.total === B.total ? "Even" : A.total > B.total ? "A" : "B" };
  }

  const api = { buildDB, analyze, analyzeTrade, AGE_CURVE };
  if (typeof module !== "undefined") module.exports = api; else root.DPT = api;
})(typeof window !== "undefined" ? window : globalThis);
