# Market value model

`node scripts/fetch-values.mjs` rebuilds `data/values.json` (about 600 KB, no dependencies, Node 18+). Each source is fetched once per run (FantasyCalc once per format, six requests, 0.5 s apart). A failed source is skipped and recorded with `ok:false`.

## Sources

| Source | Status | Notes |
|---|---|---|
| FantasyCalc `api.fantasycalc.com/values/current` | used | Six formats (1QB/SF x PPR/half/std). Match by `sleeperId`. The only source with real PPR variants. |
| Dynasty Daddy `dynasty-daddy.com/api/v1/player/all/today` | used | No Terms of Use page exists (only /privacy, which has no scraping clause). The Help Center documents a public, keyless API and asks: "Please cache responses and don't hammer the servers." robots.txt allows all. One fetch per run. Falls back to the documented `api.dynasty-daddy.com/api/v1/values/dynasty` only if the primary fails. |
| DynastyProcess `values.csv` + `db_playerids.csv` | used | Open data repo. `value_1qb` / `value_2qb`. Id via `fp_id` to `fantasypros_id` to `sleeper_id`, name+position fallback. Derived from FantasyPros ECR. |
| Sleeper projections, dynasty ADP | used | `adp_dynasty_ppr/half_ppr/std` for 1QB, `adp_dynasty_2qb` for SF. 999 means no ADP and is dropped. The brief's `adp_dd_ppr` key does not exist in the response, so only the real `adp_dynasty_*` keys are used. Unlike the other sources, the 1QB ADP follows the PPR setting. |
| KeepTradeCut | **excluded** | Terms (`/terms-and-conditions`, read 2026-10-21): "Any form of automated data collection, including but not limited to: Web scraping". Not fetched. |
| FantasyPros ECR | **excluded** | Terms (`/about/legal/`): "you may not copy, reproduce, modify, republish, upload, post, transmit, or distribute any documents" without written permission. No scraping carve-out; the output would be republished in this repo. Not fetched. robots.txt also sets Crawl-delay 5. |

DynastyProcess is used because it is an open data repo and is not FantasyPros output itself. It is the only expert-consensus voice, so there is no double counting. If FantasyPros is ever added, DynastyProcess must be down-weighted or dropped.

## Transform (value to 0-100 score)

1. **Rank-match to FantasyCalc.** For each non-FantasyCalc source and format, players (and picks, if the source has them) are ranked by the source's own value (ties share the mean rank). The player at rank r gets the FantasyCalc value at rank r in the same format. FantasyCalc keeps its raw value. For sources without picks (ADP) the reference curve excludes picks, so ranks are comparable. Deeper than FantasyCalc prices anyone (rank above 420) gets value 0.
2. **Score** = `100 * (value / top value) ^ 0.5`, value on the FantasyCalc scale.

Why: the sources use incompatible units (trade points, DP value, ADP). A monotone rank-match puts them on one scale without assuming their curve shapes are alike, and it works for ADP, which has no value at all. The 0.5 power spreads the heavy top-end tail so the 12th player scores about 73, the 100th about 41, the 300th about 16. A plain value/max would put most of the pool under 20. It loses the source's own gaps between neighbors; that is the cost of comparing scales.

## Aggregation

- Weight per source = base weight x coverage. Base: FantasyCalc 1.0, Dynasty Daddy 1.0, DynastyProcess 0.75 (ECR-derived), Sleeper ADP 0.6 (coarse draft slots). Coverage = share of FantasyCalc's players the source also prices (FC 1.00, DD 0.99, ADP 0.98, DP 0.91).
- **Weighted trimmed mean**: sort the sources by value, drop 20% of the total weight from each tail (partial weights allowed), average the rest. With 1-2 sources that trims little by design.
- `marketScore` = trimmed mean of per-source scores. `aggValue` = trimmed mean of the FantasyCalc-scale values (for trade sums). `n` = sources that priced the asset. `spread` = population stdev of the per-source scores (`null` if n < 2). `by` = per-source score (`fc`, `dd`, `dp`, `adp`).
- Assets with `marketScore` under 1 are dropped.
- PPR variants (`1qb_ppr`, `1qb_half`, `1qb_std`, `sf_*`) differ only through FantasyCalc and the 1QB ADP key. Dynasty Daddy and DynastyProcess have one value per QB setting.

