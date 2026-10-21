#!/usr/bin/env node
// Aggregate dynasty market value from public sources into data/values.json.
// Usage: node scripts/fetch-values.mjs
// Model and source decisions: docs/market-model.md
// One fetch per source per run (FantasyCalc: one per format). No accounts, no keys, no retries.
import { writeFile, mkdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "data", "values.json");
const UA = "dynasty-pretrade/0.1 (personal hobby project; one fetch per source per run)";
const SEASON = new Date().getFullYear();
const GH_RAW = "https://raw.githubusercontent.com/dynastyprocess/data/master/files/";
const MIN_PLAYERS = 300; // per format; a healthy run yields 500+
const MIN_PICKS = 20; // per format; trade mode has no other pick source (a healthy run yields 53)
const MIN_SOURCES = 3; // of 4 (fc and dd are also individually required)
const SKILL = new Set(["QB", "RB", "WR", "TE"]);

// ---------- config ----------
const FORMATS = [];
for (const [qbKey, numQbs] of [["1qb", 1], ["sf", 2]])
  for (const [pKey, ppr] of [["ppr", 1], ["half", 0.5], ["std", 0]]) FORMATS.push({ key: `${qbKey}_${pKey}`, numQbs, ppr, qbKey, pKey });

// Base weights before the coverage factor. FC and DD are separate trade markets. DP is derived from
// FantasyPros ECR (one expert-consensus voice), so it gets a lower weight. Sleeper ADP is a coarse
// draft-slot signal. FantasyPros itself is excluded (ToS), so DP is the only ECR voice: no double count.
const BASE_WEIGHT = { fc: 1.0, dd: 1.0, dp: 0.75, adp: 0.6 };
const TRIM = 0.2; // weighted trim: drop 20% of total weight from each tail
const SCORE_POWER = 0.5; // score = 100 * (value / top value) ^ 0.5, value on the FantasyCalc scale

// Excluded after reading their terms (checked 2026-10-21). Fetching them is not attempted.
const EXCLUDED = [
  { name: "keeptradecut", tos: "Excluded. https://keeptradecut.com/terms-and-conditions: \"Any form of automated data collection, including but not limited to: Web scraping\" is prohibited." },
  { name: "fantasypros", tos: "Excluded. https://www.fantasypros.com/about/legal/: \"you may not copy, reproduce, modify, republish, upload, post, transmit, or distribute any documents\" without written permission; no scraping carve-out. robots.txt Crawl-delay 5." },
];

// Fallback FantasyCalc rank->value anchors (2026-10-21), used only if no FantasyCalc format loads.
const FC_ANCHORS = {
  1: [[1, 11416], [5, 7906], [12, 6067], [24, 4513], [36, 3703], [60, 2919], [100, 1959], [150, 1361], [200, 1042], [300, 305], [400, 31], [420, 1]],
  2: [[1, 10950], [5, 8333], [12, 6912], [24, 5527], [36, 4420], [60, 3413], [100, 2245], [150, 1541], [200, 1203], [300, 335], [400, 34], [420, 1]],
};

// ---------- helpers ----------
const log = (...a) => console.error(...a);
async function get(url, kind = "json") {
  const r = await fetch(url, { headers: { "user-agent": UA, accept: kind === "json" ? "application/json" : "text/plain" }, signal: AbortSignal.timeout(45000) });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return kind === "json" ? r.json() : r.text();
}
// Percent change over 30 days from an absolute change (FantasyCalc trend30Day) or a prior value (Dynasty Daddy).
const pctChange = (now, before) => (before > 0 && now != null ? Math.max(-100, Math.min(300, ((now - before) / before) * 100)) : null);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseCsv(text) {
  const rows = []; let row = [], f = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(f); f = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(f); f = ""; if (row.length > 1 || row[0] !== "") rows.push(row); row = []; }
    else f += c;
  }
  if (f !== "" || row.length) { row.push(f); rows.push(row); }
  const head = rows.shift();
  return rows.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] === "NA" ? null : r[i]])));
}
const mergeName = (s) => String(s || "").toLowerCase().replace(/[^a-z ]/g, "").replace(/\s+(jr|sr|ii|iii|iv)$/, "").trim();

