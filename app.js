const $ = (s) => document.querySelector(s);
const SET = Object.assign({ qbs: 1, ppr: 1 }, (() => { try { return JSON.parse(localStorage.getItem("dpt_settings")) || {}; } catch (e) { return {}; } })());
const q = () => `numQbs=${SET.qbs}&numTeams=12&ppr=${SET.ppr}`;
let DB = null, sideA = [], sideB = [];

async function j(u) { const r = await fetch(u); if (!r.ok) throw new Error(u + " " + r.status); return r.json(); }
const cget = (k) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch (e) { return null; } };
const cset = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };

async function load() {
  const day = new Date().toISOString().slice(0, 10);
  // base = Sleeper players + stats (same for every setting); values = FantasyCalc per setting
  const bkey = "dpt_base_v2_" + day, vkey = `dpt_vals_v2_${day}_${q()}`;
  try { Object.keys(localStorage).forEach((k) => { if (k.startsWith("dpt_") && k !== "dpt_settings" && !k.includes(day)) localStorage.removeItem(k); }); } catch (e) {}
  let base = cget(bkey), vals = cget(vkey), note = base && vals ? "cached today" : "live";
  if (!vals) {
    const [dyn, red] = await Promise.all([
      j(`https://api.fantasycalc.com/values/current?isDynasty=true&${q()}`),
      j(`https://api.fantasycalc.com/values/current?isDynasty=false&${q()}`).catch(() => []),
    ]);
    // keep only the fields scoring.js reads (raw responses are ~480KB per format)
    const pl = (r) => ({ sleeperId: r.player.sleeperId, name: r.player.name, position: r.player.position, maybeAge: r.player.maybeAge, maybeTeam: r.player.maybeTeam });
    vals = { dyn: dyn.map((r) => ({ player: pl(r), value: r.value, redraftValue: r.redraftValue, positionRank: r.positionRank, overallRank: r.overallRank })),
      red: red.map((r) => ({ player: { sleeperId: r.player.sleeperId }, value: r.value })) };
    cset(vkey, vals);
  }
  if (!base) {
    const players = await j("https://api.sleeper.app/v1/players/nfl");
    let year = 2025, stats = await j("https://api.sleeper.app/v1/stats/nfl/regular/2025").catch(() => ({}));
    if (!Object.values(stats).some((s) => s.gp)) { year = 2024; stats = await j("https://api.sleeper.app/v1/stats/nfl/regular/2024").catch(() => ({})); }
    // slim down before caching (full players file is ~14MB, too big for localStorage); keep every
    // active skill player so a settings change needs no refetch
    const sp = {}, st = {};
    Object.entries(players).forEach(([id, p]) => {
      if (!p.team || p.status !== "Active" || !["QB", "RB", "WR", "TE"].includes(p.position)) return;
      sp[id] = { team: p.team, age: p.age, years_exp: p.years_exp, injury_status: p.injury_status, depth_chart_order: p.depth_chart_order };
      const s = stats[id]; if (s) st[id] = { gp: s.gp, pts_ppr: s.pts_ppr, pts_half_ppr: s.pts_half_ppr, pts_std: s.pts_std };
    });
    base = { players: sp, stats: st, statsYear: year }; cset(bkey, base);
  }
  DB = DPT.buildDB({ ...base, ...vals, ppr: SET.ppr, sos: window.SOS_RANK });
  sideA = sideA.filter((id) => DB.byId[id]); sideB = sideB.filter((id) => DB.byId[id]);
  const fmt = `${SET.qbs === 2 ? "Superflex" : "1QB"}, ${{ 1: "PPR", 0.5: "half PPR", 0: "standard" }[SET.ppr]}`;
  $("#status").textContent = `${DB.list.length} players + ${DB.picks.length} picks loaded (${note}; ${fmt}, 12 teams; picks: ${DB.pickSource}). Stats: ${DB.statsYear} season. Schedule strength = demo estimate.`;
}

function ac(input, box, onPick, withPicks) {
  input.addEventListener("input", () => {
    const t = input.value.trim().toLowerCase(); box.innerHTML = "";
    if (!DB || t.length < 2) return;
    (withPicks ? DB.list.concat(DB.picks) : DB.list).filter((p) => p.name.toLowerCase().includes(t)).slice(0, 8).forEach((p) => {
      const d = document.createElement("div");
      d.innerHTML = p.isPick ? `${p.name} <span>draft pick · ${p.dynValue}</span>` : `${p.name} <span>${p.pos} ${p.team} · ${Math.floor(p.age)}y · ${p.dynValue}</span>`;
      d.onclick = () => { box.innerHTML = ""; input.value = ""; onPick(p.id); };
      box.appendChild(d);
    });
  });
  // Enter picks the first suggestion
  input.addEventListener("keydown", (e) => { if (e.key === "Enter" && box.firstChild) { e.preventDefault(); box.firstChild.click(); } });
}
const bar = (label, v, w) => `<div class="bar"><span>${label}</span><div class="track"><div class="fill ${w ? "w" : ""}" style="width:${Math.round(v)}%"></div></div><b>${Math.round(v)}</b></div>`;

