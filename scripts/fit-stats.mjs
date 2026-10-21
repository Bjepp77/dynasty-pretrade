#!/usr/bin/env node
// Fits per-position ridge models (QB/RB/WR/TE) that predict next-season PPR PPG from nflverse
// season stats, then writes data/stats.json. Usage: node scripts/fit-stats.mjs
// Downloads are cached in .cache/ (gitignored). Delete it to refetch. See docs/stats-model.md.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CACHE = path.join(ROOT, ".cache");
const OUT = path.join(ROOT, "data", "stats.json");
const NFLV = "https://github.com/nflverse/nflverse-data/releases/download";
const IDS_URL = "https://raw.githubusercontent.com/dynastyprocess/data/master/files/db_playerids.csv";

const FIRST_YEAR = 2017; // needed so 2018 rows have a prior season
const LAST_YEAR = 2025; // last complete regular season
const TRAIN_FIRST = 2018; // first feature season used for training
const HOLD_YEAR = 2025; // holdout target season (h=1: features 2024)
const HORIZONS = [1, 2, 3];
const DISCOUNT = 0.9; // per-year discount for the 3-year sum
const MIN_GP_FEAT = 3; // feature season needs >= this many games
const MIN_GP_TARGET = 6; // target season needs >= this many games
const POS = ["QB", "RB", "WR", "TE"];
const POOL = { QB: 12, RB: 24, WR: 36, TE: 12 }; // starter pool (z-score reference) per position
const AGE_KNOTS = [24, 27, 29, 31, 33]; // hinge knots for the piecewise-linear age effect
const LAMBDAS = [0.3, 1, 3, 10, 30, 100, 300, 1000];
const NOW = new Date("2026-10-21T00:00:00Z"); // model-age reference is Sep 1 of the feature season

// ---------- download + csv ----------
async function fetchCached(name, url) {
  fs.mkdirSync(CACHE, { recursive: true });
  const f = path.join(CACHE, name);
  if (fs.existsSync(f) && fs.statSync(f).size > 200) return fs.readFileSync(f, "utf8");
  process.stderr.write(`download ${name}\n`);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  const t = await r.text();
  fs.writeFileSync(f, t);
  return t;
}
function parseCsv(text) {
  const rows = [];
  let row = [], cur = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cur); cur = ""; }
    else if (c === "\n") { row.push(cur.replace(/\r$/, "")); rows.push(row); row = []; cur = ""; }
    else cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  const head = rows.shift();
  return rows.filter((r) => r.length === head.length).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}
const num = (v) => { if (v === undefined || v === "" || v === "NA") return NaN; const n = Number(v); return Number.isFinite(n) ? n : NaN; };
const nz = (v) => (Number.isFinite(v) ? v : 0);
const div = (a, b) => (Number.isFinite(a) && Number.isFinite(b) && b > 0 ? a / b : NaN);

// ---------- linear algebra ----------
function solve(A, b) { // gaussian elimination with partial pivoting
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = s / M[r][r];
  }
  return x;
}
// X already standardized (NaN-free). Returns {b0, b[]} on the standardized scale.
function ridge(X, y, lambda) {
  const n = X.length, p = X[0].length;
  const ym = y.reduce((a, b) => a + b, 0) / n;
  const A = Array.from({ length: p }, () => new Array(p).fill(0)), b = new Array(p).fill(0);
  for (let i = 0; i < n; i++) for (let j = 0; j < p; j++) {
    b[j] += X[i][j] * (y[i] - ym);
    for (let k = j; k < p; k++) A[j][k] += X[i][j] * X[i][k];
  }
  for (let j = 0; j < p; j++) { for (let k = 0; k < j; k++) A[j][k] = A[k][j]; A[j][j] += lambda; }
  return { b0: ym, b: solve(A, b) };
}
const predict = (m, x) => m.b.reduce((s, c, j) => s + c * x[j], m.b0);
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;

