#!/usr/bin/env node
// Daily Instantly mailbox health check.
//
// Finds every mailbox with a warmup health score under the threshold and
// stops it from sending on every active or paused campaign. Warmup is left
// on so the score can recover.
//
// A campaign can pick its senders two ways, and this script handles both:
//   1. A plain list of mailboxes (the campaign's email_list field).
//      The mailbox is taken out of that list.
//   2. A tag (the campaign's email_tag_list field). Every mailbox carrying
//      the tag is a sender. The tag is removed from the mailbox, so it drops
//      out of every campaign that uses that tag.
//
// Most calls go through the Instantly CLI. Two things use the Instantly API
// directly, because the CLI (v0.1.22) cannot do them: listing the mailboxes
// that carry a tag, and removing a tag from a mailbox.
//
// Env vars:
//   INSTANTLY_API_KEY   required, used by the CLI and the direct API calls
//   HEALTH_THRESHOLD    optional, default 98
//   DRY_RUN=1           optional, report only, change nothing
//   INSTANTLY_BIN       optional, path to the CLI, default "instantly"

const { execFileSync } = require("child_process");

const THRESHOLD = Number(process.env.HEALTH_THRESHOLD || 98);
const DRY_RUN = process.env.DRY_RUN === "1";
const BIN = process.env.INSTANTLY_BIN || "instantly";
const API_BASE = process.env.INSTANTLY_API_BASE || "https://api.instantly.ai/api/v2";

// ---------- Instantly CLI ----------

