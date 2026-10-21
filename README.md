# Dynasty Pre-Trade Analyzer

Dynasty (not redraft) fantasy football tool. Pick a player and see which kind of team he is worth the most to (Contender, Retooler, Rebuilder), with a tag such as "Buy for contenders", "Sell before cliff", "Rebuilder stash" or "Hold". Trade mode compares two sides (players and draft picks) and gives a verdict per team type.

## Features
- Player search with autocomplete; Enter picks the first suggestion (player search and both trade inputs).
- League format toggle in the header: 1QB or Superflex, and PPR, half PPR or standard. Changing it refetches FantasyCalc values and recomputes PPG with the matching Sleeper points field. The choice is remembered in localStorage.
- Draft picks in trade mode, searchable like players (for example "2027 1st").
- Every player and pick gets an **overall score out of 100 for each team type** (Contender, Retooler, Rebuilder), built from aggregate market value plus a statistical model.
- Elite players (all three scores 85+) get the "Core asset (any team)" badge instead of an archetype.

## Run
```
cd ~/Code/dynasty-pretrade
python3 -m http.server 8787
# open http://localhost:8787
```
No build step, no API keys. Refresh the data snapshots (Node 18+): `node scripts/fetch-values.mjs` (market values, daily), `node scripts/fit-sos.mjs` (strength of schedule, weekly in season) and `node scripts/fit-stats.mjs` (stats model, about 1 minute, after each season or roster change). Scheduled refresh of market values (launchd, cron or a GitHub Action, all shipped disabled): `docs/refresh.md`. Test the scoring in the terminal: `node test.js "Josh Allen" "Derrick Henry"`. Other formats: `QBS=2 PPR=0.5 node test.js`. The test also prints the Core assets, the top 5 per team type and two trades.

## Data
- **Market value** (`data/values.json`, built by `scripts/fetch-values.mjs`): aggregate of FantasyCalc, Dynasty Daddy, DynastyProcess and Sleeper dynasty ADP for six formats (1QB/SF x PPR/half/standard), players and draft picks. KeepTradeCut and FantasyPros are excluded because their terms forbid scraping or republishing. Each source is rank-matched to the FantasyCalc scale, scored `100*(value/top)^0.5`, then combined by a coverage-weighted 20% trimmed mean. Details: `docs/market-model.md`.
- **Stats model** (`data/stats.json`, built by `scripts/fit-stats.mjs`): per-position ridge regression on nflverse data (usage, share, efficiency, availability, age), trained 2018-2023 and tested on 2024 to 2025. It beats "last season's PPG" at every position (holdout R² QB 0.15 vs -0.17, RB 0.68 vs 0.61, WR 0.68 vs 0.55, TE 0.66 vs 0.53). The QB model adds rushing share, dropback volume and team context (team pass attempts, EPA per play, TDs per game); it is still under the 0.25 bar, so QB stat scores show a **Low confidence** tag in the UI (`meta.confidence` in `data/stats.json`). Age curves and the chance a player is still a regular in 1-3 seasons are fitted from data. `statScoreNow` scores next season's projected PPG, `statScoreLong` the survival-weighted, discounted 3-season projection. Both use `100*Phi(z)` against the position's starter pool, so 50 = an average starter. Details: `docs/stats-model.md`.
- **Sleeper players** (live in the browser, cached for the day): team, injury status, depth chart.

## Overall score (0-100 per team type)
`Overall = m * Market + (1 - m) * Stats`, where `Stats = now * statScoreNow + (1 - now) * statScoreLong`.

| Team type | m (market weight) | now (stats weight on this season) |
|---|---|---|
| Contender | 0.40 | 0.80 |
| Retooler | 0.50 | 0.50 |
| Rebuilder | 0.60 | 0.15 |

