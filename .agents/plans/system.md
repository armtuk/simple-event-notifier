---
id: aws-work-eventer
title: AWS Work Eventer — an S3-backed personal event bus
type: system
status: living
created: 2026-06-28
updated: 2026-06-28
---

# System: AWS Work Eventer

## Vision

A radically simple personal eventing system that replaces bespoke distributed-eventing
infrastructure with **an S3 bucket as the event log**. Because the real event rate is tiny
(a few per second at peak, usually a few per minute), the heavy machinery of a custom event
server and client fleet is unnecessary: every event is a single JSON object written to S3,
named so it sorts naturally by time, and the bucket itself becomes both the live feed and a
permanent, queryable history.

The durable goal is a low-cost, low-maintenance way to **collect notifications and alerts
from the systems the user works with** (GitHub, Slack, LLM agents, email, calendar,
incidents, ticketing, …), normalise them into one small event model, and let any number of
independent clients — phone, desktop, laptop, servers — catch up on what happened, with
events carrying enough structure (priority, type, acknowledged/handled flags, work-item
link) to drive a real triage workflow rather than just a notification stream.

## Scope boundary

**In this repo:**

- **The canonical event model** — the JSON shape and the `{timestamp}.{type}.{priority}.{source}.{name}.json`
  object-key scheme. This is the central contract every producer and consumer depends on.
- **Infrastructure-as-Code** for the AWS substrate: the S3 event bucket, plus the
  bucket-change → notification → fan-out path with a TTL catch-up window and multiple
  durable per-client subscribers.
- **The webhook ingest function** — an API-Gateway-fronted Lambda that receives third-party
  webhooks, classifies them from payload/headers, wraps them into the event model, and
  writes the object to S3.
- **Persistent client service(s)** for sources that require a long-lived connection rather
  than a webhook, deployed as a container to a cheap host (Railway).
- **The Event UI** — a lightweight web app (also on Railway) for viewing, acknowledging, and
  handling events.

**Out of scope / cross-cutting (not owned here):**

- The **third-party source systems themselves** (GitHub, Slack, email, calendar, Jira,
  incident tooling). This system only *consumes* their webhooks/APIs; their configuration
  lives in those systems.
- The **ticketing/work-item systems** referenced by an event's `workItem` link and their
  internal workflows.
- The **AWS account, credentials, and DNS** provisioning that the IaC assumes already exists.
- The **LLM agent tooling** that emits agent events — it is just another producer that posts
  to the ingest endpoint; its own code lives wherever the agents do.
- **PM / project tracking** — cross-cutting initiative membership lives in the PM tool
  (Airtable for personal projects), never on the filesystem.

## Key cross-cutting context

- **The event model is the load-bearing contract.** Both producers (ingest Lambda, agents,
  persistent clients) and consumers (UI, device clients, naive `aws s3 sync` cron) couple to
  the JSON shape and the object-key naming scheme. Changing it ripples everywhere; treat it
  as a versioned interface.
- **S3 is the source of record**, not a cache. The append-only object set is simultaneously
  the live feed and the permanent history — there is no separate database.
- **Fan-out is catch-up oriented, not real-time-guaranteed.** Clients may be offline; the
  notification pipe carries a TTL sized to let a client catch up roughly a couple of days,
  and never more than ~a week (a few hundred events at most).
- **Event semantics:** `eventType` is `alert` (needs attention) or `notification` (info);
  `priority` is 1–8; `acknowledged` and `handled` are independent boolean flags a client can
  flip to drive triage.
- **First sources to support:** GitHub and LLM agents (Claude Code hooks). **Slack is shelved
  as of 2026-07-19** — ingesting Slack requires creating an internal Slack **App**, and there is
  no personal-token-only fallback; the `slack-integration` feature is `Abandoned` pending
  workspace permissions and would be re-planned as a new feature if they are granted. The broader
  source list (email, calendar, package delivery, incident pages, Jira, Airtable, Confluence)
  is the roadmap, not the first cut.

## Functional areas

The durable component areas of the system. An area **never completes** — it accretes features
over the system's life. Each feature's `functional-area:` frontmatter points back to a row here;
the link is bidirectional and must be kept so.

| Area | Features | Capability it owns |
| :--- | :--- | :--- |
| `platform-foundation` | `bootstrap-and-iac` | The monorepo and shared tooling, the canonical **event model** (JSON shape + object-key codec), and the AWS substrate — S3 event bucket, delegated Route53 zone, Terraform remote state. Everything else depends on this. |
| `event-sources` | `github-integration`, `claude-code-integration`, `slack-integration` *(abandoned)* | Per-source ingestion: the reusable integration template, provider payload schemas, mapping configs, normalizers, and the deployed pathways events arrive through (webhook ingest, pollers, persistent clients). |
| `producer-tooling` | `event-push-cli` | Local, infra-free ways to **push** events into the bucket — the CLI and shell wrapper used by cron jobs, git hooks, CI steps, and ad-hoc scripts, and the practical validation instrument for the bucket and consumers. |
| `event-consumers` | _none yet_ | Reading the bucket and acting on it: desktop/device notifiers, the Event UI, and the acknowledge/handle triage workflow. Currently exists only as the `desktop-notifier-daemon` story inside `bootstrap-and-iac`; the Event UI is roadmap. |

## Links

- PM initiative: [AWS Work Eventer (Airtable, client: Self)](https://airtable.com/appnae8GXuj1rNVoQ/tblQuFDLYQGrcoiTf/recAmtlL5Goesb0p1) — ticket prefix `AWE`
- Related repos: _none yet (the prior, abandoned complex eventing design is superseded by this)_