// ---------- load data ----------
const years = []; for (let y = FIRST_YEAR; y <= LAST_YEAR; y++) years.push(y);
const idsRaw = parseCsv(await fetchCached("db_playerids.csv", IDS_URL));
const idByGsis = new Map(), idByPfr = new Map();
for (const r of idsRaw) {
  if (r.gsis_id && r.gsis_id !== "NA") idByGsis.set(r.gsis_id, r);
  if (r.pfr_id && r.pfr_id !== "NA") idByPfr.set(r.pfr_id, r);
}
// snap %: mean offense_pct over regular-season games with offensive snaps, keyed gsis_id|season
const snapPct = new Map();
for (const y of years) {
  const rows = parseCsv(await fetchCached(`snap_counts_${y}.csv`, `${NFLV}/snap_counts/snap_counts_${y}.csv`));
  const acc = new Map();
  for (const r of rows) {
    if (r.game_type !== "REG" || !(num(r.offense_snaps) > 0)) continue;
    const id = idByPfr.get(r.pfr_player_id)?.gsis_id;
    if (!id) continue;
    const a = acc.get(id) || [0, 0]; a[0] += num(r.offense_pct); a[1]++; acc.set(id, a);
  }
  for (const [id, [s, n]] of acc) snapPct.set(id + "|" + y, s / n);
}

const season = new Map(); // gsis|year -> derived row
const lastSeen = new Map(); // gsis -> last year with a row
for (const y of years) {
  const rows = parseCsv(await fetchCached(`stats_player_reg_${y}.csv`, `${NFLV}/stats_player/stats_player_reg_${y}.csv`));
  for (const r of rows) {
    if (r.season_type !== "REG" || !POS.includes(r.position)) continue;
    const g = num(r.games), id = r.player_id;
    if (!(g > 0)) continue;
    const att = num(r.attempts), sacks = num(r.sacks_suffered), car = num(r.carries), tgt = num(r.targets);
    const row = {
      id, year: y, pos: r.position, name: r.player_display_name, games: g,
      ppg: num(r.fantasy_points_ppr) / g,
      gpf: Math.min(g, 17) / 17,
      att_pg: nz(att) / g, car_pg: nz(car) / g, tgt_pg: nz(tgt) / g,
      epa_db: div(num(r.passing_epa), att + sacks), cpoe: num(r.passing_cpoe),
      ypa: div(num(r.passing_yards), att), sack_rate: div(sacks, att + sacks),
      rush_ppg: (nz(num(r.rushing_yards)) * 0.1 + nz(num(r.rushing_tds)) * 6) / g,
      rush_epa_pc: div(num(r.rushing_epa), car), ypc: div(num(r.rushing_yards), car),
      target_share: num(r.target_share), air_yards_share: num(r.air_yards_share), wopr: num(r.wopr),
      rec_epa_pt: div(num(r.receiving_epa), tgt), ypt: div(num(r.receiving_yards), tgt),
      adot: div(num(r.receiving_air_yards), tgt), racr: num(r.racr),
      snap_pct: snapPct.get(id + "|" + y) ?? NaN,
    };
    if (!Number.isFinite(row.ppg)) continue;
    season.set(id + "|" + y, row);
    lastSeen.set(id, Math.max(lastSeen.get(id) || 0, y));
  }
}

