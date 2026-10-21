// Dynasty season Monte Carlo. Pure functions, runs in browser and node.
// Input (see League.toSimInput):
//   { slots:{QB,RB,WR,TE,FLEX,SF}, teams:[{id, players:[{pos,ppg,pMiss}], w,l,t,pf}],
//     weeks:[ [[teamIdx,teamIdx],...] per remaining regular-season week ],
//     playoff:{teams, reseed} }
// Model (spec 6a): true strength drawn once per sim as N(0,8) added to the team's weekly mean;
// weekly score ~ N(lineup + strength, 16% of the healthy lineup PPG); per-week injury misses
// refill the lineup from the bench (streamer QB 12 PPG, skill replacement 7 PPG).
(function (root) {
  const POS = { QB: 0, RB: 1, WR: 2, TE: 3 };
  const STRENGTH_SD = 8, NOISE_PCT = 0.16, K_PLAYERS = 18;
  const REPL_QB = 12, REPL_SKILL = 7;
  // Games missed per 11 weeks (research-calibrated), by position/age
  const missP = (pos, age) => {
    const a = age || 0;
    if (pos === "QB") return 1.2 / 11;
    if (pos === "WR") return 1.5 / 11;
    if (pos === "RB") return (a >= 29 ? 2.5 : 1.7) / 11;
    if (pos === "TE") return (a >= 32 ? 2.0 : 1.6) / 11;
    return 1.5 / 11;
  };
  const VET_AGE = 30, VET_SHADE = 1.5;
  const shade = (ppg, age) => (age >= VET_AGE ? Math.max(0, ppg - VET_SHADE) : ppg);

  function rng(seed) {
    let a = (seed >>> 0) || 1;
    const u = () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    let spare = null;
    const n = () => { if (spare !== null) { const s = spare; spare = null; return s; }
      let x, y, r; do { x = 2 * u() - 1; y = 2 * u() - 1; r = x * x + y * y; } while (r >= 1 || r === 0);
      const m = Math.sqrt(-2 * Math.log(r) / r); spare = y * m; return x * m; };
    return { u, n };
  }

  // Healthy best lineup (deterministic): sorted desc greedy fill, same rule the sim uses.
  function bestLineup(players, slots) {
    const c = [slots.QB, slots.RB, slots.WR, slots.TE]; let fl = slots.FLEX, sf = slots.SF, tot = 0; const used = [];
    const sorted = players.slice().sort((a, b) => b.ppg - a.ppg);
    for (const p of sorted) {
      const k = POS[p.pos]; if (k === undefined) continue;
      if (c[k] > 0) c[k]--; else if (k !== 0 && fl > 0) fl--; else if (sf > 0) sf--; else continue;
      tot += p.ppg; used.push(p);
    }
    tot += c[0] * REPL_QB + (c[1] + c[2] + c[3] + fl) * REPL_SKILL + sf * REPL_QB;
    return { total: tot, starters: used };
  }

  function prepare(input) {
    const slots = input.slots, need = slots.QB + slots.RB + slots.WR + slots.TE + slots.FLEX + slots.SF;
    const T = input.teams.map((t) => {
      const ps = t.players.slice().sort((a, b) => b.ppg - a.ppg).slice(0, K_PLAYERS);
      const pos = new Int8Array(K_PLAYERS).fill(-1), ppg = new Float64Array(K_PLAYERS), pm = new Float64Array(K_PLAYERS);
      ps.forEach((p, i) => { pos[i] = POS[p.pos]; ppg[i] = p.ppg; pm[i] = p.pMiss; });
      return { pos, ppg, pm, mean: bestLineup(ps, slots).total, w: t.w + (t.t || 0) / 2, pf: t.pf || 0 };
    });
    return { T, slots, need, weeks: input.weeks, playoff: input.playoff, ids: input.teams.map((t) => t.id) };
  }

  function run(input, opts) {
    opts = opts || {};
    const n = opts.n || 10000, R = rng(opts.seed || 12345), P = prepare(input), nt = P.T.length, S = P.slots;
    const strength = new Float64Array(nt), wins = new Float64Array(nt), pf = new Float64Array(nt);
    const cnt = { playoff: new Float64Array(nt), bye: new Float64Array(nt), title: new Float64Array(nt), wins: new Float64Array(nt) };
    const sd = P.T.map((t) => NOISE_PCT * t.mean);
    const nPlay = Math.min(P.playoff.teams, nt), reseed = P.playoff.reseed !== false;
    const size = Math.pow(2, Math.ceil(Math.log2(nPlay)));
    // standard bracket order for fixed (non-reseeding) playoffs: 1 v 8, 4 v 5, 3 v 6, 2 v 7 (absent seeds are byes)
    const order = (m) => { let o = [1]; for (let s = 2; s <= m; s *= 2) o = [].concat(...o.map((x) => [x, s + 1 - x])); return o; };
    const fixedOrder = order(size).map((s) => (s <= nPlay ? s : null));
    const c = [0, 0, 0, 0];
    const score = (t) => {
      const T = P.T[t]; c[0] = S.QB; c[1] = S.RB; c[2] = S.WR; c[3] = S.TE; let fl = S.FLEX, sf = S.SF, tot = 0;
      for (let i = 0; i < K_PLAYERS; i++) {
        const k = T.pos[i]; if (k < 0) break;
        if (R.u() < T.pm[i]) continue;
        if (c[k] > 0) c[k]--; else if (k !== 0 && fl > 0) fl--; else if (sf > 0) sf--; else continue;
        tot += T.ppg[i];
      }
      tot += c[0] * REPL_QB + (c[1] + c[2] + c[3] + fl) * REPL_SKILL + sf * REPL_QB;
      return tot + strength[t] + R.n() * sd[t];
    };
    const idx = Array.from({ length: nt }, (_, i) => i);
    const t0 = Date.now();
    for (let s = 0; s < n; s++) {
      for (let t = 0; t < nt; t++) { strength[t] = R.n() * STRENGTH_SD; wins[t] = P.T[t].w; pf[t] = P.T[t].pf; }
      for (const wk of P.weeks) for (const g of wk) {
        const a = g[0], b = g[1], sa = score(a), sb = score(b);
        pf[a] += sa; pf[b] += sb;
        if (sa > sb) wins[a]++; else if (sb > sa) wins[b]++; else { wins[a] += 0.5; wins[b] += 0.5; }
      }
      for (let t = 0; t < nt; t++) cnt.wins[t] += wins[t];
      idx.sort((x, y) => wins[y] - wins[x] || pf[y] - pf[x]);
      const seeds = idx.slice(0, nPlay); // seeds[0] = seed 1
      seeds.forEach((t, i) => { cnt.playoff[t]++; if (i < size - nPlay) cnt.bye[t]++; });
      let alive = seeds.map((t, i) => ({ t, seed: i + 1 }));
      const game = (x, y) => (score(x.t) > score(y.t) ? x : y);
      if (reseed) {
        // round 1 holds only the seeds without a bye; every later round re-pairs best vs worst
        const pair = (L) => { const w = []; for (let i = 0; i < L.length / 2; i++) w.push(game(L[i], L[L.length - 1 - i])); return w; };
        const nb = size - nPlay;
        let cur = alive.slice(0, nb).concat(pair(alive.slice(nb)));
        while (cur.length > 1) cur = pair(cur.sort((p, q) => p.seed - q.seed));
        const rest = cur;
        cnt.title[rest[0].t]++;
      } else {
        let slotsNow = fixedOrder.map((sd2) => (sd2 ? alive[sd2 - 1] : null));
        while (slotsNow.length > 1) {
          const nx = [];
          for (let i = 0; i < slotsNow.length; i += 2) { const x = slotsNow[i], y = slotsNow[i + 1]; nx.push(!x ? y : !y ? x : game(x, y)); }
          slotsNow = nx;
        }
        cnt.title[slotsNow[0].t]++;
      }
    }
    const out = P.ids.map((id, i) => ({ id, playoff: cnt.playoff[i] / n, bye: cnt.bye[i] / n, title: cnt.title[i] / n, wins: cnt.wins[i] / n, mean: P.T[i].mean }));
    return { n, ms: Date.now() - t0, teams: out };
  }

  const api = { run, bestLineup, shade, missP, rng, VET_AGE, VET_SHADE, STRENGTH_SD, NOISE_PCT, REPL_QB, REPL_SKILL };
  if (typeof module !== "undefined") module.exports = api; else root.Sim = api;
})(typeof window !== "undefined" ? window : globalThis);