function card(r) {
  const p = r.p, s = r.scores, d = r.detail;
  return `<div class="card"><div class="top"><div><h2>${p.name}</h2><div class="meta">${p.pos} · ${p.team} · age ${p.age.toFixed(1)} · yr ${p.exp ?? "?"} · ${p.injury || "healthy"} · depth ${p.depth ?? "n/a"}</div>
  <div class="meta">Dynasty value ${p.dynValue} (#${p.overallRank}) · redraft ${p.redValue} · ${p.gp} GP, ${p.ppg.toFixed(1)} PPG (${DB.statsYear})</div></div>
  <div style="text-align:right"><span class="badge ${r.archetype}">${DPT.LABEL[r.archetype]}</span><br><span class="tag">${r.tag}</span></div></div>
  <p class="exp">${r.explanation}</p>
  <div class="pair"><div><h4>Win-Now ${Math.round(r.winNow)}</h4>${bar("Production", s.production, 1)}${bar("Health", s.health, 1)}${bar("Situation", s.situation, 1)}${bar("Schedule*", s.sos, 1)}</div>
  <div><h4>Long-Term ${Math.round(r.longTerm)}</h4>${bar("Age runway", s.age)}${bar("Future premium", s.futurePremium)}${bar("Dynasty value", s.value)}</div></div>
  <div class="meta">Years to cliff: <b>${r.yearsToCliff}</b> · teammates at ${p.pos} ranked ahead: ${d.teammatesAhead} · team passing offense percentile: ${Math.round(d.offQuality)} · *demo estimate</div></div>`;
}

function showSingle(id) { $("#out").innerHTML = card(DPT.analyze(DB, id)); }

function renderSide(ids, ul, arr) {
  ul.innerHTML = ""; arr.forEach((id, i) => { const p = DB.byId[id]; const li = document.createElement("li");
    li.innerHTML = `<span>${p.name} <small>${p.isPick ? "pick" : p.pos + " " + p.team} · ${p.dynValue}</small></span>`; const b = document.createElement("button"); b.textContent = "×"; b.onclick = () => { arr.splice(i, 1); renderTrade(); }; li.appendChild(b); ul.appendChild(li); });
}
function renderTrade() {
  renderSide(0, $("#la"), sideA); renderSide(0, $("#lb"), sideB);
  if (!sideA.length || !sideB.length) { $("#tout").innerHTML = "<p class='meta'>Add at least one player to each side.</p>"; return; }
  const t = DPT.analyzeTrade(DB, sideA, sideB);
  const w = (k) => ({ A: "Side A", B: "Side B", Even: "Even" }[t.verdict[k].winner]);
  const row = (S, n) => S.rs.map((r) => `<li><span>${r.p.name}</span><span><span class="badge ${r.archetype}" style="font-size:11px">${DPT.LABEL[r.archetype]}</span> <small>${r.tag}</small></span></li>`).join("");
  $("#tout").innerHTML = `<div class="card"><h3>Verdict</h3><div class="verdict">
   <div><small>Better for a Contender</small><b>${w("Contender")}</b></div><div><small>Better for a Retooler</small><b>${w("Retooler")}</b></div><div><small>Better for a Rebuilder</small><b>${w("Rebuilder")}</b></div></div>
   <p class="exp">Raw dynasty value: A = ${Math.round(t.A.total)}, B = ${Math.round(t.B.total)} (${t.valueWinner === "Even" ? "even" : "Side " + t.valueWinner + " ahead"}). "Better for" means the side whose players are worth more to that kind of team after weighting each player by how well he fits it.</p>
   <div class="pair"><ul>${row(t.A)}</ul><ul>${row(t.B)}</ul></div></div>`;
}

$("#tabSingle").onclick = () => { $("#single").hidden = false; $("#trade").hidden = true; $("#tabSingle").className = "on"; $("#tabTrade").className = ""; };
$("#tabTrade").onclick = () => { $("#single").hidden = true; $("#trade").hidden = false; $("#tabTrade").className = "on"; $("#tabSingle").className = ""; renderTrade(); };
ac($("#q"), $("#ac"), showSingle);
ac($("#qa"), $("#aca"), (id) => { sideA.push(id); renderTrade(); }, true);
ac($("#qb"), $("#acb"), (id) => { sideB.push(id); renderTrade(); }, true);
$("#qbs").value = SET.qbs; $("#ppr").value = SET.ppr;
const onSet = () => {
  SET.qbs = +$("#qbs").value; SET.ppr = +$("#ppr").value;
  try { localStorage.setItem("dpt_settings", JSON.stringify(SET)); } catch (e) {}
  $("#status").textContent = "Reloading values..."; $("#out").innerHTML = "";
  load().then(() => { if (!$("#trade").hidden) renderTrade(); }).catch((e) => { $("#status").textContent = "Data load failed: " + e.message; });
};
$("#qbs").onchange = onSet; $("#ppr").onchange = onSet;
load().catch((e) => { $("#status").textContent = "Data load failed: " + e.message; });
