const $ = (s) => document.querySelector(s);
const SET = Object.assign({ qbs: 1, ppr: 1 }, (() => { try { return JSON.parse(localStorage.getItem("dpt_settings")) || {}; } catch (e) { return {}; } })());
const q = () => `numQbs=${SET.qbs}&numTeams=12&ppr=${SET.ppr}`;
let DB = null, sideA = [], sideB = [];

async function j(u) { const r = await fetch(u); if (!r.ok) throw new Error(u + " " + r.status); return r.json(); }
const cget = (k) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch (e) { return null; } };
const cset = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };

let VALUES = null, STATS = null, PLAYERS = null;
async function load() {
  const day = new Date().toISOString().slice(0, 10), bkey = "dpt_base_v4_" + day;
  try { Object.keys(localStorage).forEach((k) => { if (k.startsWith("dpt_") && k !== "dpt_settings" && k !== "dpt_league" && !k.includes(day)) localStorage.removeItem(k); }); } catch (e) {}
  // values.json (aggregate market) and stats.json (stats model) are snapshots built by scripts/
  if (!VALUES) [VALUES, STATS] = await Promise.all([j("data/values.json"), j("data/stats.json")]);
  // Sleeper players: live team, injury and depth chart (slimmed before caching; full file is ~14MB)
  let players = cget(bkey);
  if (!players) {
    const all = await j("https://api.sleeper.app/v1/players/nfl");
    players = {};
    Object.entries(all).forEach(([id, p]) => {
      if (p.team && ["QB", "RB", "WR", "TE"].includes(p.position)) players[id] = { name: p.full_name || [p.first_name, p.last_name].filter(Boolean).join(" "), pos: p.position, team: p.team, age: p.age, years_exp: p.years_exp, injury_status: p.injury_status, depth_chart_order: p.depth_chart_order };
    });
    cset(bkey, players);
  }
  PLAYERS = players;
  DB = DPT.buildDB({ values: VALUES, stats: STATS, players, fmt: DPT.fmtKey(SET.qbs, SET.ppr) });
  sideA = sideA.filter((id) => DB.byId[id]); sideB = sideB.filter((id) => DB.byId[id]);
  const fmt = `${SET.qbs === 2 ? "Superflex" : "1QB"}, ${{ 1: "PPR", 0.5: "half PPR", 0: "standard" }[SET.ppr]}`;
  const used = DB.sources.filter((x) => x.ok).map((x) => x.name).join(", ");
  $("#status").textContent = `${DB.list.length} players + ${DB.picks.length} picks (${fmt}, 12 teams). Market values from ${used}, snapshot ${DB.generated.slice(0, 10)}. Stats model: ${DB.statsMeta.featureSeason} season, PPR.`;
}

function ac(input, box, onPick, withPicks) {
  input.addEventListener("input", () => {
    const t = input.value.trim().toLowerCase(); box.innerHTML = "";
    if (!DB || t.length < 2) return;
    (withPicks ? DB.list.concat(DB.picks) : DB.list).filter((p) => p.name.toLowerCase().includes(t)).slice(0, 8).forEach((p) => {
      const d = document.createElement("div");
      d.innerHTML = p.isPick ? `${p.name} <span>draft pick · market ${Math.round(p.market)}</span>` : `${p.name} <span>${p.pos} ${p.team}${p.age ? " · " + Math.floor(p.age) + "y" : ""} · market ${Math.round(p.market)}</span>`;
      d.onclick = () => { box.innerHTML = ""; input.value = ""; onPick(p.id); };
      box.appendChild(d);
    });
  });
  // Enter picks the first suggestion
  input.addEventListener("keydown", (e) => { if (e.key !== "Enter") return; e.preventDefault();
    input.dispatchEvent(new Event("input")); // rebuild from the current text so a fast Enter never hits stale suggestions
    if (box.firstChild) box.firstChild.click(); });
}
const bar = (label, v, w) => `<div class="bar"><span>${label}</span><div class="track"><div class="fill ${w ? "w" : ""}" style="width:${Math.round(v)}%"></div></div><b>${Math.round(v)}</b></div>`;