## Picks

Common ids: `2027_1_early`, `2027_1_mid`, `2027_1_late`, generic `2027_1`. Seasons before the earliest FantasyCalc pick year are skipped (DynastyProcess still lists 2026 slot picks such as "2026 Pick 1.01"; they are ignored). Pick entries have `pos:"PICK"` and names like `2027 1st (Early)`. FantasyCalc and Dynasty Daddy cover early/mid/late and generic; DynastyProcess has fewer.

## Output shape

```
{generated, model, sources:[{name,ok,count,tos,rows,matched,matchRate,...}],
 formats:{"1qb_ppr":{<sleeper id | pick id>:{name,pos,marketScore,aggValue,n,spread,by,trend30}}, ...}}
```
JSON objects reorder integer-like keys, so sort by `marketScore` yourself.

## 30-day trend

`trend30` = % change of market value over 30 days, or `null`. FantasyCalc: `trend30Day` is an absolute change on the value scale, so `% = trend30Day / (value - trend30Day) * 100`. Dynasty Daddy: `(trade_value - last_month_value) / last_month_value * 100` (`sf_trade_value` and `last_month_value_sf` for Superflex). `trend30` is the mean of the sources that have one, capped to -100..+300. DynastyProcess and Sleeper ADP have no trend. Coverage on 2026-10-21: 447 of 578 assets in 1QB PPR (442-453 in the other formats), 36 of 53 picks. Percent moves on cheap players are noise, so the app shows the Rising/Falling hint (+/-10%) only for assets with aggValue 1500 or more.

## Trade consolidation discount (used by the app, not by this script)

A side's value is the power-sum `(sum v_i^p)^(1/p)` with p = 1.3. One asset is unchanged; three equal assets are worth 3^(1/1.3) = 2.3 times one, not 3.

Evidence: FantasyCalc's calculator (client code `chunk-F4CNOEUX.js`, `getValueAdjustment`, dynasty branch; robots.txt allows the page) gives the side with fewer assets a bonus. For the k = (bigger side count - smaller side count) lowest-valued assets of the bigger side, sorted ascending, bonus_i = floor(min(0.6982 * v_i, 753 + 0.23 * i)). Equal counts get none. So a 1-for-3 is fair in FantasyCalc when `star + bonus(two lowest pieces) = sum of the three`. A power-sum was fitted to this on 4000 random 2-, 3- and 4-asset packages drawn from FantasyCalc's top 200 (value above 800), minimizing squared relative error of the package's single-asset equivalent `sum - bonus`:

| Format | best p | rmse | ranked decay d (next asset x d^i) | rmse |
|---|---|---|---|---|
| 1QB PPR | 1.31 | 9.0% | 0.69 | 9.2% |
| Superflex PPR | 1.24 | 7.8% | 0.75 | 8.2% |

By package size the best p is 1.46 (2 assets), 1.32 (3), 1.27 (4) for 1QB; 1.35, 1.25, 1.21 for Superflex. Power-sum fits slightly better than ranked decay, so it is used with one pooled p = 1.3. Examples (1QB data): 6067 + 3478 + 2907 (plain sum 12452) is worth 10946 in FantasyCalc and 9756 here; 4446 + 3803 (8249) is 7496 vs 7006. The model discounts more than FantasyCalc on large packages, because FantasyCalc's bonus is capped near 753 per extra piece and a smooth curve cannot reproduce a cap. FantasyCalc also discounts only the count gap (2-for-2 gets none); here each side is discounted by its own makeup. The 7-9% rmse is the honest uncertainty on p.

## Fairness bands

gap = |A - B|, average = (A + B) / 2, pct = gap / average, on the adjusted (team-type-weighted, package-discounted) side values: under 8.5% Fair, 8.5-17% Slight edge, 17-42.5% Clear win, over 42.5% Lopsided. The cutoffs were set by the project owner, not fitted. They apply to each team type separately.

## Known limits

- Dynasty Daddy and FantasyCalc may share upstream trade data; they are treated as independent.
- The base weights are judgment calls, not fitted.
- ADP is draft position, not trade value; rookies and fresh signings can lag it.
- Rank-match scores of 0 mean "deeper than FantasyCalc's list", not "worthless".