// Pick names -> common id like 2027_1_mid (tier) or 2027_1 (generic). Returns null for non-pick shapes.
const ORD = { st: 1, nd: 2, rd: 3, th: 4 };
function pickId(name) {
  const m = /^(\d{4})\s+(?:(early|mid|late)\s+)?(\d)(st|nd|rd|th)(?:\s+\((early|mid|late)\))?$/i.exec(String(name).trim());
  if (!m) return null;
  const tier = (m[2] || m[5] || "").toLowerCase();
  return `${m[1]}_${m[3]}${tier ? "_" + tier : ""}`;
}
function pickName(id) {
  const [y, r, t] = id.split("_");
  const sfx = { 1: "st", 2: "nd", 3: "rd", 4: "th" }[r];
  return `${y} ${r}${sfx}${t ? ` (${t[0].toUpperCase()}${t.slice(1)})` : ""}`;
}

// ---------- source adapters: each returns { rows: Map(fmtKey -> [{id,name,pos,value}]) , stats } ----------
// value: higher = more valuable. id: sleeper id string or pick id. Every adapter reports rows/matched.

async function srcFantasyCalc() {
  const byFmt = new Map(); let rows = 0, matched = 0, fails = 0, lastErr = null;
  for (const f of FORMATS) {
    try {
      const j = await get(`https://api.fantasycalc.com/values/current?isDynasty=true&numQbs=${f.numQbs}&numTeams=12&ppr=${f.ppr}`);
      const out = [];
      for (const r of j) {
        const p = r.player; if (!p) continue;
        if (p.position === "PICK") {
          const id = pickId(p.name); if (id) out.push({ id, name: pickName(id), pos: "PICK", value: r.value, trend: pctChange(r.value, r.value - (r.trend30Day || 0)) });
          continue;
        }
        if (!SKILL.has(p.position)) continue;
        rows++;
        if (!p.sleeperId) continue;
        matched++;
        out.push({ id: String(p.sleeperId), name: p.name, pos: p.position, value: r.value, trend: pctChange(r.value, r.value - (r.trend30Day || 0)) });
      }
      byFmt.set(f.key, out);
    } catch (e) { fails++; lastErr = e.message; log("fantasycalc", f.key, e.message); }
    await sleep(500);
  }
  if (!byFmt.size) throw new Error(lastErr || "no formats");
  return { byFmt, rows, matched, note: fails ? `${fails} of ${FORMATS.length} formats failed` : "" };
}

async function srcDynastyDaddy() {
  let j;
  try { j = await get("https://dynasty-daddy.com/api/v1/player/all/today"); }
  catch (e) { log("dynasty-daddy primary failed, trying documented endpoint:", e.message); j = await get("https://api.dynasty-daddy.com/api/v1/values/dynasty"); }
  const mk = (sf) => {
    const out = []; let rows = 0, matched = 0;
    for (const r of j) {
      const v = sf ? r.sf_trade_value : r.trade_value;
      if (v == null) continue;
      const tr = pctChange(v, Number(sf ? r.last_month_value_sf : r.last_month_value) || 0);
      if (r.position === "PI") { const id = pickId(r.full_name); if (id) out.push({ id, name: pickName(id), pos: "PICK", value: v, trend: tr }); continue; }
      if (!SKILL.has(r.position)) continue;
      rows++;
      if (!r.sleeper_id) continue;
      matched++;
      out.push({ id: String(r.sleeper_id), name: r.full_name || r.name_id, pos: r.position, value: v, trend: tr });
    }
    return { out, rows, matched };
  };
  const a = mk(false), b = mk(true);
  const byFmt = new Map();
  for (const f of FORMATS) byFmt.set(f.key, f.numQbs === 1 ? a.out : b.out);
  return { byFmt, rows: a.rows, matched: a.matched };
}