// 30-day market trend: "▲ 12.3%" / "▼ 4.0%", empty when unknown
const trendTxt = (t) => (t == null ? "" : `<span class="${t >= 0 ? "up" : "down"}">${t >= 0 ? "▲" : "▼"} ${Math.abs(t).toFixed(1)}%</span>`);
const hintTag = (r) => (r.trendHint ? `<span class="tag ${r.trend > 0 ? "rising" : "falling"}">${r.trendHint}</span>` : "");

function card(r) {
  const p = r.p, st = p.st, o = r.overall;
  const big = DPT.TYPES.map((k) => `<div><small>${k}</small><b>${Math.round(o[k])}</b></div>`).join("");
  const src = { fc: "FantasyCalc", dd: "Dynasty Daddy", dp: "DynastyProcess", adp: "Sleeper ADP" };
  const srcBars = Object.entries(p.by).map(([k, v]) => bar(src[k] || k, v)).join("");
  const statsCol = r.hasStats ? `<h4>Stats model</h4>${bar("Now", r.now, 1)}${bar("Long-term", r.long, 1)}
    <div class="meta">Projected PPG: ${st.projPPG1.toFixed(1)} / ${st.projPPG2.toFixed(1)} / ${st.projPPG3.toFixed(1)} (next 3 seasons).<br>
    Chance still a regular: ${st.survival.map((x) => Math.round(100 * x) + "%").join(" / ")}.<br>Last season ${st.components.metrics.ppg.toFixed(1)} PPG in ${st.components.gamesLastSeason} games.</div>`
    : `<h4>Stats model</h4><p class="meta">No NFL stats yet (rookie or no recent games). Overall = market score only.</p>`;
  return `<div class="card"><div class="top"><div><h2>${p.name}</h2><div class="meta">${p.isPick ? "Draft pick" : `${p.pos} · ${p.team} · age ${p.age ? p.age.toFixed(1) : "?"} · yr ${p.exp ?? "?"} · ${p.injury || "healthy"} · depth ${p.depth ?? "n/a"}`}</div></div>
  <div style="text-align:right"><span class="badge ${r.archetype}">${DPT.LABEL[r.archetype]}</span><br><span class="tag">${r.tag}</span>${r.trendHint ? "<br>" + hintTag(r) : ""}</div></div>
  <h4>Overall score by team type (0-100)</h4><div class="verdict">${big}</div>
  <p class="exp">${r.explanation}</p>
  <div class="pair"><div><h4>Market ${Math.round(p.market)} <small>(${p.n} sources${p.spread != null ? ", spread " + p.spread.toFixed(1) : ""})</small></h4>${srcBars}
  <div class="meta">30-day trend: ${p.trend == null ? "n/a" : trendTxt(p.trend)}</div></div>
  <div>${statsCol}</div></div></div>`;
}

function showSingle(id) { $("#out").innerHTML = card(DPT.analyze(DB, id)); }

