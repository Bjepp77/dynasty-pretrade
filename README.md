# Dynasty Pre-Trade Analyzer

Dynasty (not redraft) fantasy football tool. Pick a player and see which kind of team he is worth the most to (Contender, Retooler, Rebuilder), with a tag such as "Buy for contenders", "Sell before cliff", "Rebuilder stash" or "Hold". Trade mode compares two sides and gives a verdict per team type.

## Run
```
cd ~/Code/dynasty-pretrade
python3 -m http.server 8787
# open http://localhost:8787
```
No build step, no API keys. Test the scoring in the terminal: `node test.js "Josh Allen" "Derrick Henry"`.

## Data (all verified live, client-side fetch)
- Sleeper players `api.sleeper.app/v1/players/nfl`: team, age, injury, depth chart. Filtered to active QB/RB/WR/TE on a team.
- FantasyCalc dynasty and redraft values (1 QB, 12 teams, PPR), matched by `sleeperId`. About 400 players have values, so the search covers those.
- Sleeper stats `stats/nfl/regular/2025` (PPG = pts_ppr / gp). Falls back to 2024 if 2025 is empty.
- Strength of schedule: **demo estimate**, hand-set in `data/sos.js`. It is not live data.
- Results are cached in localStorage for the day (slimmed; failures are ignored).

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

Archetype: WinNow minus LongTerm above 10 = Contender, below -10 = Rebuilder, otherwise Retooler. Tag: within 1.5 years of the cliff and still productive = "Sell before cliff". Both scores 75+ and balanced = "Buy for anyone (core hold)".

## Trade mode
Each player's dynasty value is scaled by `0.5 + fit/100`, where fit is WinNow (Contender), LongTerm (Rebuilder) or their average (Retooler). The side with the higher scaled total is "better for" that team type. Raw dynasty totals are shown too.

## Known limits
SOS is fake. No draft picks in trades. 1-QB, 12-team, PPR settings only. Cliff ages are rules of thumb, not fitted models. The browser UI was not clicked through by an automated browser during the build; scoring was tested in node on real data.
