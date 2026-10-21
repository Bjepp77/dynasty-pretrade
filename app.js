const $ = (s) => document.querySelector(s);
const SET = Object.assign({ qbs: 1, ppr: 1 }, (() => { try { return JSON.parse(localStorage.getItem("dpt_settings")) || {}; } catch (e) { return {}; } })());
const q = () => `numQbs=${SET.qbs}&numTeams=12&ppr=${SET.ppr}`;
let DB = null, sideA = [], sideB = [];

async function j(u) { const r = await fetch(u); if (!r.ok) throw new Error(u + " " + r.status); return r.json(); }
const cget = (k) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch (e) { return null; } };
const cset = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };

let VALUES = null, STATS = null;
async function load() {
  const day = new Date().toISOString().slice(0, 10), bkey = "dpt_base_v3_" + day;
  try { Object.keys(localStorage).forEach((k) => { if (k.startsWith("dpt_") && k !== "dpt_settings" && !k.includes(day)) localStorage.removeItem(k); }); } catch (e) {}
  // values.json (aggregate market) and stats.json (stats model) are snapshots built by scripts/
  if (!VALUES) [VALUES, STATS] = await Promise.all([j("data/values.json"), j("data/stats.json")]);
  // Sleeper players: live team, injury and depth chart (slimmed before caching; full file is ~14MB)
  let players = cget(bkey);
  if (!players) {
    const all = await j("https://api.sleeper.app/v1/players/nfl");
    players = {};
    Object.entries(all).forEach(([id, p]) => {
      if (p.team && ["QB", "RB", "WR", "TE"].includes(p.position)) players[id] = { team: p.team, age: p.age, years_exp: p.years_exp, injury_status: p.injury_status, depth_chart_order: p.depth_chart_order };
    });
    cset(bkey, players);
  }
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
  <div style="text-align:right"><span class="badge ${r.archetype}">${DPT.LABEL[r.archetype]}</span><br><span class="tag">${r.tag}</span></div></div>
  <h4>Overall score by team type (0-100)</h4><div class="verdict">${big}</div>
  <p class="exp">${r.explanation}</p>
  <div class="pair"><div><h4>Market ${Math.round(p.market)} <small>(${p.n} sources${p.spread != null ? ", spread " + p.spread.toFixed(1) : ""})</small></h4>${srcBars}</div>
  <div>${statsCol}</div></div></div>`;
}

function showSingle(id) { $("#out").innerHTML = card(DPT.analyze(DB, id)); }

function renderSide(ids, ul, arr) {
  ul.innerHTML = ""; arr.forEach((id, i) => { const p = DB.byId[id]; const li = document.createElement("li");
    li.innerHTML = `<span>${p.name} <small>${p.isPick ? "pick" : p.pos + " " + p.team} · value ${Math.round(p.value)}</small></span>`; const b = document.createElement("button"); b.textContent = "×"; b.onclick = () => { arr.splice(i, 1); renderTrade(); }; li.appendChild(b); ul.appendChild(li); });
}
function renderTrade() {
  renderSide(0, $("#la"), sideA); renderSide(0, $("#lb"), sideB);
  if (!sideA.length || !sideB.length) { $("#tout").innerHTML = "<p class='meta'>Add at least one player to each side.</p>"; return; }
  const t = DPT.analyzeTrade(DB, sideA, sideB);
  const w = (k) => ({ A: "Side A", B: "Side B", Even: "Even" }[t.verdict[k].winner]);
  const row = (S, n) => S.rs.map((r) => `<li><span>${r.p.name} <small>C ${Math.round(r.overall.Contender)} · Rt ${Math.round(r.overall.Retooler)} · Rb ${Math.round(r.overall.Rebuilder)}</small></span><span><span class="badge ${r.archetype}" style="font-size:11px">${DPT.LABEL[r.archetype]}</span></span></li>`).join("");
  $("#tout").innerHTML = `<div class="card"><h3>Verdict</h3><div class="verdict">
   <div><small>Better for a Contender</small><b>${w("Contender")}</b></div><div><small>Better for a Retooler</small><b>${w("Retooler")}</b></div><div><small>Better for a Rebuilder</small><b>${w("Rebuilder")}</b></div></div>
   <p class="exp">Aggregate market value: A = ${Math.round(t.A.total)}, B = ${Math.round(t.B.total)} (${t.valueWinner === "Even" ? "even" : "Side " + t.valueWinner + " ahead"}). "Better for" means the side whose players are worth more to that kind of team after weighting each asset by its overall score for that team type.</p>
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
