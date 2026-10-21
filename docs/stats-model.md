# Stats model (statistical half of the player score)

`node scripts/fit-stats.mjs` downloads free public data into `.cache/` (gitignored), fits the models and writes `data/stats.json`. No accounts, no paid data, no npm dependencies (ridge regression is plain JS matrix math).

## Data
- nflverse `stats_player_reg_<year>.csv` (season totals per player: PPR points, usage shares, EPA, CPOE, air yards), 2017-2025.
- nflverse `snap_counts_<year>.csv` (offensive snap % per game, averaged over games played), joined via `pfr_id`.
- dynastyprocess `db_playerids.csv`: gsis_id to sleeper_id map, birthdate (age), current team (used to drop retired players).
- Sleeper `stats/nfl/regular/<year>` was not needed.

## What is predicted
PPR points per game (PPG) in season Y+h from features in season Y, for h = 1, 2, 3, fitted separately for QB, RB, WR and TE (12 ridge models). Output projects 2026, 2027, 2028 from the 2025 season. Partial-season 2026 stats are ignored.

Sample rules: feature season needs 3+ games; target season needs 6+ games. For h = 2 and 3, a player who is gone from the league (no stats in any later season) gets a replacement-level target (15th percentile PPG at the position) so that the long models are not biased toward survivors. Rookies of the incoming class have no NFL stats and are not in the output.

## Metrics chosen and why
Per-game and share metrics are used instead of totals, because games played is among the least predictable inputs. Efficiency and TD rates are included but get small weights after ridge shrinkage, since they are noisy.
- All positions: last-year PPG and the prior year's PPG (two-year view), games played fraction (availability), age.
- QB: pass attempts per game, rushing points per game (rushing yards x0.1 + TD x6; rushing is the most reliable QB fantasy edge and persists), EPA per dropback, CPOE, yards per attempt, sack rate.
- RB: carries per game, targets per game, target share, snap %, rush EPA per carry, yards per carry, yards per target. Opportunity (touches, snaps) predicts better than efficiency.
- WR/TE: targets per game, target share, air-yards share, WOPR, snap %, receiving EPA per target, yards per target, aDOT, RACR (WR only). Target share, targets per game and WOPR are the stickiest of these.
- Not available in the free files, so not used: YPRR (needs routes), red-zone share (needs play-by-play), NGS and PFR advanced stats (NGS file naming returned 404; PFR not wired up). These are the first things to add.

## Results: holdout 2025 (models trained on feature seasons 2018 to 2024-h, target 2025)
Baseline = last year's PPG used directly. h=1 uses features from 2024 and trains on 2018-2023 features (targets through 2024).

| Pos | n | R2 model | R2 baseline | MAE model | MAE baseline |
|---|---|---|---|---|---|
| QB | 35 | 0.078 | -0.168 | 3.18 | 3.80 |
| RB | 78 | 0.677 | 0.611 | 2.62 | 2.79 |
| WR | 141 | 0.681 | 0.546 | 2.26 | 2.63 |
| TE | 84 | 0.660 | 0.528 | 1.83 | 2.10 |

h=2 and h=3 holdouts (features 2023 and 2022, target 2025) beat the baseline by a wider margin (for example WR h3 R2 0.51 vs -0.11, RB h3 0.43 vs 0.04). These include imputed replacement-level targets for departed players, so they are flattering; use them as relative evidence, not absolute accuracy. Full numbers are in `data/stats.json` under `meta.holdout`.

Caveats: QB holdout is a single noisy season with 35 players, so the 0.08 R2 should not be over-read (QB h2/h3 hold at 0.3-0.4). Ridge strength is picked by leave-one-year-out CV on the training years only.

## Age curve (fitted, not hand-set)
Each model includes age plus hinge terms at 24, 27, 29, 31, 33, so the age effect is a piecewise-linear function fitted jointly with the production and usage features. `ageCurves` in `data/stats.json` exports, per position and for h = 1, 2, 3, the effect in PPG by age (age is on Sep 1 of the feature season), plus `yearlyDeltaPPG` and `yearlyDeltaPct` (expected change in next-season PPG for being one year older, holding the other features fixed). Ages with fewer than 8 training rows are clamped, not extrapolated. The 3-year projection reads each horizon's own model, so the age decline is built into projPPG2 and projPPG3 rather than applied as a separate cliff.

