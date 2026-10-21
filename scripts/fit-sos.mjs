#!/usr/bin/env node
// Strength of schedule from nflverse: fantasy points (PPR) each defense allows per game to QB/RB/WR/TE, blended from the
// prior season and the current season to date, then averaged over each team's remaining opponents. Writes data/sos.json.
// Usage: node scripts/fit-sos.mjs   (downloads cached in .cache/, gitignored). Method and validation: README "Strength of schedule".
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CACHE = path.join(ROOT, ".cache");
const OUT = path.join(ROOT, "data", "sos.json");
const NFLV = "https://github.com/nflverse/nflverse-data/releases/download";
const GAMES_URL = "https://github.com/nflverse/nfldata/raw/master/data/games.csv";
const SEASON = Number(process.env.SEASON) || 2026; // current season (remaining schedule)
const POS = ["QB", "RB", "WR", "TE"];
const SPLIT_WEEK = 6; // validation: weeks 1..SPLIT_WEEK are "season to date", the rest is the truth to predict
const K_GRID = [0, 2, 4, 6, 9, 12, 18, 30, Infinity]; // prior strength (games) for the blend weight w = g / (g + K)
const S_GRID = [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1]; // shrink of the blended index toward 1.00 (league average)
const FANTASY_PLAYOFFS = [15, 16, 17];

async function fetchCached(name, url, maxAgeH = Infinity) {
  fs.mkdirSync(CACHE, { recursive: true });
  const f = path.join(CACHE, name);
  if (fs.existsSync(f) && fs.statSync(f).size > 200 && (Date.now() - fs.statSync(f).mtimeMs) / 36e5 < maxAgeH) return fs.readFileSync(f, "utf8");
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
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(cur); cur = ""; }
    else if (c === "\n") { row.push(cur.replace(/\r$/, "")); rows.push(row); row = []; cur = ""; }
    else cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  const head = rows.shift();
  return rows.filter((r) => r.length === head.length).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
const round = (x, d = 3) => +x.toFixed(d);
function corr(a, b) {
  const ma = mean(a), mb = mean(b);
  let sab = 0, saa = 0, sbb = 0;
  a.forEach((x, i) => { sab += (x - ma) * (b[i] - mb); saa += (x - ma) ** 2; sbb += (b[i] - mb) ** 2; });
  return sab / Math.sqrt(saa * sbb);
}

// weekly REG rows -> per defense: {pos: [points allowed in each game]} for weeks in [w0, w1]
const weekly = {};
async function weeks(y) {
  if (!weekly[y]) weekly[y] = parseCsv(await fetchCached(`stats_player_week_${y}.csv`, `${NFLV}/stats_player/stats_player_week_${y}.csv`, y === SEASON ? 12 : Infinity)).filter((r) => r.season_type === "REG");
  return weekly[y];
}
async function allowed(y, w0, w1) {
  const g = new Map(); // def|pos|game_id -> points
  for (const r of await weeks(y)) {
    const wk = +r.week;
    if (wk < w0 || wk > w1 || !POS.includes(r.position)) continue;
    const pts = Number(r.fantasy_points_ppr);
    if (!Number.isFinite(pts)) continue;
    const k = r.opponent_team + "|" + r.position + "|" + r.game_id;
    g.set(k, (g.get(k) || 0) + pts);
  }
  const out = {}; // def -> pos -> {ppg, games}
  for (const [k, pts] of g) {
    const [def, pos] = k.split("|");
    ((out[def] ||= {})[pos] ||= []).push(pts);
  }
  const res = {};
  for (const def of Object.keys(out)) {
    res[def] = {};
    for (const pos of POS) { const a = out[def][pos] || []; res[def][pos] = { ppg: a.length ? mean(a) : NaN, games: a.length }; }
  }
  // index = allowed / league average for that window (1.00 = average defense, >1 = easier matchup)
  for (const pos of POS) {
    const lg = mean(Object.values(res).map((d) => d[pos].ppg).filter(Number.isFinite));
    for (const def of Object.keys(res)) res[def][pos].idx = res[def][pos].ppg / lg;
  }
  return res;
}
const est = (prior, early, g, K, s) => {
  const p = Number.isFinite(prior) ? prior : 1, e = Number.isFinite(early) ? early : 1;
  const w = K === Infinity ? 0 : g / (g + K);
  return 1 + s * (w * e + (1 - w) * p - 1);
};

