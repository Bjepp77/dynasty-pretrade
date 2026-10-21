// node test.js : runs scoring on real API data (fetched live)
const D = require("./scoring.js"), SOS = require("./data/sos.js");
(async () => {
  const j = (u) => fetch(u).then((r) => r.json());
  const q = "numQbs=1&numTeams=12&ppr=1";
  const [players, dyn, red, s25] = await Promise.all([
    j("https://api.sleeper.app/v1/players/nfl"),
    j(`https://api.fantasycalc.com/values/current?isDynasty=true&${q}`),
    j(`https://api.fantasycalc.com/values/current?isDynasty=false&${q}`),
    j("https://api.sleeper.app/v1/stats/nfl/regular/2025"),
  ]);
  const db = D.buildDB({ players, dyn, red, stats: s25, statsYear: 2025, sos: SOS });
  console.log("players in db:", db.list.length);
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
})();
