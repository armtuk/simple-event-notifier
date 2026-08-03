---
id: AWE-218
title: Notification wiring & priority filtering policy
type: story
status: todo:backlog
parent: ./feature.md
pm-tool: Airtable
project: https://airtable.com/appnae8GXuj1rNVoQ/tblQuFDLYQGrcoiTf/recAmtlL5Goesb0p1
created: 2026-08-03
updated: 2026-08-03
---

# Story: Notification wiring & priority filtering policy

## Definition

### User story

As a user who will disable any system that notifies me too much
I want only events that genuinely warrant interruption to raise a notification, configurably
So that the notifications I do get are worth reading, and the system survives contact with a
per-turn Claude Code hook.

### Acceptance criteria

- The macOS notifier from AWE-217 is registered as a **sink** in the sync client, using the
  interface AWE-216 defines. The polling loop is **not modified** by this story — if it must be,
  that is a defect in F2's seam and is fixed there.
- stdout emission continues unchanged alongside notifications; adding the notifier does not remove
  or alter the existing sink.
- A **filtering policy** translates `eventType` + `priority` into notify / suppress, and into a
  presentation level for those that notify. It is a pure function, unit-tested with no platform
  involvement.
- **The policy is config-driven:** changing the threshold, or whether a given `source` is muted, is
  a config edit requiring no code change. The config is schema-validated and rejects unknown shapes.
- A suppressed event is **logged as suppressed** with its key and the deciding rule — silent
  suppression is indistinguishable from a bug.
- **Burst behaviour is defined and tested:** a rapid run of events does not produce an unbounded
  notification storm. Whether by coalescing, a rate limit, or a per-source cooldown, the chosen
  mechanism is documented and its dropped/merged events are logged.
- **End-to-end validation:** `event-push --type alert --priority 2 …` produces a visible macOS
  notification within one poll interval; a low-priority event below the threshold produces none, and
  a suppression log line instead.
- **A notifier failure never breaks the consumer:** with the notifier forced to fail, the sync loop
  continues and stdout emission is unaffected.
- Guidance conformance: pure policy function; `Record` lookups over branching; Effect throughout;
  config validated with effect `Schema`.

### Notes / Open questions

- **This story is where notification fatigue is won or lost.** F4's Claude Code `Stop` hook fires on
  every single turn. If the default policy lets those through, the desktop becomes unusable within
  an hour and the user turns the whole system off. The defaults matter more than the mechanism.
- **Open — default threshold.** A reasonable starting point is: `alert` notifies at any priority;
  `notification` notifies only at high priority (say 1–3); everything else is stdout-only. Needs
  confirming against what F4 and F5 actually emit, which is not known until they exist.
- **Open — burst strategy.** Coalescing ("3 new events from github") preserves information but
  needs a summary presentation; a per-source cooldown is simpler but drops detail. Cooldown is
  probably right for a system whose event rate is normally a few per minute — bursts are the
  exception.
- **Open — where the policy config lives.** It is user preference rather than system config, so it
  may belong somewhere more discoverable than the sync client's main config file.
- Depends on AWE-217 (the notifier) and AWE-216 (the sink interface).

<!-- ## Plan is filled in later by /plan-story when this story is about to be worked. -->