// ---------- features ----------
const FEATS = { // [name, group]
  QB: [["ppg", "prod"], ["ppg_prev", "prod"], ["att_pg", "usage"], ["rush_ppg", "usage"], ["epa_db", "eff"], ["cpoe", "eff"], ["ypa", "eff"], ["sack_rate", "eff"], ["gpf", "avail"], ["gpf_prev", "avail"]],
  RB: [["ppg", "prod"], ["ppg_prev", "prod"], ["car_pg", "usage"], ["tgt_pg", "usage"], ["target_share", "usage"], ["snap_pct", "usage"], ["rush_epa_pc", "eff"], ["ypc", "eff"], ["ypt", "eff"], ["gpf", "avail"], ["gpf_prev", "avail"]],
  WR: [["ppg", "prod"], ["ppg_prev", "prod"], ["tgt_pg", "usage"], ["target_share", "usage"], ["air_yards_share", "usage"], ["wopr", "usage"], ["snap_pct", "usage"], ["rec_epa_pt", "eff"], ["ypt", "eff"], ["adot", "eff"], ["racr", "eff"], ["gpf", "avail"], ["gpf_prev", "avail"]],
  TE: [["ppg", "prod"], ["ppg_prev", "prod"], ["tgt_pg", "usage"], ["target_share", "usage"], ["air_yards_share", "usage"], ["wopr", "usage"], ["snap_pct", "usage"], ["rec_epa_pt", "eff"], ["ypt", "eff"], ["adot", "eff"], ["gpf", "avail"], ["gpf_prev", "avail"]],
};
const ageAt = (birth, y) => (new Date(Date.UTC(y, 8, 1)) - birth) / (365.25 * 864e5);
function birthOf(id) {
  const b = idByGsis.get(id)?.birthdate;
  const d = b && b !== "NA" ? new Date(b + "T00:00:00Z") : null;
  return d && !isNaN(d) ? d : null;
}
// feature vector (raw, may contain NaN) for a player-season; age handled separately
function featRow(r) {
  const prev = season.get(r.id + "|" + (r.year - 1));
  const hasPrev = prev && prev.games >= MIN_GP_FEAT;
  return { ...r, ppg_prev: hasPrev ? prev.ppg : r.ppg, gpf_prev: prev ? prev.gpf : 0 };
}
// replacement-level PPG for players who left the league (target imputation for h>=2)
const floorPPG = {};
for (const pos of POS) {
  const v = [...season.values()].filter((r) => r.pos === pos && r.games >= MIN_GP_TARGET).map((r) => r.ppg).sort((a, b) => a - b);
  floorPPG[pos] = v[Math.floor(v.length * 0.15)];
}
function targetFor(r, h) {
  const t = season.get(r.id + "|" + (r.year + h));
  if (t && t.games >= MIN_GP_TARGET) return t.ppg;
  if (h >= 2 && !t && (lastSeen.get(r.id) || 0) < r.year + h && r.year + h <= LAST_YEAR) return floorPPG[r.pos]; // gone from the league
  return NaN;
}
function samples(pos, h, yFrom, yTo) {
  const out = [];
  for (let y = yFrom; y <= yTo; y++) {
    for (const r of season.values()) {
      if (r.year !== y || r.pos !== pos || r.games < MIN_GP_FEAT) continue;
      const birth = birthOf(r.id);
      if (!birth) continue;
      const t = targetFor(r, h);
      if (!Number.isFinite(t)) continue;
      out.push({ ...featRow(r), age: ageAt(birth, y), target: t });
    }
  }
  return out;
}

