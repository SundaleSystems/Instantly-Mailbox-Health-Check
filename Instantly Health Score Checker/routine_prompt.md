Daily Instantly mailbox health check.

Run this one command from the repo root:

node scripts/check_mailbox_health.js

The Instantly CLI is already installed by the setup script. The script reads the INSTANTLY_API_KEY environment variable. It does all the work. It lists every mailbox, finds any with a warmup health score under 98%, and removes those mailboxes from the sender list of every active or paused campaign. Warmup stays on.

Rules:
1. Run the script once. Do not rerun it.
2. Do not run any other Instantly command that changes data. Do not pause accounts, turn off warmup, pause campaigns, or edit campaigns yourself. The script is the only thing allowed to change Instantly.
3. If the script fails before it finishes, do not try to do the job by hand with the CLI. Report the error and stop.
4. Read the report the script prints.

Finish with a short plain text summary:
1. Anything under "Skipped" or "Errors" goes first, if there is any.
2. How many mailboxes and campaigns were checked.
3. Which mailboxes are under 98% and their scores.
4. Which campaigns each one was removed from.
If nothing was under 98%, say so in one line.