function renderSide(ids, ul, arr) {
  ul.innerHTML = ""; arr.forEach((id, i) => { const p = DB.byId[id]; const li = document.createElement("li");
    li.innerHTML = `<span>${p.name} <small>${p.isPick ? "pick" : p.pos + " " + p.team} · value ${Math.round(p.value)}</small> ${trendTxt(p.trend)}</span>`; const b = document.createElement("button"); b.textContent = "×"; b.onclick = () => { arr.splice(i, 1); renderTrade(); }; li.appendChild(b); ul.appendChild(li); });
}
function renderTrade() {
  renderSide(0, $("#la"), sideA); renderSide(0, $("#lb"), sideB);
  if (!sideA.length || !sideB.length) { $("#tout").innerHTML = "<p class='meta'>Add at least one player to each side.</p>"; return; }
  const t = DPT.analyzeTrade(DB, sideA, sideB);
  const w = (v) => (v.winner === "Even" ? "Fair" : `Side ${v.winner}: ${v.band}`);
  const row = (S, n) => S.rs.map((r) => `<li><span>${r.p.name} ${trendTxt(r.trend)} ${r.trendHint ? `<small>${r.trendHint}</small>` : ""}<br><small>C ${Math.round(r.overall.Contender)} · Rt ${Math.round(r.overall.Retooler)} · Rb ${Math.round(r.overall.Rebuilder)}</small></span><span><span class="badge ${r.archetype}" style="font-size:11px">${DPT.LABEL[r.archetype]}</span></span></li>`).join("");
  const n0 = (x) => Math.round(x).toLocaleString();
  const trow = (label, a, b) => `<tr><td>${label}</td><td>${n0(a)}</td><td>${n0(b)}</td></tr>`;
  const vk = (k) => `<div><small>Better for a ${k}</small><b>${w(t.verdict[k])}</b><small>${(100 * t.verdict[k].pct).toFixed(1)}% gap</small></div>`;
  $("#tout").innerHTML = `<div class="card"><h3>Verdict</h3><div class="verdict">${DPT.TYPES.map(vk).join("")}</div>
   <table class="tot"><tr><th></th><th>Side A</th><th>Side B</th></tr>
    ${trow("Raw market total (plain sum)", t.A.total, t.B.total)}${trow("Adjusted market total (package discount)", t.A.cons, t.B.cons)}
    ${DPT.TYPES.map((k) => trow(k + " raw (score-weighted)", t.A.rawAdj[k], t.B.rawAdj[k]) + trow(k + " adjusted", t.A.adj[k], t.B.adj[k])).join("")}</table>
   <p class="exp">Market: ${t.market.winner === "Even" ? "fair" : "Side " + t.market.winner + " ahead, " + t.market.band.toLowerCase()} (${(100 * t.market.pct).toFixed(1)}% gap on adjusted totals). The package discount values a side as (sum of v^${DPT.CONSOL_P})^(1/${DPT.CONSOL_P}), so several small pieces are worth less than one star of the same plain sum. Gap = difference / average of the two adjusted sides: under 8.5% Fair, 8.5-17% Slight edge, 17-42.5% Clear win, over 42.5% Lopsided. Per team type, each asset is first weighted by its overall score for that type.</p>
   <div class="pair"><ul>${row(t.A)}</ul><ul>${row(t.B)}</ul></div></div><div id="lgOdds"></div>`;
  leagueTradeOdds(t);
}

const TABS = { Single: "single", Trade: "trade", League: "league" };
function showTab(name) {
  Object.entries(TABS).forEach(([k, id]) => { $("#" + id).hidden = k !== name; $("#tab" + k).className = k === name ? "on" : ""; });
  if (name === "Trade") renderTrade();
}
Object.keys(TABS).forEach((k) => ($("#tab" + k).onclick = () => showTab(k)));
ac($("#q"), $("#ac"), showSingle);
ac($("#qa"), $("#aca"), (id) => { sideA.push(id); renderTrade(); }, true);
ac($("#qb"), $("#acb"), (id) => { sideB.push(id); renderTrade(); }, true);
$("#qbs").value = SET.qbs; $("#ppr").value = SET.ppr;
const onSet = () => {
  SET.qbs = +$("#qbs").value; SET.ppr = +$("#ppr").value;
  try { localStorage.setItem("dpt_settings", JSON.stringify(SET)); } catch (e) {}
  $("#status").textContent = "Reloading values..."; $("#out").innerHTML = "";
  (READY = load()).then(() => { if (!$("#trade").hidden) renderTrade(); }).catch((e) => { $("#status").textContent = "Data load failed: " + e.message; });
};
$("#qbs").onchange = onSet; $("#ppr").onchange = onSet;
let READY = load();
READY.catch((e) => { $("#status").textContent = "Data load failed: " + e.message; });

// ---------- League tab: Sleeper import, power table, title odds (league.js + sim.js) ----------
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const P1 = (x) => (100 * x).toFixed(1) + "%";
const DEFAULT_LEAGUE = "";
let LG = null, LGSIM = null, LGME = null, LGTOK = 0, LGTRTOK = 0;
const lgSaved = cget("dpt_league") || {};
$("#lid").value = lgSaved.id || DEFAULT_LEAGUE;