// design matrix: features + age + age hinges. Standardization params come from the training set.
function colsFor(pos) { return [...FEATS[pos].map((f) => f[0]), "age", ...AGE_KNOTS.map((k) => "hinge" + k)]; }
function rawVec(pos, row, ageClamp) {
  const a = Math.min(Math.max(row.age, ageClamp[0]), ageClamp[1]);
  return [...FEATS[pos].map(([f]) => row[f]), a, ...AGE_KNOTS.map((k) => Math.max(0, a - k))];
}
function ageRange(rows) { // ages with >= 8 training rows bound the curve; outside is clamped, not extrapolated
  const c = {};
  rows.forEach((r) => { const k = Math.round(r.age); c[k] = (c[k] || 0) + 1; });
  const ok = Object.keys(c).map(Number).filter((k) => c[k] >= 8);
  return [Math.min(...ok), Math.max(...ok)];
}
function fit(pos, rows) {
  const clamp = ageRange(rows);
  const raw = rows.map((r) => rawVec(pos, r, clamp));
  const p = raw[0].length, mu = [], sd = [];
  for (let j = 0; j < p; j++) {
    const v = raw.map((r) => r[j]).filter(Number.isFinite);
    const m = mean(v); mu.push(m); sd.push(Math.sqrt(mean(v.map((x) => (x - m) ** 2))) || 1);
  }
  const Z = (vec) => vec.map((x, j) => (Number.isFinite(x) ? (x - mu[j]) / sd[j] : 0));
  const X = raw.map(Z), y = rows.map((r) => r.target);
  // leave-one-feature-year-out CV picks lambda
  const yrs = [...new Set(rows.map((r) => r.year))];
  let best = null;
  for (const lam of LAMBDAS) {
    let se = 0, n = 0;
    for (const hy of yrs) {
      const tr = [], te = [];
      rows.forEach((r, i) => (r.year === hy ? te : tr).push(i));
      if (!tr.length || !te.length) continue;
      const m = ridge(tr.map((i) => X[i]), tr.map((i) => y[i]), lam);
      te.forEach((i) => { se += (predict(m, X[i]) - y[i]) ** 2; n++; });
    }
    if (!best || se / n < best.mse) best = { lam, mse: se / n };
  }
  const m = ridge(X, y, best.lam);
  return { pos, cols: colsFor(pos), mu, sd, clamp, lambda: best.lam, ...m, Z, n: rows.length, meanPPG: mean(y) };
}
const predRow = (M, row) => predict(M, M.Z(rawVec(M.pos, row, M.clamp)));
// raw-unit age effect in PPG at a given age (relative curve; intercept absorbed)
function ageEffect(M, age) {
  const a = Math.min(Math.max(age, M.clamp[0]), M.clamp[1]);
  const vec = [a, ...AGE_KNOTS.map((k) => Math.max(0, a - k))];
  const off = M.cols.indexOf("age");
  return vec.reduce((s, x, i) => s + (M.b[off + i] * (x - M.mu[off + i])) / M.sd[off + i], 0);
}
function metrics(pred, actual, base) {
  const r2 = (p) => { const m = mean(actual); return 1 - actual.reduce((s, a, i) => s + (a - p[i]) ** 2, 0) / actual.reduce((s, a) => s + (a - m) ** 2, 0); };
  const mae = (p) => mean(actual.map((a, i) => Math.abs(a - p[i])));
  return { n: actual.length, r2: +r2(pred).toFixed(3), mae: +mae(pred).toFixed(2), baselineR2: +r2(base).toFixed(3), baselineMae: +mae(base).toFixed(2) };
}

// ---------- evaluate (holdout) ----------
const report = {};
for (const pos of POS) {
  report[pos] = {};
  for (const h of HORIZONS) {
    const holdY = HOLD_YEAR - h; // feature season whose target is the unseen 2025
    const train = samples(pos, h, TRAIN_FIRST, holdY - 1);
    const test = samples(pos, h, holdY, holdY);
    const M = fit(pos, train);
    report[pos]["h" + h] = { trainRows: train.length, lambda: M.lambda, holdout: { featureYear: holdY, targetYear: HOLD_YEAR, ...metrics(test.map((r) => predRow(M, r)), test.map((r) => r.target), test.map((r) => r.ppg)) } };
  }
}

