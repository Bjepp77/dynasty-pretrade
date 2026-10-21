// node test.js : runs scoring on real API data (fetched live)
const D = require("./scoring.js"), SOS = require("./data/sos.js");
(async () => {
  const j = (u) => fetch(u).then((r) => r.json());
  // QBS=2 PPR=0.5 node test.js ... to test other league formats
  const ppr = +(process.env.PPR || 1), q = `numQbs=${process.env.QBS || 1}&numTeams=12&ppr=${ppr}`;
  const [players, dyn, red, s25] = await Promise.all([
    j("https://api.sleeper.app/v1/players/nfl"),
    j(`https://api.fantasycalc.com/values/current?isDynasty=true&${q}`),
    j(`https://api.fantasycalc.com/values/current?isDynasty=false&${q}`),
    j("https://api.sleeper.app/v1/stats/nfl/regular/2025"),
  ]);
  const db = D.buildDB({ players, dyn, red, stats: s25, statsYear: 2025, sos: SOS, ppr });
  console.log(q, "players in db:", db.list.length, "picks:", db.picks.length, "from", db.pickSource);
  const core = db.list.map((p) => D.analyze(db, p.id)).filter((r) => r.archetype === "Core");
  console.log("Core assets:", core.map((r) => `${r.p.name} ${r.winNow.toFixed(0)}/${r.longTerm.toFixed(0)}`).join(", ") || "none");
  const names = process.argv.slice(2).length ? process.argv.slice(2) : ["Jaxon Smith-Njigba", "Derrick Henry", "Josh Allen"];
  for (const n of names) {
    const p = db.list.find((x) => x.name.toLowerCase().includes(n.toLowerCase()));
    if (!p) { console.log("not found", n); continue; }
    const r = D.analyze(db, p.id);
    const f = (o) => Object.entries(o).map(([k, v]) => `${k}=${v.toFixed(0)}`).join(" ");
    console.log(`\n${p.name} (${p.pos} ${p.team}, age ${p.age}) dyn=${p.dynValue} red=${p.redValue} ppg=${p.ppg.toFixed(1)} gp=${p.gp}`);
    console.log(" scores:", f(r.scores), `| WinNow=${r.winNow.toFixed(0)} LongTerm=${r.longTerm.toFixed(0)} cliffIn=${r.yearsToCliff}`);
    console.log(` => ${r.archetype} / ${r.tag}\n ${r.explanation}`);
  }
  const t = D.analyzeTrade(db, [db.list.find((x) => x.name.includes("Derrick Henry")).id], [db.list.find((x) => x.name.includes("Jaxon Smith-Njigba")).id]);
  console.log("\nTRADE Henry (A) vs JSN (B):", JSON.stringify(Object.fromEntries(Object.entries(t.verdict).map(([k, v]) => [k, v.winner]))), "raw value winner:", t.valueWinner, Math.round(t.A.total), Math.round(t.B.total));
  const pk = db.picks.find((k) => k.name === "2027 1st (Mid)") || db.picks[0];
  const tp = D.analyzeTrade(db, [db.list.find((x) => x.name.includes("Derrick Henry")).id], [pk.id]);
  console.log(`TRADE Henry (A) vs ${pk.name} ${pk.dynValue} (B):`, JSON.stringify(Object.fromEntries(Object.entries(tp.verdict).map(([k, v]) => [k, v.winner]))));
  const fb = D.buildDB({ players, dyn: dyn.filter((r) => r.player.position !== "PICK"), red, stats: s25, statsYear: 2025, sos: SOS, ppr });
  console.log("fallback picks:", fb.picks.length, fb.pickSource);
})();
