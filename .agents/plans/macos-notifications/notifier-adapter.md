---
id: AWE-217
title: macOS notifier adapter
type: story
status: todo:backlog
parent: ./feature.md
pm-tool: Airtable
project: https://airtable.com/appnae8GXuj1rNVoQ/tblQuFDLYQGrcoiTf/recAmtlL5Goesb0p1
created: 2026-08-03
updated: 2026-08-03
---

# Story: macOS notifier adapter

## Definition

### User story

As a user who is not staring at the sync client's terminal
I want events to raise native macOS notifications
So that the system can actually interrupt me when something needs my attention.

### Acceptance criteria

- A `Notifier` interface is defined, accepting a decoded `Event` plus a resolved presentation level,
  and returning a typed result. It is the **only** thing the rest of the system knows about
  notification delivery.
- A macOS implementation raises a real, visible native notification carrying at minimum the event's
  `source`, `name` and a priority indication.
- **The backend choice is recorded with its reasoning** — `osascript` shell-out, `toasted-notifier`,
  or `terminal-notifier` — and is contained to a single module so it can be swapped in one file.
- An `Event` → notification presentation mapping exists (title, body, and how `eventType` and
  `priority` are reflected), implemented as a lookup rather than an if/else chain.
- **Notification permission is handled explicitly:** when permission has not been granted, the
  adapter produces an actionable message naming what to enable and where, rather than failing
  silently.
- **Failure modes each return a typed failure and never throw:** backend binary missing,
  `osascript` unavailable or erroring, permission denied, and a malformed presentation payload.
- The adapter is testable without raising real notifications — a no-op or recording implementation
  of the interface exists for use in tests and by other stories.
- The interface does not preclude a future Linux, Windows or push implementation; nothing macOS-
  specific leaks into its signature.
- Guidance conformance: Effect throughout, typed error channel per ADR
  `2026-08-03-0035-effect-as-default-idiom`; `Record` lookups over branching; module SRP.

### Notes / Open questions

- **Open — which backend.** Each option has a real drawback: `toasted-notifier` is a
  single-maintainer CJS fork (a dependency risk in a project that is otherwise pure ESM);
  `osascript` needs no dependency but offers limited control over presentation and no reliable
  interaction callbacks; `terminal-notifier` is well-behaved but is an external binary the user must
  install. The interface exists precisely so this is reversible — decide in `/plan-story` and record
  the reasoning in the module.
- **`osascript` is the likely default** on dependency-minimalism grounds, given the system's whole
  premise is radical simplicity — but confirm it can express the alert-versus-notification
  distinction adequately before committing.
- **Open — sound and alert style.** Whether `alert` events should make a sound or use a persistent
  alert style rather than a transient banner. This is what makes the alert/notification distinction
  actually felt, so it is worth getting right.
- **Permission testing is a trap.** A process launched from a terminal may inherit the terminal
  application's notification permission, so "it worked on my machine" proves nothing. Test from a
  clean permission state.
- Depends on F1's `event-model` for the `Event` shape. Does **not** depend on the sync client —
  this story is standalone and testable in isolation; AWE-218 does the wiring.

<!-- ## Plan is filled in later by /plan-story when this story is about to be worked. -->