// ---------- final fit (all data) + projections ----------
const final = {};
for (const pos of POS) {
  final[pos] = {};
  for (const h of HORIZONS) final[pos][h] = fit(pos, samples(pos, h, TRAIN_FIRST, LAST_YEAR - h));
}
// survival: P(player has >= 8 games in year Y+k | pos, age at Y), logistic in age (linear + hinge at 30), fitted by IRLS.
// Sample: fantasy-relevant players only (top 2x the starter pool by PPG among 6+ game seasons), otherwise fringe churn
// dominates. Missing the later season (retired, cut, injured out) counts as 0.
const surv = {};
const sfeat = (a) => [1, a - 28, Math.max(0, a - 30)];
for (const pos of POS) {
  surv[pos] = {};
  for (const k of HORIZONS) {
    const X = [], Y = [];
    for (let y = TRAIN_FIRST; y <= LAST_YEAR - k; y++) {
      const cur = [...season.values()].filter((r) => r.year === y && r.pos === pos && r.games >= 6).sort((u, v) => v.ppg - u.ppg).slice(0, POOL[pos] * 2);
      for (const r of cur) {
        const b = birthOf(r.id); if (!b) continue;
        const t = season.get(r.id + "|" + (y + k));
        X.push(sfeat(ageAt(b, y))); Y.push(t && t.games >= 8 ? 1 : 0);
      }
    }
    let w = [0, 0, 0];
    for (let it = 0; it < 30; it++) {
      const H = [[1e-3, 0, 0], [0, 1e-3, 0], [0, 0, 1e-3]], g = [0, 0, 0];
      X.forEach((x, i) => {
        const pr = 1 / (1 + Math.exp(-x.reduce((s2, v, j) => s2 + v * w[j], 0)));
        for (let j = 0; j < 3; j++) { g[j] += x[j] * (Y[i] - pr); for (let l = 0; l < 3; l++) H[j][l] += x[j] * x[l] * pr * (1 - pr); }
      });
      const d = solve(H, g); w = w.map((v, j) => v + d[j]);
    }
    surv[pos][k] = (age) => 1 / (1 + Math.exp(-sfeat(Math.min(age, 40)).reduce((s2, v, j) => s2 + v * w[j], 0)));
  }
}
const Phi = (z) => { // normal CDF (Abramowitz-Stegun 7.1.26)
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2), y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z / 2);
  return z >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
};
function zscore(pool, v) { const m = mean(pool), sd = Math.sqrt(mean(pool.map((x) => (x - m) ** 2))) || 1; return (v - m) / sd; }
const out = {}, rows = [];
const round = (x, d = 2) => +x.toFixed(d);
for (const r of season.values()) {
  if (r.year !== LAST_YEAR || r.games < MIN_GP_FEAT) continue;
  const rec = idByGsis.get(r.id);
  if (!rec || rec.sleeper_id === "NA" || !rec.team || rec.team === "NA" || rec.team === "FA") continue; // retired / unmapped
  const birth = birthOf(r.id);
  if (!birth) continue;
  const row = { ...featRow(r), age: ageAt(birth, LAST_YEAR) };
  const proj = HORIZONS.map((h) => Math.max(0, predRow(final[r.pos][h], row)));
  // components: PPG contribution of each feature group in the h=1 model, plus the intercept
  const M1 = final[r.pos][1], z = M1.Z(rawVec(r.pos, row, M1.clamp)), comp = { baseline: round(M1.b0) };
  const groups = { prod: "recentProduction", usage: "usage", eff: "efficiency", avail: "availability" };
  FEATS[r.pos].forEach(([, g], j) => { const k = groups[g]; comp[k] = round((comp[k] || 0) + M1.b[j] * z[j]); });
  const off = M1.cols.indexOf("age");
  comp.age = round(z.slice(off).reduce((s, v, i) => s + M1.b[off + i] * v, 0));
  const metricNames = FEATS[r.pos].map((f) => f[0]).filter((f) => !["ppg_prev", "gpf_prev"].includes(f));
  comp.metrics = Object.fromEntries(metricNames.map((f) => [f, Number.isFinite(row[f]) ? round(row[f], 3) : null]));
  comp.gamesLastSeason = r.games;
  const age = (NOW - birth) / (365.25 * 864e5);
  const e = { name: r.name, pos: r.pos, age: round(age, 1), projPPG1: round(proj[0]), projPPG3: round(proj[2]), projPPG2: round(proj[1]), survival: HORIZONS.map((k) => round(surv[r.pos][k](row.age), 3)), _long: 0, components: comp };
  e._long = HORIZONS.reduce((t, k, i) => t + DISCOUNT ** i * e.survival[i] * proj[i], 0); e.longPPG = round(e._long);
  out[String(rec.sleeper_id)] = e; rows.push(e);
}
for (const pos of POS) {
  const list = rows.filter((e) => e.pos === pos);
  const poolNow = [...list].sort((a, b) => b.projPPG1 - a.projPPG1).slice(0, POOL[pos]).map((e) => e.projPPG1);
  const poolLong = [...list].sort((a, b) => b._long - a._long).slice(0, POOL[pos]).map((e) => e._long);
  list.forEach((e) => { e.statScoreNow = round(100 * Phi(zscore(poolNow, e.projPPG1)), 1); e.statScoreLong = round(100 * Phi(zscore(poolLong, e._long)), 1); });
}
rows.forEach((e) => delete e._long);

