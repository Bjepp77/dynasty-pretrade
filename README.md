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
No build step, no API keys. Refresh the data snapshots (Node 18+): `node scripts/fetch-values.mjs` (market values, daily) and `node scripts/fit-stats.mjs` (stats model, about 1 minute, after each season or roster change). Test the scoring in the terminal: `node test.js "Josh Allen" "Derrick Henry"`. Other formats: `QBS=2 PPR=0.5 node test.js`. The test also prints the Core assets, the top 5 per team type and two trades.

## Data
- **Market value** (`data/values.json`, built by `scripts/fetch-values.mjs`): aggregate of FantasyCalc, Dynasty Daddy, DynastyProcess and Sleeper dynasty ADP for six formats (1QB/SF x PPR/half/standard), players and draft picks. KeepTradeCut and FantasyPros are excluded because their terms forbid scraping or republishing. Each source is rank-matched to the FantasyCalc scale, scored `100*(value/top)^0.5`, then combined by a coverage-weighted 20% trimmed mean. Details: `docs/market-model.md`.
- **Stats model** (`data/stats.json`, built by `scripts/fit-stats.mjs`): per-position ridge regression on nflverse data (usage, share, efficiency, availability, age), trained 2018-2023 and tested on 2024 to 2025. It beats "last season's PPG" at every position (holdout R² QB 0.08 vs -0.17, RB 0.68 vs 0.61, WR 0.68 vs 0.55, TE 0.66 vs 0.53). Age curves and the chance a player is still a regular in 1-3 seasons are fitted from data. `statScoreNow` scores next season's projected PPG, `statScoreLong` the survival-weighted, discounted 3-season projection. Both use `100*Phi(z)` against the position's starter pool, so 50 = an average starter. Details: `docs/stats-model.md`.
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

## Trade mode
Each asset's aggregate market value (FantasyCalc scale) is scaled by `0.5 + overall/100` for each team type. The side with the higher total is "better for" that team type. Raw aggregate totals are shown too.

## Known estimates (hand-set, not fitted)
- The market vs stats weights, the 0.65 persistence cutoff, the per-type horizon weights, the pick adjustments and the injury penalties above.
- Market source weights (FantasyCalc 1.0, Dynasty Daddy 1.0, DynastyProcess 0.75, Sleeper ADP 0.6).
- The old strength-of-schedule demo table is gone; schedule is no longer scored.

## Known limits
- Market values are a snapshot (date shown in the app), not live. Re-run `scripts/fetch-values.mjs` to refresh.
- The stats model is PPR only; half and standard formats change the market half only.
- The QB stats model is weak (R² 0.08 on 35 players). Survival odds past age 36 rest on few players.
- 12-team leagues only.