async function loadLeague() {
  const id = $("#lid").value.trim(); if (!id) return;
  const tok = ++LGTOK, st = $("#lstatus");
  try {
    st.textContent = "Loading league..."; $("#lout").innerHTML = ""; $("#lme").innerHTML = ""; LG = null;
    await READY; // Sleeper players (ages, names) come from the shared cache
    const L = await League.load(id, { players: PLAYERS, onStatus: (m) => (st.textContent = m) });
    if (tok !== LGTOK) return;
    st.textContent = `Simulating ${L.name}...`; await new Promise((r) => setTimeout(r, 20));
    LGSIM = Sim.run(League.toSimInput(L), { n: 10000, seed: 7 });
    LG = L;
    const saved = lgSaved.id === id ? lgSaved.me : null;
    $("#lme").innerHTML = L.teams.map((t) => `<option value="${t.rid}">${esc(t.owner)} (${esc(t.team)})</option>`).join("");
    LGME = L.teams.some((t) => t.rid === saved) ? saved : L.teams[0].rid; $("#lme").value = LGME;
    cset("dpt_league", { id, me: LGME });
    // auto-set the format toggle from the league; TE premium has no market-value equivalent
    const f = L.format, changed = f.qbs !== SET.qbs || f.ppr !== SET.ppr;
    let note = `Format set from the league: ${f.qbs === 2 ? "Superflex" : "1QB"}, ${{ 1: "PPR", 0.5: "half PPR", 0: "standard" }[f.ppr]}.`;
    if (f.tePremium) note += ` TE premium (+${f.tePremium} per reception) is not reflected in market values.`;
    $("#lfmt").textContent = note;
    if (changed) { $("#qbs").value = SET.qbs = f.qbs; $("#ppr").value = SET.ppr = f.ppr; try { localStorage.setItem("dpt_settings", JSON.stringify(SET)); } catch (e) {} READY = load(); await READY; }
    st.textContent = `${L.name} ${L.season}, week ${L.week}: ${L.numTeams} teams, ${L.playoffTeams} make the playoffs. Simulated ${LGSIM.n.toLocaleString()} seasons in ${LGSIM.ms} ms.`;
    renderLeague();
  } catch (e) { if (tok === LGTOK) st.textContent = "League load failed: " + e.message; }
}

function renderLeague() {
  if (!LG) return;
  const L = LG, pw = League.power(L), odds = {}; LGSIM.teams.forEach((t) => (odds[t.id] = t));
  const by = [...pw].sort((a, b) => odds[b.rid].title - odds[a.rid].title), top = odds[by[0].rid].title;
  const rows = pw.map((r) => { const o = odds[r.rid];
    return `<tr class="${r.rid === LGME ? "me" : ""}"><td>${r.rank}</td><td>${esc(r.owner)}</td><td>${r.ppg.toFixed(1)}</td><td>${r.gap >= 0 ? "+" : ""}${r.gap.toFixed(1)}</td><td>${r.w}-${r.l}${r.t ? "-" + r.t : ""}</td><td>${P1(o.playoff)}</td><td>${P1(o.bye)}</td><td><b>${P1(o.title)}</b></td><td>${o.playoff > 0.005 ? P1(o.title / o.playoff) : "-"}</td></tr>`; }).join("");
  const cal = top >= 0.27 && top <= 0.37 ? "within the 27-37% target" : "outside the 27-37% target, so the favorite is " + (top > 0.37 ? "possibly too dominant (variance too low) or just a very strong team" : "probably over-diluted");
  const ch = League.chips(L, LGME), me = L.teams.find((t) => t.rid === LGME);
  const chipRows = ch.rows.slice(0, 14).map((r) => `<tr><td>${esc(r.name)}</td><td>${r.pos}</td><td>${r.age ? Math.floor(r.age) : "?"}</td><td>${r.ppg.toFixed(1)}</td><td>${r.loss.toFixed(1)}</td><td>${r.free ? '<span class="tag rising">free chip</span>' : ""}</td></tr>`).join("");
  const free = ch.rows.filter((r) => r.free);
  const nm = (rid) => esc(L.teams.find((t) => t.rid === rid).owner);
  const seasons = [...new Set(L.picks.map((p) => p.season))];
  const pickRows = seasons.map((y) => { const mine = L.picks.filter((p) => p.season === y && p.owner === LGME), lost = L.picks.filter((p) => p.season === y && p.orig === LGME && p.owner !== LGME);
    return `<tr><td>${y}</td><td>${mine.map((p) => "R" + p.round + (p.orig === LGME ? "" : " <small>(from " + nm(p.orig) + ")</small>")).join(", ") || "none"}</td><td>${lost.map((p) => "R" + p.round + " <small>(" + nm(p.owner) + ")</small>").join(", ") || "-"}</td></tr>`; }).join("");
  $("#lout").innerHTML = `<div class="card"><h3>Power table and title odds</h3>
   <table class="tot lt"><tr><th>#</th><th>Manager</th><th>Proj PPG</th><th>Gap to last seed</th><th>Record</th><th>Playoffs</th><th>Bye</th><th>Title</th><th>Title | playoffs</th></tr>${rows}</table>
   <p class="meta">Proj PPG = best legal lineup from rest-of-season projections scored with this league's settings (age 30+ shaded -1.5). Gap = PPG minus the ${L.playoffTeams}th-best team. Calibration: the top team (${esc(by[0].owner)}) has ${P1(top)} title odds, ${cal}. Stretch target: title odds given a playoff berth of at least ${P1(1 / L.playoffTeams)}.</p></div>
   <div class="card"><h3>${esc(me.owner)}: chip efficiency</h3>
   <p class="meta">Lineup PPG lost if the player is removed. Under 0.05 = free chip (pay with these first)${free.length ? ": " + free.slice(0, 8).map((r) => esc(r.name)).join(", ") + (free.length > 8 ? ", +" + (free.length - 8) + " more" : "") : ""}. Draft picks cost 0 PPG.</p>
   <table class="tot lt"><tr><th>Player</th><th>Pos</th><th>Age</th><th>Proj PPG</th><th>PPG lost</th><th></th></tr>${chipRows}</table></div>
   <div class="card"><h3>${esc(me.owner)}: pick ownership</h3>
   <table class="tot lt"><tr><th>Draft</th><th>Picks I hold</th><th>My picks owned by others</th></tr>${pickRows}</table></div>`;
}