async function srcDynastyProcess() {
  const [valuesCsv, idsCsv] = await Promise.all([get(GH_RAW + "values.csv", "text"), get(GH_RAW + "db_playerids.csv", "text")]);
  const ids = parseCsv(idsCsv);
  const fpToSleeper = new Map(), nameToSleeper = new Map();
  for (const r of ids) {
    if (!r.sleeper_id) continue;
    if (r.fantasypros_id) fpToSleeper.set(r.fantasypros_id, r.sleeper_id);
    if (SKILL.has(r.position)) nameToSleeper.set(mergeName(r.name) + "|" + r.position, r.sleeper_id);
  }
  const vals = parseCsv(valuesCsv);
  const mk = (col) => {
    const out = []; let rows = 0, matched = 0;
    for (const r of vals) {
      const v = Number(r[col]); if (!(v > 0)) continue;
      if (r.pos === "PICK") { const id = pickId(r.player); if (id) out.push({ id, name: pickName(id), pos: "PICK", value: v }); continue; }
      if (!SKILL.has(r.pos)) continue;
      rows++;
      const sid = (r.fp_id && fpToSleeper.get(r.fp_id)) || nameToSleeper.get(mergeName(r.player) + "|" + r.pos);
      if (!sid) continue;
      matched++;
      out.push({ id: String(sid), name: r.player, pos: r.pos, value: v });
    }
    return { out, rows, matched };
  };
  const a = mk("value_1qb"), b = mk("value_2qb");
  const byFmt = new Map();
  for (const f of FORMATS) byFmt.set(f.key, f.numQbs === 1 ? a.out : b.out);
  return { byFmt, rows: a.rows, matched: a.matched };
}

// Sleeper projections carry dynasty ADP in adp_dynasty_* keys (lower = drafted earlier; 999 = none).
// The brief named adp_dd_ppr; that key does not exist in the response, so only the adp_dynasty_* keys are used.
async function srcSleeperAdp() {
  const q = ["QB", "RB", "WR", "TE"].map((p) => `position[]=${p}`).join("&");
  const j = await get(`https://api.sleeper.com/projections/nfl/${SEASON}?season_type=regular&${q}&order_by=adp_dynasty_ppr`);
  const keyFor = (f) => (f.numQbs === 2 ? "adp_dynasty_2qb" : { 1: "adp_dynasty_ppr", 0.5: "adp_dynasty_half_ppr", 0: "adp_dynasty_std" }[f.ppr]);
  const byFmt = new Map(); let rows = 0, matched = 0;
  for (const f of FORMATS) {
    const k = keyFor(f), out = [];
    for (const r of j) {
      const s = r.stats || {}, p = r.player || {};
      if (!SKILL.has(p.position) || !(s[k] < 998)) continue;
      out.push({ id: String(r.player_id), name: `${p.first_name} ${p.last_name}`, pos: p.position, value: -s[k] });
    }
    byFmt.set(f.key, out);
    if (f.key === "1qb_ppr") { rows = out.length; matched = out.length; }
  }
  if (!rows) throw new Error("no dynasty ADP in response");
  return { byFmt, rows, matched };
}

// ---------- model ----------
function refCurve(values) { return values.slice().sort((a, b) => b - a); }
function curveAt(ref, rank) {
  if (!ref.length) return 0;
  if (rank <= 1) return ref[0];
  if (rank > ref.length) return 0; // deeper than FantasyCalc prices anyone: no value
  if (rank === ref.length) return ref[ref.length - 1];
  const i = Math.floor(rank - 1), t = rank - 1 - i;
  return ref[i] + (ref[i + 1] - ref[i]) * t;
}
function anchorsToCurve(a) { // piecewise-linear expand of [rank,value] anchors
  const out = [];
  for (let r = 1; r <= a[a.length - 1][0]; r++) {
    let k = 1; while (k < a.length - 1 && a[k][0] < r) k++;
    const [r0, v0] = a[k - 1], [r1, v1] = a[k];
    out.push(v0 + ((v1 - v0) * (r - r0)) / (r1 - r0));
  }
  return out;
}
// Average-rank (ties share the mean rank), 1 = best.
function ranks(entries) {
  const s = entries.slice().sort((a, b) => b.value - a.value), m = new Map();
  for (let i = 0; i < s.length;) {
    let j = i; while (j < s.length && s[j].value === s[i].value) j++;
    const avg = (i + 1 + j) / 2;
    for (let k = i; k < j; k++) m.set(s[k].id, avg);
    i = j;
  }
  return m;
}
function trimmedMean(items, key) { // items: {x(sort key), w, [key]}; weighted trim on both tails
  const s = items.slice().sort((a, b) => a.x - b.x);
  const W = s.reduce((t, i) => t + i.w, 0), cut = TRIM * W;
  let lo = cut, hi = cut, num = 0, den = 0;
  const kept = s.map((i) => ({ ...i, kw: i.w }));
  for (let i = 0; i < kept.length && lo > 0; i++) { const d = Math.min(lo, kept[i].kw); kept[i].kw -= d; lo -= d; }
  for (let i = kept.length - 1; i >= 0 && hi > 0; i--) { const d = Math.min(hi, kept[i].kw); kept[i].kw -= d; hi -= d; }
  for (const i of kept) { num += i.kw * i[key]; den += i.kw; }
  return den > 0 ? num / den : s.reduce((t, i) => t + i[key], 0) / s.length;
}
const r1 = (x) => Math.round(x * 10) / 10;