Limits: the curve is conditional on the other features (a 28-year-old RB with big usage still declines, but less than his age alone suggests), and it is noisy at the edges. For example the TE curve rises at 29-30 and the RB curve is flat at 27-28 then drops about 10% per year from 29, which fits the research below but is partly sample noise. Because it is conditional on last-year PPG, young players show a mild negative delta: their growth is already in the ppg and usage terms. It can replace the hand-set cliffs as a data-driven decline estimate, but smoothing or monotone constraints would be a sensible next step.

## Output (`data/stats.json`)
- `players[sleeper_id] = {name, pos, age, projPPG1, projPPG2, projPPG3, statScoreNow, statScoreLong, components}`. Age is current (as of the run date).
- Scale: `score = 100 x Phi(z)`, where z compares the value to the mean and spread of the position's starter pool (top 12 QB, 24 RB, 36 WR, 12 TE by the same metric). 50 is an average starter; elite players approach but do not hard-cap at 100 (about 2.5+ standard deviations above the pool average gives 99+).
- `statScoreNow`: that scale applied to projPPG1.
- `statScoreLong`: that scale applied to `longPPG` = sum over k=1..3 of 0.9^(k-1) x survival_k x projPPG_k. `survival` (in each player) is P(player has 8+ games in season Y+k), a per-position logistic in age (linear plus a hinge at 30), fitted by IRLS on fantasy-relevant players (top 2x the starter pool by PPG, 6+ games) from 2018 onward. It is exported as `survivalCurves` (ages 21-38, k1..k3). Departure risk is therefore priced in twice for h>=2 (the departed-player floor in the training target, and the survival weight); that is deliberate, it keeps old players low. Survival at ages 36+ rests on very few players, so treat those points as rough. Check: Henry (RB, 32.8) longPPG 13.5, long score 2; Kelce 0.1; Rodgers 0; Allen 75; McCaffrey (30.4) 49.
- `components`: PPG contribution of each feature group in the h=1 model (`baseline`, `recentProduction`, `usage`, `efficiency`, `availability`, `age`), the raw `metrics` used, and `gamesLastSeason`.
- `ageCurves`, and `meta.holdout` (all R2/MAE numbers).
- Projections are PPG only, with no injury or availability-risk weighting beyond the games-played features. They do not use team context, depth chart, rookies, or draft capital.

## Sources
1. 4for4, The Most Predictable Wide Receiver Stats: https://www.4for4.com/2023/preseason/most-predictable-wide-receiver-stats (targets per game, WOPR and target share are stable; TD rate is not).
2. Sharp Football Analysis, Wide Receiver Stats That Matter: https://www.sharpfootballanalysis.com/fantasy/wide-receiver-stats-that-matter-fantasy-football-2024/ (year-over-year correlations: target share about 0.55, targets per game about 0.66, YPRR moderate).
3. Sharp Football Analysis, Tight End Stats That Matter: https://www.sharpfootballanalysis.com/fantasy/te-stats-that-matter-fantasy-football/
4. PFF, When do aging running backs hit the fantasy wall: https://www.pff.com/news/fantasy-football-narrative-street-when-do-aging-running-backs-hit-the-fantasy-wall (no PPG drop at 30, decline in the age-31 season).
5. ESPN, 2023 fantasy players peak and decline by position: https://africa.espn.com/ffl/story/_/id/37933720/2023-fantasy-football-players-peak-decline-quarterback-running-back-wide-receiver (RB PPR PPG about -25% from 28 to 29; mobile QBs best at 23-25).
6. Rotowire, The Stats Room: At What Age do Players Decline?: https://www.rotowire.com/football/article/the-stats-room-at-what-age-do-players-decline-29538
Sources were used to pick candidate features and sanity-check the fitted age curve; no figures are copied into the model.