- A rebuilder only keeps market value that lasts. Persistence = P(still a regular in 3 seasons) / the 75th percentile of that at the position, capped at 1. The Rebuilder market term is multiplied by persistence, and the Retooler term by (1 + persistence) / 2. The Contender term is unchanged.
- A player with no NFL stats (a rookie) uses the market score only and says so.
- Draft picks have no stats: market score -25 (Contender), -5 (Retooler), +10 (Rebuilder).
- The Contender score loses points for current injury status: IR 15, Out/PUP 12, Suspended 10, Doubtful 8, Questionable 3.
- Archetype: Contender minus Rebuilder above 5 = Contender, below -5 = Rebuilder, otherwise Retooler. Persistence under 0.65 = Contender (an aging asset's only use is now; this catches every RB 29+). All three 85+ = Core asset.
- Tag: under a 50% chance of still being a regular in 2 seasons while the now score is 50+ = "Sell before cliff". Best score under 40 = "Contender depth only" or "Low value".

## Strength of schedule (display only)
`node scripts/fit-sos.mjs` writes `data/sos.json` from nflverse weekly player stats and the nflverse schedule (`games.csv`).
- Defense index per position = PPR points the defense allows per game to QBs, RBs, WRs or TEs (all players at the position summed per game), divided by the league average. 1.00 = average, above 1 = easier matchup.
- Blend of last season and this season to date: `idx = 1 + s * (w * toDate + (1 - w) * prior - 1)`, `w = games / (games + K)`. K and s are fitted by predicting weeks 7-18 from the prior season plus weeks 1-6 (2023 to 2024 and 2024 to 2025, 256 defense-position rows). Fitted: K = 4 games, s = 0.3.
- SOS for a team = mean index of its remaining opponents, plus the fantasy playoff weeks 15-17 alone. Rank 1 = easiest.
- Validation is weak: correlation with the truth is QB 0.22, RB 0.26, WR 0.09, TE 0.27, and RMSE beats "every defense is average" by only 0-4%. Last season alone does not predict this season (WR -0.19). That is why the fitted shrink is strong (ROS indexes land within about +-5%) and why SOS is shown on the player card but is not part of any score.

## Trade mode
Each asset's aggregate market value (FantasyCalc scale) is scaled by `(0.5 + overall/100) / (0.5 + market/100)` for each team type (only how that team type differs from the market counts, since value already prices the market). Each side is then **consolidated** with a power-sum `(sum v^1.3)^(1/1.3)`, so a 3-for-1 is not treated as the plain sum (roster spots and lineup slots make depth worth less than a star). p = 1.3 is fitted to FantasyCalc's own trade calculator rule (evidence in `docs/market-model.md`). The UI shows raw (plain sum) and adjusted totals.

Verdict per team type uses gap / average of the two adjusted sides: under 8.5% Fair, 8.5-17% Slight edge, 17-42.5% Clear win, over 42.5% Lopsided.

## 30-day trend
`trend30` (% change in market value; mean of FantasyCalc and Dynasty Daddy where available) shows on the player card and trade rows as a triangle and percent. +10% or more adds "Rising: sell high if moving", -10% or less adds "Falling: buy the dip" (only for assets worth 1500+ on the FantasyCalc scale).

## Known estimates (hand-set, not fitted)
- The market vs stats weights, the 0.65 persistence cutoff, the per-type horizon weights, the pick adjustments and the injury penalties above.
- Market source weights (FantasyCalc 1.0, Dynasty Daddy 1.0, DynastyProcess 0.75, Sleeper ADP 0.6).

## Known limits
- Market values are a snapshot (date shown in the app), not live. Re-run `scripts/fetch-values.mjs` to refresh.
- The stats model is PPR only; half and standard formats change the market half only.
- The QB stats model is weak (2025 holdout R² 0.15 on 35 players; 0.23-0.54 in 2022-2024 holdouts) and is flagged Low confidence in the UI. Survival odds past age 36 rest on few players.
- 12-team leagues only.

## Public deploy (GitHub Pages)
`bash scripts/build-pages.sh` builds `dist/` (static files plus the three data snapshots, about 1 MB). It blanks the prefilled Sleeper league ID so visitors do not land on a private league (`PUBLIC=0` keeps it). Preview: `python3 -m http.server -d dist 8790`. `.github/workflows/pages.yml` deploys it on a manual run only. Nothing is pushed or deployed until the repo has a remote and the owner approves making it public. Write-up: `docs/case-study.md`.

## League tab (Sleeper import and title odds)
Enter a public Sleeper league ID (the number in your Sleeper league URL; no default), press Load, pick your team. No login; read-only API calls. Tests: `node test-league.js <leagueId>` or `LEAGUE=<id> node test-league.js` (live data; `ME=<display_name> N=10000`; no default league).

**Trade suggester** (League tab, `suggest.js`): pick a partner and it searches both rosters (players and picks, 1-for-1 up to 3-for-2) for trades with a market gap under 17% where each side gains by its own lens (team-type value; title odds from the season sim). Shows the top 5 skeletons with value per side, title-odds change per side, a short why, sources, snapshot date and a low-confidence flag. Export: CSV download and a share link (`#sug=1&league=<id>&me=<roster>&with=<roster>`) that reruns the same deterministic search. Skeletons to negotiate from, not trades to accept. Tests: `node test-suggest.js` (offline, synthetic league).
- `league.js`: loads settings, users, rosters, standings, traded picks, NFL state, the remaining schedule (`/matchups/<week>`) and weekly projections for every remaining regular-season week. Projections come from `api.sleeper.app/projections/nfl/<season>/<week>` (the `/v1/projections` path now returns empty objects) and are scored with the league's own `scoring_settings` (sum of stat x weight, so TE premium and 6-pt pass TD are included). A player's rest-of-season PPG is the mean over the weeks he is projected to play (bye weeks are skipped). Age 30+ is shaded -1.5 PPG.
- Best legal lineup per team (QB, RB, WR, TE, FLEX = RB/WR/TE, SUPER_FLEX = any of the four; taxi players cannot start). Power table = lineup PPG with the gap to the last playoff seed (by PPG). Pick ownership for the next three drafts is the default owner plus `traded_picks`. Chip efficiency = lineup PPG lost if an asset is removed; under 0.05 is a free chip.
- `sim.js`: 10,000-season Monte Carlo (about 0.2 s in node). True strength N(0, 8) drawn once per sim; weekly score N(lineup + strength, 16% of the healthy lineup PPG); weekly injury misses (QB 1.2/11, WR 1.5/11, RB 1.7/11, RB 29+ 2.5/11, TE 1.6/11, TE 32+ 2.0/11) refill from the bench (streamer QB 12 PPG, skill replacement 7). Starts from current records and points for, plays the real remaining schedule, then the league's bracket (top seeds get byes, re-seeding if the league re-seeds, seeding by wins then points for). Reports playoff %, bye % and title % per team, and prints a calibration check (top team should be 27-37%).
- Trade mode with a league loaded shows title odds before and after for your team (side A is what you give, side B what you get; the first incoming player's owner is the counterparty). Floor = 1/teams (8.3% in 12 teams) with a +/-1.5 point gray zone and a verdict line. Draft picks do not move lineups, so they have no effect on the odds.
- Loading a league sets the format toggle (1QB/Superflex, PPR level) from the league. TE premium is not reflected in market values.
- Not done: 3-year (multi-season) equity, bye-week-aware weekly means, long-term injury timelines, K/DEF/IDP slots, players-who-missed-8+-games last year multiplier, FAAB or waiver pickups.
