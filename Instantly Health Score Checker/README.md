# Instantly mailbox health routine

## What it does

Every morning at 7:00 AM a Claude Code routine runs `scripts/check_mailbox_health.js`. The script uses the Instantly CLI to pull every mailbox and its warmup health score. Any mailbox under 98% gets removed from the sender list of every active or paused campaign. Warmup is left on so the score can recover. The routine then writes a short summary in its run.

## Why it removes from campaigns instead of pausing the account

Pausing an account in Instantly stops warmup too. The health score comes from the last 7 days of warmup. With no warmup the score falls to 0 and the mailbox never recovers. Taking the mailbox off campaign sender lists keeps warmup going.

## Setup (cloud routine, runs even when your laptop is closed)

1. Push this folder to a GitHub repo.
2. Make a separate Instantly API key just for this routine at app.instantly.ai/app/settings/integrations.
3. Go to claude.ai/code/routines and click New routine.
4. Name it "Instantly mailbox health check". Paste the contents of `routine_prompt.md` into the instructions box. In the model picker, a smaller model like Sonnet or Haiku is fine. The script does the real work.
5. Pick the repo from step 1.
6. Set up the environment. Click the cloud icon under the instructions box. Click Add cloud environment, or the settings icon on an existing one. Set these:
   * Network access: Custom. Allowed domains: `api.instantly.ai`. Check "Also include default list of common package managers".
   * Environment variables: `INSTANTLY_API_KEY` = the key from step 2. Also add `DRY_RUN` = `1` for the first test run.
   * Setup script: `npm install -g instantly-cli`
7. Trigger: Schedule, Daily, 7:00 AM. Times use your local time zone.
8. Connectors: remove all of them. The routine does not need any.
9. Click Create, then Run now. Open the run and read the report. It should say DRY RUN and list what it would change.
10. If the report looks right, remove the `DRY_RUN` variable from the environment. Run it once more to confirm it makes real changes.

## Things to know

* Runs can start a few minutes after 7:00 AM.
* A green run status only means the run finished. Open the run to read the actual report.
* If every sender on a campaign is under 98%, that campaign is skipped, not emptied. The report flags it for you.
* A mailbox with warmup turned off shows a 0 score after 7 days and will get pulled. Keep warmup on for any mailbox you want in campaigns.
* Removed mailboxes are not added back on their own. When a score recovers, add it back in Instantly or ask Claude to.
* Change the cutoff with a `HEALTH_THRESHOLD` environment variable.

## Run it by hand

```
export INSTANTLY_API_KEY=your_key
DRY_RUN=1 node scripts/check_mailbox_health.js
```

Drop `DRY_RUN=1` to make real changes.

## Local option

If you would rather run it on your own computer, open the Claude Desktop app, go to the Code tab, click Routines, New routine, then Local. Use the same prompt and schedule. It only fires if the app is open and the computer is awake at 7:00 AM.
