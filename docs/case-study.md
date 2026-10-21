# Case study: Dynasty Pre-Trade Analyzer

## Problem
In dynasty fantasy football, the same player is worth different amounts to different teams. A 29-year-old running back helps a title contender this season and is a wasting asset for a rebuilding team. Free trade calculators give one number per player, so they cannot answer the real question before a trade: who should own this player, and does this deal help my team win?

The tool answers it three ways:
- **Player view:** an overall score out of 100 for each team type (Contender, Retooler, Rebuilder), plus a tag such as "Sell before cliff" or "Rebuilder stash".
- **Trade view:** a verdict per team type, with a package discount so three small pieces do not add up to one star.
- **League view:** imports a public Sleeper league and simulates 10,000 seasons to show how a trade moves your title odds.

It is a static site with no build step, no accounts and no paid data.

## Model
**Market half.** Values from FantasyCalc, Dynasty Daddy, DynastyProcess and Sleeper dynasty ADP, in six league formats. Each source is rank-matched to one scale. The sources are then combined with a coverage-weighted 20% trimmed mean. KeepTradeCut and FantasyPros are left out because their terms forbid scraping. Details: `docs/market-model.md`.

**Stats half.** There are 12 ridge regressions in total: one per position (QB, RB, WR, TE) for each of 1, 2 and 3 seasons ahead. They predict PPR points per game from nflverse season data: usage, shares, efficiency, availability, age with fitted hinges, and team context for QBs. A career-cliff hazard comes from nflverse data, shrunk toward a published age-hazard table, with the shrink strength chosen by rolling log-loss. Survival, availability and a 0.9 yearly discount turn the projections into a long-term score. Details: `docs/stats-model.md`.

**Blend.** Overall = m x market + (1 - m) x stats. The weights shift by team type: a contender weights this season and the stats more, a rebuilder weights market value that lasts. Trade sides are combined with a power sum, (sum of v^1.3)^(1/1.3). The exponent 1.3 was fitted to FantasyCalc's own trade calculator.

**Title odds.** Sleeper weekly projections are scored with the league's own scoring settings, and each team gets its best legal lineup. The Monte Carlo then plays the real remaining schedule and the league's playoff bracket, with weekly variance and injury replacement.

**Strength of schedule.** Each defense's PPR points allowed per game to each position, as a ratio to the league average. Last season and this season to date are blended with a fitted weight. Each team's remaining opponents are then averaged. It is shown on the player card but not scored, because the validation below says it is weak.

## Validation (2025 holdout)
Each stats model was trained on seasons up to 2023 or 2024 and scored on 2025, a season it never saw. The baseline is last season's points per game carried forward.

| Position | Players | Model R² | Baseline R² | Model MAE | Baseline MAE |
|---|---|---|---|---|---|
| QB | 35 | 0.15 | -0.17 | 3.05 | 3.80 |
| RB | 78 | 0.68 | 0.61 | 2.62 | 2.79 |
| WR | 141 | 0.68 | 0.55 | 2.26 | 2.63 |
| TE | 84 | 0.66 | 0.53 | 1.83 | 2.10 |

- The model beats the baseline at every position. At 2 and 3 seasons ahead the gap is wider (for example WR 3 years out: 0.51 vs -0.11), but those numbers fill in departed players at replacement level, so they flatter the model.
- QB rework: the model added rushing share, dropback volume and team offense context. That lifted the 2025 holdout from 0.08 to 0.15, and it improved every rolling holdout year from 2022 to 2025. It is still under the 0.25 bar, so the app tags QB stat scores "Low confidence".
- Cliff hazard: the blend of fit and prior (log-loss 0.446) beats the fit alone (0.464) and the published table alone (0.455) on rolling 2021-2024 data.
- Strength of schedule: the model predicted weeks 7-18 from the prior season plus weeks 1-6, on 2024 and 2025. Correlations were 0.09 (WR) to 0.27 (TE). The error was only 0-4% better than calling every defense average.
- Title odds: as a calibration check, the top team in a 12-team test league should land at 27-37%. It landed at 37.8%, just above the band, with two 6-0 teams.

## What is weak
- **QB projections.** R² is 0.15 on 35 players. Injuries, benchings and team changes drive next-season QB scoring, and season stats cannot see them. Scores near the top of the pool swing a lot on small changes in projection.
- **Strength of schedule.** It barely predicts anything. It is shown for context only.
- **Hand-set weights.** The market vs stats weights, the persistence cutoff, the pick adjustments and the injury penalties are judgment calls, not fitted values.
- **Format coverage.** The stats are PPR only. Half-PPR and standard change only the market half. TE premium is not in market values. 12-team leagues only.
- **Rookies.** Players with no NFL stats are scored on market value only.
- **Snapshots.** Market values, stats and SOS are dated snapshots. Market refresh is ready to schedule but not turned on.
- **Old players.** Survival estimates past age 35 rest mostly on the prior table, because few players last that long.

## Stack
Plain HTML, CSS and JavaScript. Node scripts build the JSON snapshots with no npm dependencies; the ridge regression and logistic IRLS are written by hand. Data comes from nflverse, DynastyProcess, FantasyCalc, Dynasty Daddy and Sleeper's public API.