function cli(args) {
  const out = execFileSync(BIN, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return out.trim() ? JSON.parse(out) : null;
}

// Walks every page of a CLI list command.
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

// ---------- Direct Instantly API (only where the CLI falls short) ----------

async function api(method, path, opts) {
  const key = process.env.INSTANTLY_API_KEY;
  if (!key) throw new Error("INSTANTLY_API_KEY is not set");
  const url = new URL(API_BASE + path);
  for (const [k, v] of Object.entries((opts && opts.query) || {})) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method,
    headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
    body: opts && opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} returned ${res.status}: ${text.slice(0, 300)}`);
  return text.trim() ? JSON.parse(text) : null;
}

// Every mailbox that carries a tag.
async function accountsWithTag(tagId) {
  const items = [];
  let cursor = null;
  for (;;) {
    const query = { limit: 100, tag_ids: tagId };
    if (cursor) query.starting_after = cursor;
    const page = await api("GET", "/accounts", { query });
    const pageItems = (page && page.items) || [];
    items.push(...pageItems);
    cursor = page && page.next_starting_after;
    if (!cursor || pageItems.length === 0) break;
  }
  return items;
}

async function untag(tagId, resourceIds) {
  await api("POST", "/custom-tags/toggle-resource", {
    body: { tag_ids: [tagId], resource_type: 1, resource_ids: resourceIds, assign: false },
  });
}

// ---------- helpers ----------

function lower(s) {
  return String(s || "").toLowerCase();
}

function scoreOf(account) {
  const n = Number(account.stat_warmup_score);
  return Number.isFinite(n) ? n : null;
}

function isUnhealthy(account) {
  const s = scoreOf(account);
  return s === null || s < THRESHOLD;
}

// Returns the campaign with email_list and email_tag_list filled in.
function fullCampaign(c) {
  if (Array.isArray(c.email_list) && Array.isArray(c.email_tag_list)) return c;
  const full = cli(["campaigns", "get", c.id]) || {};
  return {
    ...c,
    email_list: Array.isArray(full.email_list) ? full.email_list : Array.isArray(c.email_list) ? c.email_list : [],
    email_tag_list: Array.isArray(full.email_tag_list) ? full.email_tag_list : Array.isArray(c.email_tag_list) ? c.email_tag_list : [],
  };
}

function tagLabels(tagIds) {
  const labels = {};
  if (tagIds.length === 0) return labels;
  try {
    const tags = listAll("custom-tags", ["--tag-ids", tagIds.join(",")]);
    for (const t of tags) if (t && t.id) labels[t.id] = t.label || t.id;
  } catch (_) {
    // labels are only for the report
  }
  return labels;
}

// ---------- main ----------

async function main() {
  const report = {
    date: new Date().toISOString(),
    threshold: THRESHOLD,
    dry_run: DRY_RUN,
    accounts_checked: 0,
    unhealthy: [],
    campaigns_checked: 0,
    list_changes: [],
    tag_changes: [],
    skipped: [],
    errors: [],
  };

  // 1. Every mailbox and its health score.
  const accounts = listAll("accounts");
  report.accounts_checked = accounts.length;
  const unhealthy = accounts.filter(isUnhealthy);
  const bad = new Set(unhealthy.map((a) => lower(a.email)));
  report.unhealthy = unhealthy.map((a) => ({
    email: a.email,
    score: scoreOf(a),
    warmup_status: a.warmup_status ?? null,
  }));

  // 2. Active (1) and paused (2) campaigns. Drafts and completed ones are left alone.
  const campaigns = [
    ...listAll("campaigns", ["--status", "1"]),
    ...listAll("campaigns", ["--status", "2"]),
  ].map(fullCampaign);
  report.campaigns_checked = campaigns.length;

  if (bad.size === 0) {
    finish(report);
    return;
  }

  // 3a. Campaigns with a plain sender list.
  for (const c of campaigns) {
    try {
      const senders = c.email_list;
      const removed = senders.filter((e) => bad.has(lower(e)));
      if (removed.length === 0) continue;
      const keep = senders.filter((e) => !bad.has(lower(e)));
      if (keep.length === 0 && c.email_tag_list.length === 0) {
        report.skipped.push({
          what: `campaign ${c.name} (${c.id})`,
          reason: "every sender is under threshold, left unchanged so the campaign is not emptied",
          would_remove: removed,
        });
        continue;
      }
      if (!DRY_RUN) cli(["campaigns", "update", c.id, "--email-list", JSON.stringify(keep)]);
      report.list_changes.push({ campaign_id: c.id, campaign_name: c.name, removed, senders_left: keep.length });
    } catch (err) {
      report.errors.push({ what: `campaign ${c.name} (${c.id})`, error: errText(err) });
    }
  }

  // 3b. Campaigns that pick senders by tag.
  const tagCampaigns = new Map();
  for (const c of campaigns) {
    for (const t of c.email_tag_list) {
      if (!tagCampaigns.has(t)) tagCampaigns.set(t, []);
      tagCampaigns.get(t).push(c.name);
    }
  }
  const labels = tagLabels([...tagCampaigns.keys()]);

  for (const [tagId, campaignNames] of tagCampaigns) {
    const label = labels[tagId] || tagId;
    try {
      const members = await accountsWithTag(tagId);
      const badMembers = members.filter((a) => bad.has(lower(a.email)));
      if (badMembers.length === 0) continue;
      if (badMembers.length === members.length) {
        report.skipped.push({
          what: `tag "${label}" (used by: ${campaignNames.join(", ")})`,
          reason: "every mailbox with this tag is under threshold, left unchanged so the campaigns are not emptied",
          would_remove: badMembers.map((a) => a.email),
        });
        continue;
      }
      const removed = badMembers.map((a) => a.email);
      if (!DRY_RUN) {
        // First try: the mailbox email is the resource id.
        await untag(tagId, removed);
        let still = (await accountsWithTag(tagId)).filter((a) => bad.has(lower(a.email)));
        if (still.length) {
          // Second try: look up the exact resource ids Instantly stores for these mailboxes.
          const ids = resourceIdsFor(tagId, still);
          if (ids.length) {
            await untag(tagId, ids);
            still = (await accountsWithTag(tagId)).filter((a) => bad.has(lower(a.email)));
          }
        }
        if (still.length) {
          report.errors.push({
            what: `tag "${label}"`,
            error: "tag is still on: " + still.map((a) => a.email).join(", ") + ". Remove it by hand in Instantly.",
          });
        }
      }
      report.tag_changes.push({
        tag_id: tagId,
        tag_label: label,
        campaigns: campaignNames,
        removed,
        mailboxes_left: members.length - badMembers.length,
      });
    } catch (err) {
      report.errors.push({ what: `tag "${label}"`, error: errText(err) });
    }
  }

  finish(report);
}

// The resource ids Instantly stores for these mailboxes on this tag.
function resourceIdsFor(tagId, members) {
  const candidates = [];
  for (const m of members) {
    if (m.id) candidates.push(String(m.id));
    candidates.push(m.email);
  }
  try {
    const mappings = listAll("custom-tag-mappings", ["--resource-ids", candidates.join(",")]);
    const ids = mappings
      .filter((m) => m && m.tag_id === tagId && (m.resource_type == null || Number(m.resource_type) === 1))
      .map((m) => String(m.resource_id));
    return [...new Set(ids)];
  } catch (_) {
    return [];
  }
}

function errText(err) {
  return String((err && err.stderr) || (err && err.message) || err).trim();
}

function finish(report) {
  const L = [];
  const verb = report.dry_run ? "Would remove" : "Removed";
  L.push(`Instantly mailbox health check (${report.dry_run ? "DRY RUN" : "live"})`);
  L.push(`Checked ${report.accounts_checked} mailboxes and ${report.campaigns_checked} active or paused campaigns.`);
  L.push(`Threshold: ${report.threshold}%`);
  L.push("");
  if (report.unhealthy.length === 0) {
    L.push("All mailboxes are at or above the threshold. Nothing changed.");
  } else {
    L.push(`${report.unhealthy.length} mailbox(es) under threshold:`);
    for (const u of report.unhealthy) L.push(`  ${u.email}  score ${u.score === null ? "none" : u.score + "%"}`);
    L.push("");
    if (report.list_changes.length === 0 && report.tag_changes.length === 0) {
      L.push("None of them were sending on an active or paused campaign. Nothing changed.");
    }
    if (report.list_changes.length) {
      L.push(`${verb} from campaign sender lists:`);
      for (const ch of report.list_changes) {
        L.push(`  ${ch.campaign_name} (${ch.campaign_id}): ${ch.removed.join(", ")}  [${ch.senders_left} sender(s) left]`);
      }
    }
    if (report.tag_changes.length) {
      L.push(`${verb} sender tags:`);
      for (const ch of report.tag_changes) {
        L.push(`  tag "${ch.tag_label}" (used by: ${ch.campaigns.join(", ")}): ${ch.removed.join(", ")}  [${ch.mailboxes_left} mailbox(es) still tagged]`);
      }
    }
  }
  if (report.skipped.length) {
    L.push("");
    L.push("Skipped (needs a human):");
    for (const s of report.skipped) L.push(`  ${s.what}: ${s.reason}`);
  }
  if (report.errors.length) {
    L.push("");
    L.push("Errors:");
    for (const e of report.errors) L.push(`  ${e.what}: ${e.error}`);
  }
  console.log(L.join("\n"));
  console.log("");
  console.log("JSON_REPORT " + JSON.stringify(report));
  process.exitCode = report.errors.length ? 1 : 0;
}

main().catch((err) => {
  console.error("Health check failed before finishing: " + errText(err));
  process.exitCode = 1;
});
