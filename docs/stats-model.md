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
- QB: pass attempts per game, rushing points per game (rushing yards x0.1 + TD x6; rushing is the most reliable QB fantasy edge and persists), EPA per dropback, CPOE, yards per attempt, sack rate. Added 2026-10-21: dropbacks per game, carries per game, rushing share (QB carries / team carries), and team context from nflverse `stats_team_reg_<year>.csv` (team pass attempts per game, team EPA per play, team offensive TDs per game).
- RB: carries per game, targets per game, target share, snap %, rush EPA per carry, yards per carry, yards per target. Opportunity (touches, snaps) predicts better than efficiency.
- WR/TE: targets per game, target share, air-yards share, WOPR, snap %, receiving EPA per target, yards per target, aDOT, RACR (WR only). Target share, targets per game and WOPR are the stickiest of these.
- Not available in the free files, so not used: YPRR (needs routes), red-zone share (needs play-by-play), NGS and PFR advanced stats (NGS file naming returned 404; PFR not wired up). These are the first things to add.

## Results: holdout 2025 (models trained on feature seasons 2018 to 2024-h, target 2025)
Baseline = last year's PPG used directly. h=1 uses features from 2024 and trains on 2018-2023 features (targets through 2024).

| Pos | n | R2 model | R2 baseline | MAE model | MAE baseline |
|---|---|---|---|---|---|
| QB | 35 | 0.145 | -0.168 | 3.05 | 3.80 |
| RB | 78 | 0.677 | 0.611 | 2.62 | 2.79 |
| WR | 141 | 0.681 | 0.546 | 2.26 | 2.63 |
| TE | 84 | 0.660 | 0.528 | 1.83 | 2.10 |

h=2 and h=3 holdouts (features 2023 and 2022, target 2025) beat the baseline by a wider margin (for example WR h3 R2 0.51 vs -0.11, RB h3 0.43 vs 0.04). These include imputed replacement-level targets for departed players, so they are flattering; use them as relative evidence, not absolute accuracy. Full numbers are in `data/stats.json` under `meta.holdout`.

Caveats: QB holdout is a single noisy season with 35 players (QB h2/h3 now 0.44/0.32).

QB rework (2026-10-21). Old features gave 2025 h=1 R2 0.078; with rushing share, volume and team context it is 0.145 (MAE 3.18 to 3.05). Rolling check with the same code and `HOLD_YEAR=<y> node scripts/fit-stats.mjs` (h=1, about 35 QBs each), old to new: 2022 0.362 to 0.397, 2023 0.210 to 0.229, 2024 0.528 to 0.544, 2025 0.078 to 0.145. The new features win every year, but 2025 is still under the 0.25 bar, so `meta.confidence.QB = "low"` and the UI tags QB stat scores Low confidence. Why QBs are hard: the starter pool is small, and next-season PPG turns on injuries, benchings and team changes that season stats cannot see. Top-of-pool scores are sensitive: Lamar Jackson's projection moved 18.0 to 17.3 PPG and his now score 53 to 29 because the pool is tight. Ridge strength is picked by leave-one-year-out CV on the training years only.

## Age curve (fitted, not hand-set)
Each model includes age plus hinge terms at 24, 27, 29, 31, 33, so the age effect is a piecewise-linear function fitted jointly with the production and usage features. `ageCurves` in `data/stats.json` exports, per position and for h = 1, 2, 3, the effect in PPG by age (age is on Sep 1 of the feature season), plus `yearlyDeltaPPG` and `yearlyDeltaPct` (expected change in next-season PPG for being one year older, holding the other features fixed). Ages with fewer than 8 training rows are clamped, not extrapolated. The 3-year projection reads each horizon's own model, so the age decline is built into projPPG2 and projPPG3 rather than applied as a separate cliff.

Limits: the curve is conditional on the other features (a 28-year-old RB with big usage still declines, but less than his age alone suggests), and it is noisy at the edges. For example the TE curve rises at 29-30 and the RB curve is flat at 27-28 then drops about 10% per year from 29, which fits the research below but is partly sample noise. Because it is conditional on last-year PPG, young players show a mild negative delta: their growth is already in the ppg and usage terms. It can replace the hand-set cliffs as a data-driven decline estimate, but smoothing or monotone constraints would be a sensible next step.

## Output (`data/stats.json`)
- `players[sleeper_id] = {name, pos, age, projPPG1, projPPG2, projPPG3, statScoreNow, statScoreLong, components}`. Age is current (as of the run date).
- Scale: `score = 100 x Phi(z)`, where z compares the value to the mean and spread of the position's starter pool (top 12 QB, 24 RB, 36 WR, 12 TE by the same metric). 50 is an average starter; elite players approach but do not hard-cap at 100 (about 2.5+ standard deviations above the pool average gives 99+).
- `statScoreNow`: that scale applied to projPPG1.
- `statScoreLong`: that scale applied to `longPPG` = availability x sum over k=1..3 of 0.9^(k-1) x expPPG_k (see "Cliff hazard and availability" below). The old survival (P of 8+ games in Y+k) mixed injuries and benchings with age decline and was too flat against published age-hazard tables; it is replaced.
- `survival[k-1]` = P(no cliff in the next k seasons) = product of (1 - `cliffHazard`). `cliffHazard[k-1]` = annual hazard at age+k-1. `availability` = expected games-played fraction. Also per player: `projPPGNoCliff` (PPG if no cliff, from separate ridge models) and `expPPG`. `projPPG1/2/3` are unchanged (the original ridge projections, still what the UI shows).

