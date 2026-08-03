---
id: macos-notifications
title: macOS notifications — surface events natively from the sync client
type: feature
status: todo:backlog
parent: none
pm-tool: Airtable
functional-area: event-consumers
depends-on: [local-sync-client]
project: https://airtable.com/appnae8GXuj1rNVoQ/tblQuFDLYQGrcoiTf/recAmtlL5Goesb0p1
created: 2026-08-03
updated: 2026-08-03
branch-name: feature/macos-notifications
---

# Feature: macOS notifications — surface events natively from the sync client

## Definition

### Problem

After F2 the sync client prints events to a terminal nobody is watching. The system's actual
purpose — from the README, *"one subscriber for my phone, one for my desktop, one for my laptop"* —
is to **interrupt the user appropriately**, and stdout does not interrupt anyone.

The hard part is not calling the notification API; it is deciding *what deserves an interruption*.
The event model already carries the two fields that answer this — `eventType` (`alert` versus
`notification`) and `priority` (1–8) — but nothing consumes them yet. Get this wrong and the system
is worse than useless: a firehose of low-value notifications trains the user to dismiss the ones
that matter.

### Goals

- Surface events as **native macOS notifications** from the running sync client.
- **Interruption is earned, not automatic** — `eventType` and `priority` drive whether an event
  notifies at all, and how loudly.
- Keep the notification mechanism behind a **thin adapter**, so the underlying delivery method can
  be swapped without touching event logic — and so a Linux or phone sink can be added later.
- Never let a notification failure take down the sync loop.

### Solution summary

A notifier adapter with a single small interface, implemented for macOS. Because the delivery
options each carry real drawbacks — `toasted-notifier` is a single-maintainer CJS fork; a direct
`osascript` shell-out has no dependency but limited control; `terminal-notifier` needs a binary —
the implementation is chosen in AWE-217 behind that interface, so the choice is reversible in one
file.

The adapter is wired into the sync client as an additional **sink** (the extension point F2's
AWE-216 defines), alongside — not replacing — stdout. A filtering layer sits in front of it,
translating `eventType` + `priority` into a notify/suppress decision and a presentation level.

### Out of scope

- **Linux and Windows notification backends.** The adapter interface must not preclude them; this
  feature implements macOS only.
- **Phone or push delivery**, and any hosted notifier.
- **Acknowledging or handling from the notification** (action buttons that mutate the event) — the
  read-only stance from F2 holds.
- **Changing the event model** to add notification-specific fields. Classification uses what is
  already there.

### Acceptance criteria

- With the sync client running, a pushed `alert` produces a **native macOS notification** within one
  poll interval; stdout emission continues unchanged alongside it.
- **Filtering is config-driven and demonstrable:** an event below the configured threshold is
  logged as suppressed and produces no notification; changing the threshold requires no code change.
- `alert` and `notification` are visibly distinguishable, and priority influences presentation in a
  documented way.
- A notification-delivery failure (backend missing, permission denied, `osascript` unavailable) is
  logged and **the sync loop continues** — a broken notifier never becomes a broken consumer.
- Notification permission not yet granted produces an actionable message telling the user what to
  enable, rather than silent nothing.
- A burst of events does not produce an unbounded notification storm; the coalescing or rate-limit
  behaviour is defined and tested.
- **Architecture conformance:** the adapter receives a decoded `Event` and never an S3 key or SDK
  type; Effect throughout, per both ADRs.

## Plan

### Approach overview

Build the adapter standalone and testable first, then wire it in with the filtering policy. The
split keeps the "can we raise a macOS notification at all" question — which involves platform
quirks, permissions and a dependency choice — entirely separate from the "should we" question,
which is pure policy over `eventType` and `priority` and is unit-testable with no platform at all.

### Story decomposition

Ordered by dependency. Each is a coherent ~1hr-review increment (not a micro-PR).

1. **notifier-adapter** — the `Notifier` interface and its macOS implementation, the backend choice
   (`osascript` shell-out vs `toasted-notifier` vs `terminal-notifier`) with its rationale, the
   `Event` → notification presentation mapping, and permission/failure handling. *(AWE-217)*
2. **notification-wiring-and-filtering** — register the notifier as a sink in the sync client, the
   config-driven `eventType` + `priority` → notify/suppress/presentation policy, burst coalescing,
   and end-to-end validation from `event-push` to a visible notification. *(AWE-218)*

### Cross-story contracts

- **The `Notifier` interface is owned by AWE-217** and consumed by AWE-218; it accepts a decoded
  `Event` plus a resolved presentation level, never raw event-model internals.
- **The sink registration point is F2's** (AWE-216). If this feature needs to change that
  interface, it changes it there rather than special-casing notifications in the loop.

### Risks

- **Notification fatigue is the real failure mode.** Claude Code's `Stop` hook (F4) fires on every
  turn; without sensible defaults the desktop becomes unusable and the user disables the whole
  system. The filtering defaults matter more than the delivery code.
- **Every macOS delivery option has a drawback** — an unmaintained fork, a shell-out with limited
  control, or an external binary. The adapter interface is the mitigation; the choice must be
  recorded with its reasoning so it can be revisited without re-litigating.
- **macOS notification permissions are per-application and opaque.** A process launched from a
  terminal may inherit the terminal's permission state, so "works for me" is not evidence; the
  permission path must be tested from a clean state.
- **This feature is only valuable if F2's sink seam is right.** If AWE-216 hard-codes stdout, this
  feature becomes a refactor of F2 rather than an addition to it — flag it during F2 review.