// ---------- age curves ----------
const ageCurves = {};
for (const pos of POS) {
  const [lo, hi] = final[pos][1].clamp;
  const ages = []; for (let a = lo; a <= hi; a++) ages.push(a);
  const ref = final[pos][1].meanPPG;
  const eff = (h, a) => round(ageEffect(final[pos][h], a));
  const e1 = ages.map((a) => eff(1, a));
  ageCurves[pos] = {
    ages, ageDefinition: "age on Sep 1 of the season being used as the feature season",
    effectPPG: { h1: e1, h2: ages.map((a) => eff(2, a)), h3: ages.map((a) => eff(3, a)) },
    // expected change in next-season PPG from being one year older, holding usage/production fixed
    yearlyDeltaPPG: ages.slice(0, -1).map((a, i) => round(e1[i + 1] - e1[i], 3)),
    yearlyDeltaPct: ages.slice(0, -1).map((a, i) => round(((e1[i + 1] - e1[i]) / ref) * 100, 1)),
    refPPG: round(ref), hingeKnots: AGE_KNOTS,
  };
}

const survivalCurves = {};
for (const pos of POS) {
  const ages = []; for (let a = 21; a <= 38; a++) ages.push(a);
  survivalCurves[pos] = { ages, definition: "P(>= 8 games in season Y+k | age on Sep 1 of season Y, >= 3 games in Y)", ...Object.fromEntries(HORIZONS.map((k) => ["k" + k, ages.map((a) => round(surv[pos][k](a), 3))])) };
}
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({
  meta: {
    generated: new Date().toISOString(), featureSeason: LAST_YEAR, projects: [LAST_YEAR + 1, LAST_YEAR + 2, LAST_YEAR + 3],
    discount: DISCOUNT, scoring: "PPR", source: "nflverse stats_player + snap_counts, dynastyprocess db_playerids",
    note: "statScoreNow/Long = 100*Phi(z), z vs the position starter pool (top N by the same metric; N: " + JSON.stringify(POOL) + "). 50 = average starter. statScoreLong uses sum_k discount^(k-1) * survival_k * projPPG_k (longPPG).",
    holdout: report,
  },
  ageCurves,
  survivalCurves,
  players: out,
}, null, 1));

// ---------- console summary ----------
console.log("Holdout (target 2025), model vs last-year-PPG baseline:");
for (const pos of POS) for (const h of HORIZONS) {
  const x = report[pos]["h" + h].holdout;
  console.log(`${pos} h${h} n=${x.n} R2 ${x.r2} MAE ${x.mae} | baseline R2 ${x.baselineR2} MAE ${x.baselineMae} (lambda ${report[pos]["h" + h].lambda})`);
}
for (const key of ["statScoreNow", "statScoreLong"]) {
  console.log(`\nTop 10 ${key}:`);
  [...rows].sort((a, b) => b[key] - a[key] || b.projPPG1 - a.projPPG1).slice(0, 10).forEach((e) => console.log(`  ${e.name} ${e.pos} age ${e.age} ppg1/2/3 ${e.projPPG1}/${e.projPPG2}/${e.projPPG3} surv ${e.survival.join("/")} longPPG ${e.longPPG} now ${e.statScoreNow} long ${e.statScoreLong}`));
}
console.log(`\nwrote ${OUT}: ${rows.length} players`);