## Cliff hazard and availability
Split into two parts so that injuries no longer look like aging.

**Cliff hazard h(pos, age)** = P(career cliff next season). Cliff = next-season PPG below 60% of this season's PPG, or the player is out of the league (no row in any later season, confirmed by one extra year of data).
- Sample: fantasy-relevant players (top 2x the starter pool by PPG, 6+ games), feature seasons 2018-2024. Rows are excluded when ambiguous: next season played under 6 games, a missed year followed by a return, or an absence in the last data year. Rows: QB 147, RB 296, WR 464, TE 158; observed cliff rates 4%, 22%, 20%, 22%.
- Empirical fit: logistic in age with a slope below 26 and hinges at 26 and 30 (IRLS plus light ridge), forced monotone non-decreasing from 26 up. It is noisy at old ages (RB 32+ has under 10 rows).
- Prior: the published Harstad age-hazard table (QB/RB/WR/TE at 24, 26, 27, 30, 32, 33, 34; linear between, last slope continued past 34, capped 0.97, flat below 24).
- Blend (empirical-Bayes shrink): h = w x fit + (1 - w) x Harstad, w = n/(n + K). n = local sample size at that age (triangular kernel, +-2 years), K = 50 prior pseudo-observations. K was chosen by rolling-origin log-loss (fit on feature years before t, score year t, t = 2021-2024, all positions): K=0 (fit only) 0.464, 10 0.451, 25 0.448, **50 0.446**, 100 0.447, 500 0.452, infinity (Harstad only) 0.455. The blend beats both extremes. Where data are plentiful (WR/RB at 23-28) w is 0.5-0.7; at 32+ it is 0.04-0.3 and the Harstad shape dominates. The blend is re-forced monotone from 26.
- Result (blended hazard, fit-only and Harstad in `cliffCurves`):

| Age | QB fit / H / blend | RB | WR | TE |
|---|---|---|---|---|
| 24 | .019 / .010 / .013 | .157 / .070 / .128 | .149 / .070 / .126 | .178 / .110 / .136 |
| 27 | .057 / .020 / .032 | .282 / .150 / .221 | .211 / .140 / .187 | .193 / .170 / .179 |
| 30 | .057 / .050 / .052 | .414 / .330 / .353 | .262 / .240 / .250 | .193 / .230 / .219 |
| 32 | .057 / .085 / .079 | .521 / .550 / .547 | .379 / .330 / .344 | .303 / .270 / .277 |
| 34 | .057 / .140 / .125 | .627 / .900 / .888 | .513 / .440 / .451 | .461 / .350 / .369 |

Data are higher than Harstad for young RB/WR (24: 15-16% vs 7%) because the 60%-of-prior-PPG rule also catches lost jobs and mid-career role changes; the blend splits the difference. The QB fit is flat after 26 (6 cliffs in 147 rows), so the QB blend after 30 is mostly Harstad.

**Availability a(pos)** = expected share of 17 games played, among fantasy-relevant players still in the league. Miss rate = 1 - games/17. Baseline = miss rate after a season with 10+ games: QB 21.6%, RB 24.8%, WR 22.2%, TE 23.8% (availability 0.78/0.75/0.78/0.76). Multiplied by 1.33 if the player missed 8+ games last year (spec value; the data say QB 2.45 on 17 rows, RB 1.51, WR 1.59, TE 1.06 on 13, so 1.33 is mid-range, not fitted). Age uplift on the miss rate: RB 29+ and TE 32+, shrunk empirical ratio toward a 1.15 judgment prior (RB raw 1.15 on 24 rows, used 1.15; TE raw 0.99 on 13 rows, used 1.10). The same `availability` scales all three years. Full numbers in `data/stats.json` under `availability`.

**Projection**
- `projPPGNoCliff_k`: ridge models with the same features as the main ones, trained only on players who never cliffed on the way to Y+k (each season 6+ games and PPG at least 60% of the previous one). No imputed departure floor here, because the cliff probability is carried by survival instead, so departure risk is no longer priced twice.
- `expPPG_k = S_k x PPGnoCliff_k + (1 - S_k) x 0.5 x PPGnoCliff_k`. Applied for k = 1, 2, 3 (the spec named k = 2 and 3; k = 1 is included because the h=1 model's targets need 6+ games and so carry no departure risk).
- `longPPG = availability x sum_k 0.9^(k-1) x expPPG_k`. `statScoreLong = 100 x Phi(z)` against the top-N pool by longPPG, as before.
- The holdout metrics below are for the unchanged `projPPG` models and did not move.
- Checks (long score before to after): Henry (RB 32.8) 2.3 to 2.5, survival 0.711/0.382/0.114 to 0.488/0.174/0.031; McCaffrey 49.2 to 43.0; Kelce 0.1 to 2.1; Josh Allen 75.5 to 98.4 (QB survival 0.78/0.72/0.68 to 0.95/0.90/0.84); Gibbs 98.9 to 98.7.
- Limits: the "0.5 x" cliff share is a constant, not fitted. Age is on Sep 1 of the feature season for both the fit and Harstad lookups; Harstad's own age convention may differ by up to a year. Hazards at 35+ are essentially the prior.
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
