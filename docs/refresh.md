# Refreshing market values

Nothing is enabled by default. `data/values.json` only changes when you run one of these.

`node scripts/fetch-values.mjs` is the core. It exits 1 and keeps the old file if a required source (FantasyCalc, Dynasty Daddy) fails, fewer than 3 of 4 sources return data, FantasyCalc loses a format, or any format has under 300 entries.

## 1. Manual (default)

    node scripts/fetch-values.mjs          # rewrite data/values.json only
    bash scripts/refresh-values.sh         # fetch, then commit locally if changed. Never pushes.

Log: `.cache/refresh.log`. Push yourself when happy.

## 2. macOS launchd (daily 06:00, local commit only)

The plist uses `/Users/brandonjeppson/Code/dynasty-pretrade`. Edit the paths if the repo lives elsewhere. The Mac must be awake at 06:00 (launchd runs a missed job on wake).

Enable:

    cp scripts/launchd/com.dynasty-pretrade.refresh-values.plist ~/Library/LaunchAgents/
    launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.dynasty-pretrade.refresh-values.plist

Test now: `launchctl kickstart -k gui/$(id -u)/com.dynasty-pretrade.refresh-values`

Disable:

    launchctl bootout gui/$(id -u)/com.dynasty-pretrade.refresh-values
    rm ~/Library/LaunchAgents/com.dynasty-pretrade.refresh-values.plist

Crontab equivalent (instead of launchd; `crontab -e`):

    0 6 * * * /bin/bash /Users/brandonjeppson/Code/dynasty-pretrade/scripts/refresh-values.sh

Remove by deleting that line. Cron on macOS may need Full Disk Access for `cron`.

## 3. GitHub Action (commits and pushes)

`.github/workflows/refresh-values.yml` ships with only `workflow_dispatch` active (manual run: Actions tab, Refresh market values, Run workflow, or `gh workflow run refresh-values.yml`). Once on the default branch it can be run by hand; it pushes to that branch with `GITHUB_TOKEN`.

Enable daily schedule: uncomment the `schedule:` block (and its `cron` line) in the workflow, commit, push. Runs at 11:00 UTC.

Disable: re-comment the block, or `gh workflow disable refresh-values.yml`.

Note: this option pushes, unlike options 1 and 2. Scheduled workflows also pause after 60 days of repo inactivity.
