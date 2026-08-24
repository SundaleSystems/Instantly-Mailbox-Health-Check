#!/usr/bin/env node
// Daily Instantly mailbox health check.
// Finds every mailbox with a warmup health score under the threshold
// and pulls it out of the sender list on every active or paused campaign.
// Warmup is left on so the score can recover.
//
// Env vars:
//   INSTANTLY_API_KEY   required, read by the Instantly CLI
//   HEALTH_THRESHOLD    optional, default 98
//   DRY_RUN=1           optional, report only, change nothing
//   INSTANTLY_BIN       optional, path to the CLI, default "instantly"

const { execFileSync } = require("child_process");

const THRESHOLD = Number(process.env.HEALTH_THRESHOLD || 98);
const DRY_RUN = process.env.DRY_RUN === "1";
const BIN = process.env.INSTANTLY_BIN || "instantly";

function cli(args) {
  const out = execFileSync(BIN, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return out.trim() ? JSON.parse(out) : null;
}

// Walks every page of a list command.
function listAll(group, extraArgs) {
  const items = [];
  let cursor = null;
  for (;;) {
    const args = [group, "list", "--limit", "100", ...(extraArgs || [])];
    if (cursor) args.push("--starting-after", cursor);
    const page = cli(args);
    const pageItems = Array.isArray(page) ? page : (page && page.items) || [];
    items.push(...pageItems);
    cursor = Array.isArray(page) ? null : page && page.next_starting_after;
    if (!cursor || pageItems.length === 0) break;
  }
  return items;
}

function lower(s) {
  return String(s || "").toLowerCase();
}

function main() {
  const report = {
    date: new Date().toISOString(),
    threshold: THRESHOLD,
    dry_run: DRY_RUN,
    accounts_checked: 0,
    unhealthy: [],
    campaigns_checked: 0,
    changes: [],
    skipped: [],
    errors: [],
  };

  // 1. Every mailbox and its health score.
  const accounts = listAll("accounts");
  report.accounts_checked = accounts.length;

  const unhealthy = accounts.filter((a) => {
    const score = Number(a.stat_warmup_score);
    return !Number.isFinite(score) || score < THRESHOLD;
  });
  const bad = new Set(unhealthy.map((a) => lower(a.email)));
  report.unhealthy = unhealthy.map((a) => ({
    email: a.email,
    score: Number.isFinite(Number(a.stat_warmup_score)) ? Number(a.stat_warmup_score) : null,
    warmup_status: a.warmup_status ?? null,
  }));

  // 2. Active (1) and paused (2) campaigns. Drafts and completed are left alone.
  const campaigns = [
    ...listAll("campaigns", ["--status", "1"]),
    ...listAll("campaigns", ["--status", "2"]),
  ];
  report.campaigns_checked = campaigns.length;

  if (bad.size === 0) {
    finish(report);
    return;
  }

  // 3. Pull bad mailboxes out of each campaign's sender list.
  for (const c of campaigns) {
    try {
      let senders = c.email_list;
      if (!Array.isArray(senders)) {
        const full = cli(["campaigns", "get", c.id]);
        senders = (full && full.email_list) || [];
      }
      const removed = senders.filter((e) => bad.has(lower(e)));
      if (removed.length === 0) continue;
      const keep = senders.filter((e) => !bad.has(lower(e)));

      if (keep.length === 0) {
        report.skipped.push({
          campaign_id: c.id,
          campaign_name: c.name,
          reason: "every sender is under threshold, campaign left unchanged so it is not emptied",
          would_remove: removed,
        });
        continue;
      }

      if (!DRY_RUN) {
        cli(["campaigns", "update", c.id, "--email-list", JSON.stringify(keep)]);
      }
      report.changes.push({
        campaign_id: c.id,
        campaign_name: c.name,
        removed,
        senders_left: keep.length,
      });
    } catch (err) {
      report.errors.push({
        campaign_id: c.id,
        campaign_name: c.name,
        error: String((err && err.stderr) || (err && err.message) || err).trim(),
      });
    }
  }

  finish(report);
}

function finish(report) {
  const lines = [];
  lines.push(`Instantly mailbox health check (${report.dry_run ? "DRY RUN" : "live"})`);
  lines.push(`Checked ${report.accounts_checked} mailboxes and ${report.campaigns_checked} active or paused campaigns.`);
  lines.push(`Threshold: ${report.threshold}%`);
  lines.push("");
  if (report.unhealthy.length === 0) {
    lines.push("All mailboxes are at or above the threshold. Nothing changed.");
  } else {
    lines.push(`${report.unhealthy.length} mailbox(es) under threshold:`);
    for (const u of report.unhealthy) {
      lines.push(`  ${u.email}  score ${u.score === null ? "none" : u.score + "%"}`);
    }
    lines.push("");
    if (report.changes.length === 0) {
      lines.push("None of them were on an active or paused campaign. Nothing changed.");
    } else {
      lines.push(`${report.dry_run ? "Would remove" : "Removed"} from campaigns:`);
      for (const ch of report.changes) {
        lines.push(`  ${ch.campaign_name} (${ch.campaign_id}): ${ch.removed.join(", ")}  [${ch.senders_left} sender(s) left]`);
      }
    }
  }
  if (report.skipped.length) {
    lines.push("");
    lines.push("Skipped (needs a human):");
    for (const s of report.skipped) {
      lines.push(`  ${s.campaign_name} (${s.campaign_id}): ${s.reason}`);
    }
  }
  if (report.errors.length) {
    lines.push("");
    lines.push("Errors:");
    for (const e of report.errors) {
      lines.push(`  ${e.campaign_name} (${e.campaign_id}): ${e.error}`);
    }
  }
  console.log(lines.join("\n"));
  console.log("");
  console.log("JSON_REPORT " + JSON.stringify(report));
  process.exitCode = report.errors.length ? 1 : 0;
}

try {
  main();
} catch (err) {
  const msg = String((err && err.stderr) || (err && err.message) || err).trim();
  console.error("Health check failed before finishing: " + msg);
  process.exitCode = 1;
}