// Trade mode: title odds before and after for my team. Side A = what I give, side B = what I get.
function leagueTradeOdds(t) {
  const box = $("#lgOdds"); if (!box) return;
  if (!LG) { box.innerHTML = "<p class='meta'>Load a league in the League tab to see title odds before and after this trade.</p>"; return; }
  box.innerHTML = "<p class='meta'>Simulating title odds...</p>";
  const my = LGME, a = sideA.slice(), b = sideB.slice(), tok = ++LGTRTOK;
  setTimeout(() => {
    if (tok !== LGTRTOK || !LG) return;
    const L = LG, tr = League.tradeOverride(L, my, a, b), ign = a.filter((id) => !tr.gives.includes(id) && !DB.byId[id].isPick).length;
    const after = Sim.run(League.toSimInput(L, tr.override), { n: 10000, seed: 7 });
    const i = LGSIM.teams.findIndex((x) => x.id === my), c = LGSIM.teams.findIndex((x) => x.id === tr.counterparty), b0 = LGSIM.teams[i], a0 = after.teams[i];
    const v = League.titleVerdict(b0.title, a0.title, L.numTeams, t.A.total > t.B.total);
    const nm = L.teams.find((x) => x.rid === my).owner;
    box.innerHTML = `<div class="card"><h3>Title odds for ${esc(nm)}</h3>
     <div class="verdict"><div><small>Title before</small><b>${P1(b0.title)}</b></div><div><small>Title after</small><b>${P1(a0.title)}</b></div><div><small>Playoffs</small><b>${P1(b0.playoff)} to ${P1(a0.playoff)}</b></div></div>
     <p class="exp"><span class="tag ${v.zone === "above" ? "rising" : v.zone === "below" ? "falling" : ""}">${v.zone === "above" ? "Clears floor" : v.zone === "gray" ? "Gray zone" : "Below floor"}</span> ${esc(v.text)}</p>
     <p class="meta">${c >= 0 ? "Counterparty " + esc(L.teams.find((x) => x.rid === tr.counterparty).owner) + ": title " + P1(LGSIM.teams[c].title) + " to " + P1(after.teams[c].title) + ". " : ""}Only players move lineups; draft picks are not modeled here.${ign ? " " + ign + " Side A player(s) not on your roster were ignored." : ""} Floor = 1/${L.numTeams}; gray zone +/-${League.GRAY} pts.</p></div>`;
  }, 15);
}
$("#lload").onclick = loadLeague;
$("#lid").addEventListener("keydown", (e) => { if (e.key === "Enter") loadLeague(); });
$("#lme").onchange = () => { LGME = +$("#lme").value; cset("dpt_league", { id: LG.id, me: LGME }); renderLeague(); if (!$("#trade").hidden) renderTrade(); };