function aggregate(fmt, srcData, coverage) {
  const fc = srcData.fc && srcData.fc.byFmt.get(fmt.key);
  let refAll, refPlayers;
  if (fc && fc.length) {
    refAll = refCurve(fc.map((e) => e.value));
    refPlayers = refCurve(fc.filter((e) => e.pos !== "PICK").map((e) => e.value));
  } else {
    refAll = anchorsToCurve(FC_ANCHORS[fmt.numQbs]); refPlayers = refAll;
  }
  const top = refAll[0];
  const per = new Map(); // id -> {name,pos,items:[{key,v,score,w,x}]}
  for (const [key, d] of Object.entries(srcData)) {
    const entries = d.byFmt.get(fmt.key);
    if (!entries || !entries.length) continue;
    const hasPicks = entries.some((e) => e.pos === "PICK");
    const rk = key === "fc" ? null : ranks(entries);
    const ref = hasPicks ? refAll : refPlayers;
    const w = BASE_WEIGHT[key] * (coverage[key] ?? 1);
    for (const e of entries) {
      const v = key === "fc" ? e.value : curveAt(ref, rk.get(e.id));
      const score = Math.min(100, 100 * Math.pow(Math.max(v, 0) / top, SCORE_POWER));
      let p = per.get(e.id);
      if (!p) per.set(e.id, (p = { name: e.name, pos: e.pos, items: [], pri: key === "fc" ? 0 : key === "dd" ? 1 : key === "dp" ? 2 : 3 }));
      if (key === "fc" || (key === "dd" && p.pri > 1) || (key === "dp" && p.pri > 2)) { p.name = e.name; p.pos = e.pos; p.pri = key === "fc" ? 0 : key === "dd" ? 1 : 2; }
      p.items.push({ key, v, score, w, x: v });
      if (e.trend != null && Number.isFinite(e.trend)) (p.trends || (p.trends = [])).push(e.trend); // fc and dd only
    }
  }
  const out = {};
  for (const [id, p] of per) {
    const items = p.items;
    const marketScore = trimmedMean(items, "score"), aggValue = trimmedMean(items, "v");
    if (marketScore < 1) continue;
    const sc = items.map((i) => i.score), mean = sc.reduce((a, b) => a + b, 0) / sc.length;
    const spread = sc.length > 1 ? Math.sqrt(sc.reduce((a, b) => a + (b - mean) ** 2, 0) / sc.length) : null;
    out[id] = {
      name: p.name, pos: p.pos, marketScore: r1(marketScore), aggValue: Math.round(aggValue), n: items.length,
      spread: spread == null ? null : r1(spread), by: Object.fromEntries(items.map((i) => [i.key, r1(i.score)])),
      // 30-day change in market value, %: mean of the FantasyCalc and Dynasty Daddy trends that exist; null if neither
      trend30: p.trends && p.trends.length ? r1(p.trends.reduce((a, b) => a + b, 0) / p.trends.length) : null,
    };
  }
  return out; // JSON objects reorder integer-like keys, so no sort here; consumers sort by marketScore
}

