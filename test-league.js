// node test-league.js [leagueId] : live Sleeper league import, power table, title odds, chips, sample trade.
// LEAGUE=<id> ME=<display_name> N=<sims> node test-league.js
const League = require("./league.js"), Sim = require("./sim.js");
const ok = (c, m) => { if (!c) { console.error("FAIL", m); process.exitCode = 1; } else console.log("ok  ", m); };
const pct = (x) => (100 * x).toFixed(1).padStart(5) + "%";
(async () => {
  const id = process.argv[2] || process.env.LEAGUE || "", N = +(process.env.N || 10000);
  const all = await fetch("https://api.sleeper.app/v1/players/nfl").then((r) => r.json());
  const players = {}; Object.entries(all).forEach(([k, p]) => { if (p.position) players[k] = { name: p.full_name || [p.first_name, p.last_name].join(" "), pos: p.position, age: p.age, team: p.team, injury: p.injury_status }; });
  const L = await League.load(id, { players });
  console.log(`${L.name} ${L.season} wk ${L.week} | ${L.numTeams} teams, ${L.playoffTeams} playoff, start wk ${L.playoffStart}, remaining wk ${L.fromWeek}-${L.lastWeek}, reseed ${L.reseed}`);
  console.log("slots", JSON.stringify(L.slots), "format", JSON.stringify(L.format));
  ok(L.teams.length === L.numTeams, "all rosters loaded");
  ok(L.schedule.length === L.weeks.length && L.schedule.every((g) => g.length === L.numTeams / 2), "every remaining week has a full set of matchups");
  ok(L.picks.length === 3 * (L.settings.draft_rounds || 4) * L.numTeams, "pick table complete: " + L.picks.length);
  ok(L.picks.every((p) => L.teams.some((t) => t.rid === p.owner)), "every pick has a valid owner");
  const me = L.teams.find((t) => t.owner === (process.env.ME || "BJepp")) || L.teams[0];
  console.log("My team:", me.owner, "roster", me.rid, `(${me.w}-${me.l})`);

  // scoring spot check: a hand-computed line
  ok(Math.abs(League.scoreStats({ pass_yd: 250, pass_td: 2, rec: 5, rec_yd: 50, bonus_rec_te: 5 }, L.scoring) - (250 * L.scoring.pass_td * 0 + 250 * L.scoring.pass_yd + 2 * L.scoring.pass_td + 5 * L.scoring.rec + 50 * L.scoring.rec_yd + 5 * (L.scoring.bonus_rec_te || 0))) < 1e-9, "scoreStats = sum(stat x weight)");

  const pw = League.power(L);
  console.log("\nPOWER (best-lineup projected points per week; gap to last playoff seed by PPG)");
  pw.forEach((r) => console.log(`${String(r.rank).padStart(2)} ${r.owner.padEnd(20)} ${r.ppg.toFixed(1).padStart(6)}  gap ${(r.gap >= 0 ? "+" : "") + r.gap.toFixed(1).padStart(5)}  ${r.w}-${r.l}`));
  ok(pw[0].ppg > 80 && pw[0].ppg < 220, "top team PPG in a sane range: " + pw[0].ppg.toFixed(1));

  const input = League.toSimInput(L);
  const base = Sim.run(input, { n: N, seed: 7 });
  const rows = base.teams.map((t) => ({ ...t, owner: L.teams.find((x) => x.rid === t.id).owner })).sort((a, b) => b.title - a.title);
  console.log(`\nSIM ${N} runs in ${base.ms} ms`);
  rows.forEach((r) => console.log(`${r.owner.padEnd(20)} playoff ${pct(r.playoff)}  bye ${pct(r.bye)}  title ${pct(r.title)}`));
  const sum = (k) => base.teams.reduce((s, t) => s + t[k], 0);
  ok(Math.abs(sum("title") - 1) < 1e-9, "title odds sum to 100%");
  ok(Math.abs(sum("playoff") - L.playoffTeams) < 1e-9, "playoff odds sum to " + L.playoffTeams);
  ok(base.ms < 3000, "10k sims under 3 s: " + base.ms + " ms");
  const top = rows[0].title;
  console.log(`CALIBRATION: top team ${rows[0].owner} title odds ${pct(top)} (target 27-37%) -> ${top >= 0.27 && top <= 0.37 ? "within band" : "OUTSIDE band"}`);

  const ch = League.chips(L, me.rid);
  console.log(`\nCHIPS for ${me.owner}: lineup ${ch.base.toFixed(1)} PPG`);
  ch.rows.slice(0, 8).forEach((r) => console.log(`  ${r.name.padEnd(22)} ${r.pos} ${r.ppg.toFixed(1).padStart(5)} PPG  lost if removed ${r.loss.toFixed(1)}`));
  console.log("  free chips:", ch.rows.filter((r) => r.free).map((r) => r.name).slice(0, 6).join(", "));
  const mine = L.picks.filter((p) => p.owner === me.rid), gone = L.picks.filter((p) => p.orig === me.rid && p.owner !== me.rid);
  console.log(`PICKS: own ${mine.length} (${mine.filter((p) => p.orig !== me.rid).length} from others), traded away ${gone.length}`);

  // sample trade: my 2nd most valuable starter for the best same-position player on the top power team
  const give = ch.rows.filter((r) => r.pos !== "QB")[1], topTeam = L.teams.find((t) => t.rid === (pw[0].rid !== me.rid ? pw[0].rid : pw[1].rid));
  const tgt = topTeam.players.map((x) => ({ id: x, ...L.pinfo(x), ppg: L.ppg(x) })).filter((x) => x.pos === give.pos).sort((a, b) => b.ppg - a.ppg)[0];
  const tr = League.tradeOverride(L, me.rid, [give.id], [tgt.id]);
  const after = Sim.run(League.toSimInput(L, tr.override), { n: N, seed: 7 });
  const iB = base.teams.findIndex((t) => t.id === me.rid), cpI = base.teams.findIndex((t) => t.id === tr.counterparty);
  console.log(`\nSAMPLE TRADE: give ${give.name} (${give.ppg.toFixed(1)}) get ${tgt.name} (${tgt.ppg.toFixed(1)}) from ${topTeam.owner}`);
  console.log(`  me: title ${pct(base.teams[iB].title)} -> ${pct(after.teams[iB].title)}, playoff ${pct(base.teams[iB].playoff)} -> ${pct(after.teams[iB].playoff)}`);
  console.log(`  them: title ${pct(base.teams[cpI].title)} -> ${pct(after.teams[cpI].title)}`);
  console.log(" ", League.titleVerdict(base.teams[iB].title, after.teams[iB].title, L.numTeams, true).text);
  const noop = Sim.run(League.toSimInput(L, League.tradeOverride(L, me.rid, [], []).override), { n: N, seed: 7 });
  ok(Math.abs(noop.teams[iB].title - base.teams[iB].title) < 1e-9, "no-op trade reproduces baseline exactly (common random numbers)");
  const v = (b, a, c) => League.titleVerdict(b, a, 12, c).zone;
  ok(v(0.05, 0.10, true) === "above" && v(0.05, 0.09, true) === "gray" && v(0.05, 0.07, true) === "gray" && v(0.05, 0.06, true) === "below", "floor 8.3% with +/-1.5 gray zone");
})();