// ---------- validation: predict weeks SPLIT_WEEK+1..18 of a season from the prior season + weeks 1..SPLIT_WEEK ----------
const PAIRS = [[2023, 2024], [2024, 2025]];
const cases = []; // {pos, prior, early, g, truth}
for (const [py, ty] of PAIRS) {
  const prior = await allowed(py, 1, 18), early = await allowed(ty, 1, SPLIT_WEEK), late = await allowed(ty, SPLIT_WEEK + 1, 18);
  for (const def of Object.keys(late)) for (const pos of POS) {
    const t = late[def][pos];
    if (!Number.isFinite(t.idx)) continue;
    cases.push({ pos, pair: `${py}->${ty}`, prior: prior[def]?.[pos].idx, early: early[def]?.[pos].idx, g: early[def]?.[pos].games || 0, truth: t.idx });
  }
}
const mse = (K, s, rows) => mean(rows.map((c) => (est(c.prior, c.early, c.g, K, s) - c.truth) ** 2));
let best = null;
for (const K of K_GRID) for (const s of S_GRID) { const m = mse(K, s, cases); if (!best || m < best.mse) best = { K, s, mse: m }; }
const validation = { pairs: PAIRS.map((p) => p.join("->")), splitWeek: SPLIT_WEEK, chosen: { K: best.K === Infinity ? null : best.K, shrink: best.s }, byPos: {} };
for (const pos of POS) {
  const rows = cases.filter((c) => c.pos === pos), truth = rows.map((c) => c.truth);
  const fit = rows.map((c) => est(c.prior, c.early, c.g, best.K, best.s));
  validation.byPos[pos] = {
    n: rows.length,
    corrPriorOnly: round(corr(rows.map((c) => c.prior ?? 1), truth)),
    corrToDateOnly: round(corr(rows.map((c) => c.early ?? 1), truth)),
    corrBlend: round(corr(fit, truth)),
    rmseBlend: round(Math.sqrt(mean(fit.map((f, i) => (f - truth[i]) ** 2)))),
    rmseAverage: round(Math.sqrt(mean(truth.map((t) => (t - 1) ** 2)))), // "every defense is average" baseline
  };
}

// ---------- current season: defense index + remaining schedule ----------
const games = parseCsv(await fetchCached("games.csv", GAMES_URL, 12)).filter((g) => +g.season === SEASON && g.game_type === "REG");
const played = games.filter((g) => g.home_score !== "" && g.home_score !== "NA");
const lastWeek = played.length ? Math.max(...played.map((g) => +g.week)) : 0;
const prior = await allowed(SEASON - 1, 1, 18);
const toDate = lastWeek ? await allowed(SEASON, 1, lastWeek) : {};
const defense = {};
for (const def of new Set([...Object.keys(prior), ...Object.keys(toDate)])) {
  defense[def] = {};
  for (const pos of POS) {
    const p = prior[def]?.[pos], e = toDate[def]?.[pos];
    defense[def][pos] = { idx: round(est(p?.idx, e?.idx, e?.games || 0, best.K, best.s)), priorIdx: p ? round(p.idx) : null, toDateIdx: e && Number.isFinite(e.idx) ? round(e.idx) : null, toDateGames: e?.games || 0, toDatePPG: e && Number.isFinite(e.ppg) ? round(e.ppg, 1) : null };
  }
}
const remaining = games.filter((g) => !played.includes(g));
const teams = {};
for (const g of remaining) for (const [team, opp] of [[g.home_team, g.away_team], [g.away_team, g.home_team]]) (teams[team] ||= []).push({ week: +g.week, opp });
const schedule = {};
for (const [team, list] of Object.entries(teams)) {
  list.sort((a, b) => a.week - b.week);
  const avg = (sub, pos) => (sub.length ? round(mean(sub.map((x) => defense[x.opp]?.[pos].idx ?? 1))) : null);
  const po = list.filter((x) => FANTASY_PLAYOFFS.includes(x.week));
  schedule[team] = { games: list.length, opponents: list.map((x) => `${x.week}:${x.opp}`), ros: {}, playoffs: {} };
  for (const pos of POS) { schedule[team].ros[pos] = avg(list, pos); schedule[team].playoffs[pos] = avg(po, pos); }
}
// rank 1 = easiest remaining schedule at that position
for (const pos of POS) {
  const order = Object.keys(schedule).sort((a, b) => schedule[b].ros[pos] - schedule[a].ros[pos]);
  order.forEach((t, i) => ((schedule[t].rank ||= {})[pos] = i + 1));
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({
  meta: {
    generated: new Date().toISOString(), season: SEASON, weeksPlayed: lastWeek, scoring: "PPR", fantasyPlayoffWeeks: FANTASY_PLAYOFFS,
    source: "nflverse stats_player_week (prior + current season), nflverse/nfldata games.csv (schedule)",
    method: "Defense index = PPR points allowed per game to the position / league average (1.00 = average, >1 = easier). Blend: idx = 1 + shrink*(w*toDate + (1-w)*prior - 1), w = games/(games+K). SOS = mean index of remaining opponents.",
    validation,
  },
  defense, schedule,
}, null, 1));

console.log(`Validation (${validation.pairs.join(", ")}; predict weeks ${SPLIT_WEEK + 1}-18): K=${best.K} shrink=${best.s} mse ${best.mse.toFixed(4)}`);
for (const pos of POS) console.log(" ", pos, JSON.stringify(validation.byPos[pos]));
console.log(`Season ${SEASON}: ${lastWeek} weeks played, ${remaining.length} games left.`);
for (const pos of POS) {
  const o = Object.keys(schedule).sort((a, b) => schedule[a].rank[pos] - schedule[b].rank[pos]);
  console.log(`  ${pos} easiest ROS: ${o.slice(0, 3).map((t) => `${t} ${schedule[t].ros[pos]}`).join(", ")} | hardest: ${o.slice(-3).map((t) => `${t} ${schedule[t].ros[pos]}`).join(", ")}`);
}
console.log(`wrote ${OUT}`);
