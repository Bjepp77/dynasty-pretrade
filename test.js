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
    console.log(`TRADE ${l}:`, JSON.stringify(Object.fromEntries(Object.entries(t.verdict).map(([k, v]) => [k, v.winner]))), Math.round(t.A.total), Math.round(t.B.total));
  }
})();