// ---------- main ----------
async function main() {
  const adapters = [
    ["fc", "fantasycalc", srcFantasyCalc, "Public JSON API, no terms restriction found (api.fantasycalc.com, used as the existing app does)."],
    ["dd", "dynasty-daddy", srcDynastyDaddy, "No Terms of Use page; the Help Center documents a public no-key API: \"Please cache responses and don't hammer the servers.\" robots.txt allows all."],
    ["dp", "dynastyprocess", srcDynastyProcess, "Open data repository file (files/values.csv, db_playerids.csv). Derived from FantasyPros ECR, so weighted below the trade markets."],
    ["adp", "sleeper-adp", srcSleeperAdp, "Sleeper public projections endpoint, adp_dynasty_* keys (real dynasty ADP). adp_dd_ppr from the brief does not exist in the response."],
  ];
  const srcData = {}, sources = [];
  for (const [key, name, fn, tos] of adapters) {
    try {
      const d = await fn();
      srcData[key] = d;
      const cnt = Math.max(...[...d.byFmt.values()].map((a) => a.length));
      sources.push({ name, ok: true, count: cnt, rows: d.rows, matched: d.matched, matchRate: d.rows ? +(d.matched / d.rows).toFixed(3) : null, tos, ...(d.note ? { note: d.note } : {}) });
      log("ok", name, cnt, d.note || "");
    } catch (e) {
      sources.push({ name, ok: false, count: 0, tos, error: e.message });
      log("FAILED", name, e.message);
    }
  }
  for (const x of EXCLUDED) sources.push({ name: x.name, ok: false, count: 0, tos: x.tos, excluded: true });

  // coverage = share of FantasyCalc's skill players (1QB PPR) that the source also prices
  const fcSet = new Set((srcData.fc ? srcData.fc.byFmt.get("1qb_ppr") || [] : []).filter((e) => e.pos !== "PICK").map((e) => e.id));
  const coverage = {};
  for (const [key, d] of Object.entries(srcData)) {
    if (key === "fc" || !fcSet.size) { coverage[key] = 1; continue; }
    const have = new Set(d.byFmt.get("1qb_ppr").map((e) => e.id));
    let hit = 0; for (const id of fcSet) if (have.has(id)) hit++;
    coverage[key] = hit / fcSet.size;
  }
  const formats = {};
  for (const f of FORMATS) formats[f.key] = aggregate(f, srcData, coverage);

  const doc = {
    generated: new Date().toISOString(),
    model: { score: "100 * (value on FantasyCalc scale / top value) ^ 0.5", transform: "per-source rank-match to the same-format FantasyCalc value curve (FantasyCalc itself uses raw values)", baseWeights: BASE_WEIGHT, coverage: Object.fromEntries(Object.entries(coverage).map(([k, v]) => [k, +v.toFixed(3)])), trim: TRIM, spread: "population stdev of per-source scores" },
    sources, formats,
  };
  // Unattended-run guard: never overwrite the last good snapshot with a degraded one.
  const problems = [];
  for (const k of ["fc", "dd"]) if (!srcData[k]) problems.push(`required source ${k} failed`);
  if (srcData.fc && srcData.fc.note) problems.push(`fantasycalc partial: ${srcData.fc.note}`);
  const okCount = Object.keys(srcData).length;
  if (okCount < MIN_SOURCES) problems.push(`only ${okCount} of ${adapters.length} sources returned data (need ${MIN_SOURCES})`);
  for (const [k, v] of Object.entries(formats)) { const n = Object.keys(v).length; if (n < MIN_PLAYERS) problems.push(`format ${k} has ${n} entries (need ${MIN_PLAYERS})`);
    const np = Object.values(v).filter((e) => e.pos === "PICK").length; if (np < MIN_PICKS) problems.push(`format ${k} has ${np} draft picks (need ${MIN_PICKS})`); }
  if (problems.length) { console.error("REFUSING to write values.json (old file kept):\n - " + problems.join("\n - ")); process.exit(1); }
  await mkdir(dirname(OUT), { recursive: true });
  const tmp = OUT + ".tmp";
  await writeFile(tmp, JSON.stringify(doc) + "\n");
  await rename(tmp, OUT); // atomic replace
  log("wrote", OUT, Object.fromEntries(Object.entries(formats).map(([k, v]) => [k, Object.keys(v).length])));
}
main().catch((e) => { console.error(e); process.exit(1); });
