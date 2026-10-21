// node test-suggest.js : offline tests for the trade suggester (suggest.js) on a synthetic 6-team league built
// from real market values (data/values.json) and the stats model. No network.
const D = require("./scoring.js"), S = require("./suggest.js");
const values = require("./data/values.json"), stats = require("./data/stats.json");
const ok = (c, m) => { if (!c) { console.error("FAIL", m); process.exitCode = 1; } else console.log("ok  ", m); };

const db = D.buildDB({ values, stats, players: {}, fmt: "1qb_ppr" });
// Six teams, snake draft over the top 150 players; team 0 strong record, team 5 weak, so team types differ.
const N = 6, teams = Array.from({ length: N }, (_, i) => ({ rid: i + 1, owner: "Team " + (i + 1), team: "T" + (i + 1), players: [], taxi: new Set(), reserve: new Set(),
  w: [6, 5, 4, 3, 2, 1][i], l: [1, 2, 3, 4, 5, 6][i], t: 0, pf: 700 - 40 * i, pa: 600 }));
db.list.slice(0, 150).forEach((p, k) => { const r = Math.floor(k / N), i = r % 2 ? N - 1 - (k % N) : k % N; teams[i].players.push(p.id); });
const info = {}; db.list.forEach((p) => (info[p.id] = p));
const ppg = (id) => { const p = info[id]; return p ? (p.st && p.st.projPPG1) || p.market / 6 : 0; };
const weeks = [8, 9, 10, 11, 12, 13];
const schedule = weeks.map((w, k) => { const o = teams.map((t) => t.rid), r = o.slice(1); for (let j = 0; j < k; j++) r.unshift(r.pop()); const a = [o[0]].concat(r);
  return [[a[0], a[5]], [a[1], a[4]], [a[2], a[3]]]; });
const picks = []; [2027, 2028].forEach((y) => [1, 2].forEach((rd) => teams.forEach((t) => picks.push({ season: y, round: rd, orig: t.rid, owner: t.rid }))));
picks.find((p) => p.season === 2027 && p.round === 1 && p.orig === 6).owner = 1; // team 1 holds two 2027 firsts
const L = { name: "Synthetic", numTeams: N, playoffTeams: 4, reseed: true, slots: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, SF: 0 }, teams, schedule, weeks, picks,
  ppg, pinfo: (id) => ({ id, name: info[id] ? info[id].name : id, pos: info[id] && info[id].pos, age: info[id] && info[id].age }) };

const run = (me, them) => S.suggest(db, L, me, them, { n: 2000 });
const res = run(1, 6);
console.log(`types: me ${res.type[1]}, partner ${res.type[6]} | searched ${res.searched}, fair+pre-gain ${res.fair}, simulated ${res.simulated}, ${res.ms} ms`);
res.suggestions.forEach((s, i) => console.log(` ${i + 1}. give ${s.give.map((a) => a.name).join(" + ")} | get ${s.get.map((a) => a.name).join(" + ")}\n    ${s.why}`));

ok(res.suggestions.length > 0 && res.suggestions.length <= S.TOP, `1 to ${S.TOP} suggestions: ${res.suggestions.length}`);
ok(res.suggestions.every((s) => s.market.pct < S.FAIR_MAX), "fairness band: every market gap under 17%");
ok(res.suggestions.every((s) => {
  const m = D.consolidate(s.give.map((a) => a.value)), g = D.consolidate(s.get.map((a) => a.value));
  return Math.abs(Math.abs(g - m) / ((g + m) / 2) - s.market.pct) < 1e-9; }), "fairness gap recomputed from the assets matches");
ok(res.suggestions.every((s) => S.sideGains(s.me.type, s.me.lensGain, s.me.dTitle) && S.sideGains(s.them.type, s.them.lensGain, s.them.dTitle)), "both sides gain by their own lens");
ok(res.suggestions.every((s) => { const k = s.give.concat(s.get).map((a) => a.key); return new Set(k).size === k.length; }), "no duplicate assets inside a trade");
const own = (rid) => new Set(teams.find((t) => t.rid === rid).players);
ok(res.suggestions.every((s) => s.give.every((a) => a.isPick || own(1).has(a.id)) && s.get.every((a) => a.isPick || own(6).has(a.id))), "players come from the right rosters");
ok(res.suggestions.every((s) => s.give.every((a) => !a.isPick || picks.some((p) => a.key === `pick:${p.season}_${p.round}_${p.orig}` && p.owner === 1))
  && s.get.every((a) => !a.isPick || picks.some((p) => a.key === `pick:${p.season}_${p.round}_${p.orig}` && p.owner === 6))), "picks come from the right owners");
ok(res.suggestions.every((s) => s.give.length >= 1 && s.get.length >= 1 && s.give.length <= 3 && s.get.length <= 3 && s.give.length + s.get.length <= 5), "sizes 1-for-1 up to 3-for-2");
const cnt = {}; res.suggestions.forEach((s) => s.give.concat(s.get).forEach((a) => (cnt[a.key] = (cnt[a.key] || 0) + 1)));
ok(Object.values(cnt).every((c) => c <= S.MAX_REPEAT), "no asset in more than 2 suggestions");
const assets1 = S.assetsOf(db, L, 1, {});
ok(assets1.filter((a) => a.isPick && a.name.startsWith("2027 R1")).length === 2 && new Set(assets1.map((a) => a.key)).size === assets1.length, "two picks with the same market entry stay distinct assets");
const again = run(1, 6);
ok(JSON.stringify(again.suggestions.map((s) => s.why)) === JSON.stringify(res.suggestions.map((s) => s.why)), "deterministic: same input, same skeletons");

// sideGains rule edges
ok(S.sideGains("Rebuilder", 0.01, -5) && !S.sideGains("Rebuilder", -0.01, 5), "rebuilder: value only, title odds ignored");
ok(S.sideGains("Contender", -0.05, 0.5) && !S.sideGains("Contender", -0.1, 0.5) && !S.sideGains("Contender", 0.05, -0.5), "contender: title gain with small value cost ok, title loss beyond noise not");

// export: CSV and share link
const csv = S.toCSV({ suggestions: [Object.assign({}, res.suggestions[0], { why: 'has "quotes", commas' })] }, { sources: "a, b", snapshot: "2026-10-21", league: "Synthetic" });
const lines = csv.trim().split("\n");
ok(lines[2].startsWith("rank,side,asset") && lines.length === 3 + res.suggestions[0].give.length + res.suggestions[0].get.length, "CSV: header + one row per asset");
ok(csv.includes('"has ""quotes"", commas"') && lines[0].includes("Skeleton to negotiate from") && lines[1].includes("snapshot 2026-10-21"), "CSV: quoting, wording, snapshot date");
const st = { league: "123456789", me: 3, them: 7 };
ok(JSON.stringify(S.decodeShare("#" + S.encodeShare(st))) === JSON.stringify(st), "share link round-trips");
ok(S.decodeShare("#sug=1&league=abc&me=1&with=2") === null && S.decodeShare("#sug=1&league=1&me=2&with=2") === null && S.decodeShare("") === null, "share link rejects bad state");
