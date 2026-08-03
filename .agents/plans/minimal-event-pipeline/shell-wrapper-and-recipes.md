---
id: AWE-214
title: Shell wrapper, $PATH install & push recipes
type: story
status: todo:backlog
parent: ./feature.md
pm-tool: Airtable
project: https://airtable.com/appnae8GXuj1rNVoQ/tblQuFDLYQGrcoiTf/recAmtlL5Goesb0p1
created: 2026-08-03
updated: 2026-08-03
---

# Story: Shell wrapper, `$PATH` install & push recipes

## Definition

### User story

As someone wiring a cron job, git hook, or CI step on one of my machines
I want a plain `event-push` command available from any directory, plus copy-paste recipes
So that pushing an event is a one-line shell change rather than a Node invocation I have to
remember the resolution rules for.

### Acceptance criteria

- A bash wrapper `bin/event-push` exists that resolves the built `@personal-events/event-push`
  CLI and `exec`s it, forwarding **all** arguments and stdin verbatim.
- **The wrapper contains no event logic** — no key construction, no JSON assembly, no validation,
  no priority/type checking. Resolution and delegation only. This is the guardrail that keeps the
  object-key contract to a single implementation.
- The wrapper has a `#!/usr/bin/env bash` shebang, is compatible with **both bash and zsh**, uses
  only command invocations that behave identically on **macOS and Linux**, and passes
  `shellcheck` with no warnings.
- Running `event-push` from an arbitrary working directory (e.g. `/tmp`, `$HOME`) works.
- **Cron's minimal environment is an explicit, tested case:** the wrapper resolves correctly with
  no shell profile sourced, no `nvm` on `$PATH`, and a bare environment — the failure mode where
  the tool works interactively but silently fails under cron must be demonstrated absent.
- A documented `$PATH` installation path exists (symlink into a user bin dir, or an equivalent
  documented step), and the wrapper still resolves correctly **when invoked through a symlink**.
- A non-zero exit from the underlying CLI propagates unchanged through the wrapper.
- A recipes document ships with at least: a crontab entry, a git `post-merge` (or `post-commit`)
  hook, a CI step, and a "notify me when this long-running job finishes" one-liner that pushes a
  different priority on success vs failure.
- **AWE-151 and AWE-152's validation steps are retrofitted** to use `event-push` instead of
  `aws s3 cp` with a hand-computed key, and those plan files are updated in the same change.
- Failure modes produce clear messages and non-zero exits: the built CLI cannot be located
  (with a message naming exactly what to build or set), and Node is unavailable on `$PATH`.
- Guidance conformance per `.agents/languages/shell.md`, verified by `shellcheck`.

### Notes / Open questions

- **Open — resolution strategy.** Candidates: an `EVENT_PUSH_HOME` env var, resolving the
  wrapper's own symlink target back to the repo, or an `npx` fallback. The choice must survive
  cron's bare environment; a relative-path resolution that only works inside the repo checkout
  is the specific anti-goal here.
- **Open — where the wrapper is installed from.** The repo has no `bin/` convention yet and no
  install script. This story should establish the smallest thing that works rather than inventing
  a general installer.
- npm publication is explicitly **out of scope** for this feature — the wrapper therefore only
  serves machines with a repo checkout. The README's "any server I'm working on" case waits on a
  published package, tracked against the feature's risk list.
- Retrofitting AWE-151/152 touches two plan files owned by `bootstrap-and-iac`. Both are in a
  planning state (not `Implementing`), so the write-guard does not fence them — but if either is
  mid-execution when this story runs, coordinate rather than editing underneath it.
- Depends on AWE-213 (the CLI must exist to be wrapped).

<!-- ## Plan is filled in later by /plan-story when this story is about to be worked. -->
