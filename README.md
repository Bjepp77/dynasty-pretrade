# Dynasty Pre-Trade Analyzer

Dynasty (not redraft) fantasy football tool. Pick a player and see which kind of team he is worth the most to (Contender, Retooler, Rebuilder), with a tag such as "Buy for contenders", "Sell before cliff", "Rebuilder stash" or "Hold". Trade mode compares two sides (players and draft picks) and gives a verdict per team type.

## Features
- Player search with autocomplete; Enter picks the first suggestion (player search and both trade inputs).
- League format toggle in the header: 1QB or Superflex, and PPR, half PPR or standard. Changing it refetches FantasyCalc values and recomputes PPG with the matching Sleeper points field. The choice is remembered in localStorage.
- Draft picks in trade mode, searchable like players (for example "2027 1st").
- Elite players get the "Core asset (any team)" badge instead of an archetype.

## Run
```
cd ~/Code/dynasty-pretrade
python3 -m http.server 8787
# open http://localhost:8787
```
No build step, no API keys. Test the scoring in the terminal: `node test.js "Josh Allen" "Derrick Henry"`. Other formats: `QBS=2 PPR=0.5 node test.js`. The test also prints the Core assets, a player-for-pick trade and a fallback-pick build.

## Data (all verified live, client-side fetch)
- Sleeper players `api.sleeper.app/v1/players/nfl`: team, age, injury, depth chart. Filtered to active QB/RB/WR/TE on a team.
- FantasyCalc dynasty and redraft values (`numQbs` 1 or 2, 12 teams, `ppr` 1, 0.5 or 0), matched by `sleeperId`. About 400 players have values, so the search covers those.
- Draft picks: FantasyCalc rows with position `PICK` (as of 2026-10-21: 2027 1st-4th as generic plus Early/Mid/Late, and generic 2028 and 2029 1st-4th; 2026 picks are gone because that draft is done). If the response has no picks, a fallback table in `scoring.js` (`PICK_FALLBACK`, a 1QB PPR snapshot) is used, and the status line says "picks: fallback table".
- Sleeper stats `stats/nfl/regular/2025` (PPG = pts_ppr, pts_half_ppr or pts_std / gp, matching the scoring setting). Falls back to 2024 if 2025 is empty.
- Strength of schedule: **demo estimate**, hand-set in `data/sos.js`. It is not live data.
- Results are cached in localStorage for the day: one slimmed Sleeper entry plus one slimmed values entry per format. Older days' entries are removed on load; storage failures are ignored.

## Scoring (every number is shown as a bar in the UI)
Each factor is 0-100.
- **Age runway**: position curve. RB peak 22-25, cliff 27. WR peak 23-27, decline 29, cliff 31. TE peak 25-29, cliff 31. QB peak 25-32, decline 34, cliff 36. "Years to cliff" = cliff age minus age.
- **Health**: 60% games played last season (out of 17) plus a base, minus an injury-status penalty (Out/IR/PUP/Doubtful/Questionable).
- **Production**: PPG percentile within position (needs 4+ games).
- **Situation**: 40% depth chart order, 30% team passing-offense percentile (sum of dynasty value of the team's QB/WR/TE), 30% target competition (teammates at the same position with higher value).
- **Schedule**: SOS rank to 0-100 (demo estimate).
- **Value**: FantasyCalc dynasty value relative to the top player. **Future premium**: (dynasty - redraft) / dynasty.

WinNow = 0.35 Production + 0.20 Health + 0.20 Situation + 0.10 SOS + 0.10 Value + 0.05 Age.
LongTerm = 0.35 Age + 0.25 Future premium + 0.25 Value + 0.10 Health + 0.05 Situation.

Archetype: WinNow minus LongTerm above 10 = Contender, below -10 = Rebuilder, otherwise Retooler. Tag: within 1.5 years of the cliff and still productive = "Sell before cliff". Both scores 75+ and balanced = "Buy for anyone (core hold)". Both scores 85+ = archetype "Core asset (any team)", whatever the gap (in 1QB PPR on 2026-10-21 that is Gibbs, Bijan Robinson and McBride).

## Trade mode
Each player's dynasty value is scaled by `0.5 + fit/100`, where fit is WinNow (Contender), LongTerm (Rebuilder) or their average (Retooler). A draft pick uses a fixed fit (Contender 25, Retooler 55, Rebuilder 90) because it adds nothing to this season's lineup. Its value is the FantasyCalc pick value. The side with the higher scaled total is "better for" that team type. Raw dynasty totals are shown too.

## Known estimates (not live, not fitted)
- **Strength of schedule** (`data/sos.js`) is a hand-set demo table. It is not live data and carries 10% of WinNow.
- **Age curves and cliff ages** (`AGE_CURVE` in `scoring.js`) are hand-set rules of thumb, not fitted to historical data.
- **Pick fit** (25/55/90) and the **fallback pick table** are hand-set.

## Known limits
12-team leagues only. PPG uses last season's stats, so rookies and injured players score low on production. Picks have no per-year discount beyond what FantasyCalc prices in.
