// node test.js [names...] : overall scores from data/values.json + data/stats.json, live Sleeper players
// QBS=2 PPR=0.5 node test.js ... to test other league formats
const D = require("./scoring.js"), values = require("./data/values.json"), stats = require("./data/stats.json");
(async () => {
  const players = await fetch("https://api.sleeper.app/v1/players/nfl").then((r) => r.json());
  const fmt = D.fmtKey(+(process.env.QBS || 1), +(process.env.PPR || 1));
  const db = D.buildDB({ values, stats, players, fmt });
  const withStats = db.list.filter((p) => p.st).length;
  console.log(fmt, "players:", db.list.length, "with stats:", withStats, "picks:", db.picks.length);
  const f = (o) => D.TYPES.map((k) => `${k[0]}${k[2]}=${o[k].toFixed(0)}`).join(" ");
  const all = db.list.map((p) => D.analyze(db, p.id));
  console.log("Core assets:", all.filter((r) => r.archetype === "Core").map((r) => r.p.name).join(", ") || "none");
  for (const k of D.TYPES) console.log(`Top 5 ${k}:`, [...all].sort((a, b) => b.overall[k] - a.overall[k]).slice(0, 5).map((r) => `${r.p.name} ${r.overall[k].toFixed(0)}`).join(", "));
  const names = process.argv.slice(2).length ? process.argv.slice(2) : ["Jaxon Smith-Njigba", "Derrick Henry", "Josh Allen"];
  for (const n of names) {
    const p = db.list.find((x) => x.name.toLowerCase().includes(n.toLowerCase()));
    if (!p) { console.log("not found", n); continue; }
    const r = D.analyze(db, p.id);
    console.log(`\n${p.name} (${p.pos} ${p.team}, age ${p.age}) market=${p.market.toFixed(0)} now=${r.now?.toFixed(0)} long=${r.long?.toFixed(0)} | ${f(r.overall)}`);
    console.log(` => ${r.archetype} / ${r.tag}\n ${r.explanation}`);
  }
  const id = (n) => db.list.find((x) => x.name.includes(n)).id;
  const pk = db.picks.find((k) => k.id === "2027_1_mid") || db.picks[0];
  for (const [a, b, l] of [[[id("Derrick Henry")], [id("Jaxon Smith-Njigba")], "Henry vs JSN"], [[id("Derrick Henry")], [pk.id], "Henry vs " + pk.name]]) {
    const t = D.analyzeTrade(db, a, b);
    console.log(`TRADE ${l}:`, JSON.stringify(Object.fromEntries(Object.entries(t.verdict).map(([k, v]) => [k, v.band + (v.winner === "Even" ? "" : " " + v.winner)]))), Math.round(t.A.total), Math.round(t.B.total));
  }

  // --- assertions: consolidation, bands, trend ---
  const ok = (c, m) => { if (!c) { console.error("FAIL", m); process.exitCode = 1; } else console.log("ok  ", m); };
  ok(Math.abs(D.consolidate([5000]) - 5000) < 1e-6, "single asset is not discounted");
  ok(D.consolidate([3000, 3000, 3000]) < 9000 && D.consolidate([3000, 3000, 3000]) > 3000, "package worth less than its sum, more than its best piece");
  ok(D.bandOf(0.084) === "Fair" && D.bandOf(0.085) === "Slight edge" && D.bandOf(0.169) === "Slight edge" && D.bandOf(0.17) === "Clear win" && D.bandOf(0.424) === "Clear win" && D.bandOf(0.425) === "Lopsided", "band edges 8.5 / 17 / 42.5 %");
  ok(D.trendHint({ trend: 12, value: 3000 }) === "Rising: sell high if moving" && D.trendHint({ trend: -10, value: 3000 }) === "Falling: buy the dip" && D.trendHint({ trend: 9.9, value: 3000 }) === null && D.trendHint({ trend: 40, value: 200 }) === null, "trend hints at +/-10%, ignored on cheap assets");
  // 3-for-1: star vs the three assets whose plain sum is closest to the star's value (from rank 8-40 so the pieces are real starters)
  const star = db.list[4], pool = db.list.slice(5, 80).filter((p) => p.value > star.value * 0.15 && p.value < star.value * 0.5);
  let best = null;
  for (let i = 0; i < pool.length; i++) for (let j = i + 1; j < pool.length; j++) for (let k = j + 1; k < pool.length; k++) {
    const s = pool[i].value + pool[j].value + pool[k].value, e = Math.abs(s - star.value);
    if (!best || e < best.e) best = { e, ids: [pool[i].id, pool[j].id, pool[k].id] };
  }
  const t3 = D.analyzeTrade(db, [star.id], best.ids);
  console.log(`\n3-for-1: ${star.name} (${Math.round(star.value)}) vs ${best.ids.map((x) => db.byId[x].name + " " + Math.round(db.byId[x].value)).join(" + ")}`);
  console.log(` raw:      A ${Math.round(t3.A.total)}  B ${Math.round(t3.B.total)}  (plain sums: ${t3.A.total === t3.B.total ? "even" : "B +" + (100 * (t3.B.total - t3.A.total) / t3.A.total).toFixed(1) + "% vs A"})`);
  console.log(` adjusted: A ${Math.round(t3.A.cons)}  B ${Math.round(t3.B.cons)}  | market: ${t3.market.band} ${(100 * t3.market.pct).toFixed(1)}%, Side ${t3.market.winner}`);
  for (const k of D.TYPES) console.log(`  ${k}: raw A ${Math.round(t3.A.rawAdj[k])} B ${Math.round(t3.B.rawAdj[k])} -> adjusted A ${Math.round(t3.A.adj[k])} B ${Math.round(t3.B.adj[k])} => ${t3.verdict[k].band} ${(100 * t3.verdict[k].pct).toFixed(1)}% Side ${t3.verdict[k].winner}`);
  ok(t3.B.cons < t3.B.total && Math.abs(t3.A.cons - t3.A.total) < 1e-6, "3-for-1: package side discounted, single asset side not");
  ok(t3.market.winner === "A" && t3.A.total > 0 && Math.abs(t3.B.total - t3.A.total) / t3.A.total < 0.06, "3-for-1 that looks even on plain sums now favors the star");

  const tr = db.list.filter((p) => p.trend != null);
  const ar = db.list.map((p) => ({ p, h: D.trendHint(p) })).filter((x) => x.h);
  console.log(`\nTrend30: ${tr.length}/${db.list.length} players, ${db.picks.filter((p) => p.trend != null).length}/${db.picks.length} picks; hints on ${ar.length} (${ar.filter((x) => x.h[0] === "R").length} rising, ${ar.filter((x) => x.h[0] === "F").length} falling)`);
  console.log(" top risers:", ar.filter((x) => x.h[0] === "R").sort((a, b) => b.p.trend - a.p.trend).slice(0, 3).map((x) => `${x.p.name} +${x.p.trend}%`).join(", "));
  console.log(" top fallers:", ar.filter((x) => x.h[0] === "F").sort((a, b) => a.p.trend - b.p.trend).slice(0, 3).map((x) => `${x.p.name} ${x.p.trend}%`).join(", "));
})();
