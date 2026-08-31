---
id: AWE-214
title: Shell wrapper, $PATH install & push recipes
type: story
status: ready
parent: ./feature.md
pm-tool: Airtable
pm-record: recW9tU8b1zBdxrGk
pm-url: https://airtable.com/appnae8GXuj1rNVoQ/tblpJmL4dJ7Q4rw3U/recW9tU8b1zBdxrGk
branch: feature/minimal-event-pipeline
project: https://airtable.com/appnae8GXuj1rNVoQ/tblQuFDLYQGrcoiTf/recAmtlL5Goesb0p1
created: 2026-08-03
updated: 2026-08-31
---

# Story: Shell wrapper, `$PATH` install & push recipes

## Definition

### User story

As someone wiring a cron job, git hook, or CI step on one of my machines
I want a plain `event-push` command available from any directory, plus copy-paste recipes
So that pushing an event is a one-line shell change rather than a Node invocation I have to
remember the resolution rules for.

### Acceptance criteria

- **AC-01** — A bash wrapper `bin/event-push` exists that resolves the built
  `@personal-events/s3-repository` CLI and `exec`s it, forwarding **all** arguments and stdin
  verbatim, including arguments containing spaces, quotes and glob characters.
- **AC-02** — **The wrapper contains no event logic** — no key construction, no JSON assembly, no
  validation, no priority/type checking. Resolution and delegation only. This is the guardrail
  that keeps the object-key contract to a single implementation.
- **AC-03** — Resolution follows the documented order **`EVENT_PUSH_HOME` > symlink-resolved
  location of the wrapper itself**. When the wrapper is reached through one or more symlinks, it
  resolves its own real path back to the repository checkout and locates
  `packages/s3-repository/dist/main.js` from there.
- **AC-04** — The wrapper has a `#!/usr/bin/env bash` shebang, runs correctly when invoked from
  **both bash and zsh**, uses only command invocations that behave identically on **macOS and
  Linux** (no GNU-only `readlink -f`, no `realpath` dependency), and passes `shellcheck` with
  **zero** warnings at default severity.
- **AC-05** — Running `event-push` from an arbitrary working directory (verified from at least
  `/tmp` and `$HOME`) works.
- **AC-06** — **Cron's minimal environment is an explicit, executed test case**: the wrapper
  resolves correctly with **no shell profile sourced, no `nvm` on `$PATH`, and a bare
  environment** (`env -i`). The failure mode where the tool works interactively but silently
  fails under cron must be demonstrated **absent**, not merely assumed.
- **AC-07** — A documented `$PATH` installation path exists — a symlink from `~/.local/bin/event-push`
  to `bin/event-push` — and the wrapper still resolves correctly **when invoked through that
  symlink** (this is the case AC-03's symlink resolution exists for).
- **AC-08** — A non-zero exit from the underlying CLI **propagates unchanged** through the
  wrapper: exit codes 2, 3 and 4 from `@personal-events/s3-repository` are observed unmodified by
  the caller.
- **AC-09** — A recipes document ships containing **at least these four** working, copy-pasteable
  recipes: a crontab entry, a git `post-merge` (or `post-commit`) hook, a CI step, and a
  "notify me when this long-running job finishes" one-liner that pushes a **different priority on
  success versus failure**.
- **AC-10** — **The one remaining hand-built object key in the plan tree is retrofitted.**
  `.agents/plans/local-sync-client/s3-poll-core.md` (AWE-152 — S3 poll core) line ~236 currently
  validates by running `aws s3 cp exemplars/valid-github.json s3://<bucket>/<built-key>`; it is
  updated in this same change to use `event-push`. A repo-wide guard asserts no plan file,
  script, or doc instructs a human to construct an object key by hand.
- **AC-11** — **Failure modes** produce clear messages and non-zero exits: the built CLI cannot
  be located (message names exactly what to build or which variable to set, and exits non-zero),
  and `node` is unavailable on `$PATH` (message names the missing runtime).
- **AC-12** — Guidance conformance per `.agents/languages/shell.md`, verified by `shellcheck`.

### Notes / Open questions

- **Open question closed — resolution strategy (user decision, 2026-08-31): symlink-resolution
  with an `EVENT_PUSH_HOME` override.** A relative-path resolution that only works inside the
  repo checkout was the explicit anti-goal; `npx` was rejected because npm publication is out of
  scope for this feature and `npx` is not reliably on cron's `$PATH`.
- **Open question closed — install location.** `~/.local/bin` (already on `$PATH`, measured
  2026-08-30) via a symlink. No general installer is invented; the README documents the single
  `ln -s` command. `bin/` is established by this story as the repo's wrapper directory.
- **AC-10 supersedes the stub's original retrofit criterion**, which named "AWE-151 and AWE-152's
  validation steps". That wording is stale in two ways: AWE-151 — IaC: S3 event bucket &
  delegated DNS was re-planned on 2026-08-31 and its validation now uses Terraform plus
  `infra/scripts/verify-*.sh`, with **no** `aws s3 cp` and no hand-built key; and AWE-152 no
  longer belongs to this feature — it is `.agents/plans/local-sync-client/s3-poll-core.md` in the
  `local-sync-client` feature. One retrofit target remains, and it lives in another feature's
  directory.
- **Editing AWE-152's plan file is permitted**: it is in a planning state (`todo:backlog`), and
  the plan-access guard fences only `Implementing` / `Implementation Adjustment` plans. If it is
  mid-execution when this story runs, coordinate rather than editing underneath it.
- npm publication is explicitly **out of scope** for this feature — the wrapper therefore only
  serves machines with a repo checkout. The README's "any server I'm working on" case waits on a
  published package, tracked against the feature's risk list.
- Depends on **AWE-213 — S3 event repository & push CLI** (the CLI must exist to be wrapped).

## Plan

> Validate the resolution logic against a genuinely bare environment before believing it works.
> The single highest-value test in this story is the `env -i` case — everything else passes
> trivially in an interactive shell. Do not restate the user story.

### Decisions resolved during planning

- **Resolution order is `EVENT_PUSH_HOME` first, then self-resolution.** The explicit override
  wins so a user with an unusual layout (or a second checkout) can force the target without
  fighting the symlink logic.
- **Symlink resolution is a hand-rolled POSIX loop, not `readlink -f` or `realpath`.** macOS ships
  BSD `readlink`, which has **no `-f`**, and `realpath` is absent on stock macOS. AC-04's
  "identical on macOS and Linux" requirement makes the portable loop mandatory — this is the
  single most likely place for a Linux-only implementation to slip through.
- **The wrapper `exec`s node directly**, rather than shelling through `pnpm`. `pnpm` is a Node
  script and is frequently absent from cron's `$PATH`; `exec` also replaces the shell process so
  the child's exit code becomes the wrapper's with no propagation logic (AC-08).
- **`node` is located via `$PATH` only, with a clear error if absent.** The wrapper deliberately
  does **not** attempt to source `nvm` — a wrapper that sources a user's shell profile is
  unpredictable under cron and is exactly the class of bug AC-06 exists to prevent. The recipes
  document instead shows an absolute-path `PATH=` line for crontabs.
- **The recipes document lives at `docs/event-push-recipes.md`** and is linked from both
  `README.md` and `packages/s3-repository/README.md`.

### Acceptance evidence design

- **AC-02 (no event logic)**
  - *Defining input property*: the wrapper's own source text.
  - *Direct assertions*: the script contains no `.json` key assembly, no `alert|notification`
    literal, no priority range check.
  - *Evidence command*:
    `! rg -nE 'alert|notification|\.json|p[1-8]|1\.\.8' bin/event-push`
  - *Counterexample*: this is the structural guardrail for the feature's "object keys are built
    only by the codec" cross-story contract — a wrapper that "helpfully" defaults `--type` would
    pass every functional test while forking the contract.
- **AC-03 / AC-07 (symlink resolution)**
  - *Defining input property*: invocation through a symlink in a **different directory** from the
    repo, which is the only case that distinguishes real resolution from `dirname "$0"`.
  - *Direct assertions*: a symlink at `$TMPDIR/bin/event-push` → `bin/event-push` resolves and
    runs successfully with `--dry-run`.
  - *Evidence command*: `bash bin/event-push.spec.sh symlink`
  - *Counterexample*: also test a **double** symlink (link → link → script); a single-level
    `dirname $(readlink)` implementation passes the single case and fails this one.
- **AC-04 (portability)**
  - *Direct assertions*: `shellcheck` clean; no `readlink -f` and no `realpath` in the source.
  - *Evidence command*:
    `shellcheck bin/event-push && ! rg -nE 'readlink -f|realpath' bin/event-push`
  - *Counterexample*: the grep is what actually enforces macOS compatibility — `shellcheck` on
    Linux will not flag `readlink -f`.
  - *Environment*: `shellcheck` runs on Linux here; the grep is the portability proxy, and the
    README records that macOS execution remains unverified on this machine.
- **AC-06 (cron bare environment)** — the story's highest-value test.
  - *Defining input property*: a genuinely empty environment — `env -i` with only a minimal
    `PATH`, no `HOME`-sourced profile, no `nvm`.
  - *Direct assertions*: exit 0 and a printed key from a `--dry-run`.
  - *Evidence command*:
    `env -i PATH=/usr/bin:/bin EVENT_PUSH_HOME="$PWD" bash bin/event-push --type alert --priority 1 --source cron --name probe --bucket x --dry-run`
  - *Counterexample*: run the same command **without** `EVENT_PUSH_HOME` to prove the
    self-resolution path also works bare — otherwise the test only proves the override works.
- **AC-08 (exit propagation)**
  - *Defining input property*: an invocation that makes the **underlying CLI** exit 2, not one
    that makes the wrapper itself fail.
  - *Direct assertions*: `bin/event-push --type bogus …; echo $?` prints exactly `2`.
  - *Evidence command*: `bash bin/event-push.spec.sh exit-codes`
  - *Counterexample*: assert code **2** specifically, not merely non-zero — a wrapper that maps
    every failure to 1 would pass a non-zero check while destroying the branchable contract
    AWE-213 AC-10 established.
- **AC-09 (recipes) — complete-set inventory**: the criterion says *at least* four named recipes.
  Enumerate them by heading in `docs/event-push-recipes.md` and assert all four are present:
  crontab, git hook, CI step, long-job success/failure. The success/failure recipe is additionally
  **executed** in dry-run form to prove it is syntactically valid shell, not just prose.
- **AC-10 (retrofit)**
  - *Evidence command*:
    `! rg -n 'aws s3 cp .*s3://' .agents/plans/ docs/ bin/ packages/`
  - *Direct assertions*: the guard passes repo-wide **and**
    `rg -q 'event-push' .agents/plans/local-sync-client/s3-poll-core.md`.

**No production write is required by this story.** Every acceptance criterion is satisfiable with
`--dry-run`, which performs zero network calls (AWE-213 AC-08). The read-only `head-bucket`
preflight inherited from AWE-213 is covered by execute's automatic read authorization.

### Architectural constraints — VERIFY BEFORE WRITING ANY TASK

- **Separation of concerns / module SRP** (`.agents/general.md`): the wrapper has exactly one
  responsibility — *locate and delegate*. Any second responsibility is the defect AC-02 tests for.
- **Gather / Compute / Persist**: the wrapper is pure **gather** (locate the interpreter and the
  script) followed by `exec`. It performs no compute and no persist; both belong to AWE-213.
- **Single implementation of the key contract** (`feature.md` cross-story contracts): "The bash
  wrapper in AWE-214 contains no event logic whatsoever, which is what structurally prevents a
  second implementation in shell." AC-02 is the enforcement of that contract.
- **`.agents/languages/shell.md`**: `#!/usr/bin/env bash`, `set -euo pipefail`, quoted expansions,
  `"$@"` never bare `$@`.

### Files to read — READ THESE BEFORE IMPLEMENTING

- `.agents/languages/shell.md` — Why: the binding shell conventions and `shellcheck` expectations.
- `.agents/plans/minimal-event-pipeline/s3-repository-and-push-cli.md` (AWE-213) — Why: the exact
  `bin` name (`event-push`), the built artifact path (`packages/s3-repository/dist/main.js`), the
  `EVENT_BUCKET` variable, and the exit-code table this wrapper must propagate unchanged.
- `.agents/plans/local-sync-client/s3-poll-core.md` (AWE-152), around line 236 — Why: the single
  `aws s3 cp` retrofit target named by AC-10.
- `.agents/plans/minimal-event-pipeline/feature.md` — Why: the cross-story contract that this
  wrapper must contain no event logic.
- `packages/s3-repository/README.md` (produced by AWE-213) — Why: the exit codes and flags the
  recipes document references.

### Files to create / change

- `bin/event-push` — the wrapper (executable, `chmod +x`).
- `bin/event-push.spec.sh` — the executable test harness for the symlink, bare-environment,
  exit-code and arbitrary-cwd cases. Plain bash so it runs without the Node toolchain.
- `docs/event-push-recipes.md` — the four required recipes.
- `.agents/plans/local-sync-client/s3-poll-core.md` — AC-10 retrofit (replace the `aws s3 cp`
  validation step with `event-push`).
- `README.md` — link the recipes doc; document the `~/.local/bin` symlink install.
- `packages/s3-repository/README.md` — cross-link the wrapper as the recommended shell entry point.

### Relevant documentation

- [`shellcheck` wiki: SC2164, SC2086, SC2046](https://www.shellcheck.net/wiki/) — Why: the
  quoting and `cd` rules this script will trip if written casually.
- [POSIX `readlink` vs GNU `readlink -f`](https://pubs.opengroup.org/onlinepubs/9799919799/utilities/readlink.html)
  — Why: the portability constraint behind the hand-rolled resolution loop; BSD/macOS `readlink`
  lacks `-f`.
- [`exec` builtin](https://www.gnu.org/software/bash/manual/bash.html#index-exec) — Why: process
  replacement is what makes exit-code propagation (AC-08) automatic rather than hand-coded.
- [crontab environment behaviour](https://man7.org/linux/man-pages/man5/crontab.5.html) — Why:
  cron runs with a minimal `PATH` and does not source login profiles — the root cause AC-06 tests.

### Patterns to follow

- **Portable symlink resolution** (works on macOS and Linux; handles chained links):
  ```bash
  resolve_self() {
    local src=$1 dir
    while [ -L "$src" ]; do
      dir=$(cd -P "$(dirname "$src")" && pwd)
      src=$(readlink "$src")
      [ "$src" != /* ] && src=$dir/$src
    done
    cd -P "$(dirname "$src")" && pwd
  }
  ```
  Note: **no `readlink -f`**, **no `realpath`** — see Decisions resolved during planning.
- **Resolution order and delegation** — the whole body of the script:
  ```bash
  set -euo pipefail
  if [ -n "${EVENT_PUSH_HOME:-}" ]; then
    repo_root=$EVENT_PUSH_HOME
  else
    repo_root=$(cd "$(resolve_self "${BASH_SOURCE[0]}")/.." && pwd)
  fi
  cli=$repo_root/packages/s3-repository/dist/main.js
  [ -f "$cli" ] || { echo "event-push: CLI not built at $cli — run 'pnpm build', or set EVENT_PUSH_HOME." >&2; exit 127; }
  command -v node >/dev/null 2>&1 || { echo "event-push: 'node' not found on PATH." >&2; exit 127; }
  exec node "$cli" "$@"
  ```
- **`exec … "$@"`** — quoted `"$@"` preserves arguments containing spaces (AC-01); `exec` makes
  the child's exit status the wrapper's (AC-08) with no propagation code.
- **Crontab recipe shape** — set `PATH` explicitly rather than relying on the daemon's default:
  ```cron
  PATH=/usr/local/bin:/usr/bin:/bin
  EVENT_BUCKET=events.dev.personal-events.fifthdimensionengineering.com
  0 3 * * * /home/alexturner/.local/bin/event-push --type notification --priority 3 --source cron --name nightly-backup
  ```
- **Success/failure priority recipe** — one line, branching on `$?`:
  ```bash
  long_job && event-push --type notification --priority 3 --source ci --name job-ok \
           || event-push --type alert --priority 7 --source ci --name job-failed
  ```

### Codebase irregularities to ignore

- **The stub's retrofit criterion names AWE-151 and AWE-152 as if both were in this feature.**
  Neither holds now — see Notes; AC-10 replaces it with the single real target.
- **The stub calls the wrapped package `@personal-events/event-push`.** The package is
  `@personal-events/s3-repository`; `event-push` is the **binary** name (AWE-213 AC-01).
- **`bin/` does not exist in the repo yet.** There is no prior convention to match — this story
  establishes it. Do not confuse it with `.agents/bin/`, which holds linked AI tooling and is
  never staged.
- **Do not source `nvm` or a shell profile in the wrapper**, however tempting it looks when a bare
  `env -i` run cannot find `node`. The documented fix is an explicit `PATH=` line in the crontab,
  not profile-sourcing inside the wrapper.

### Step-by-step tasks

Execute in order.

#### CREATE bin/event-push
- **IMPLEMENT**: the wrapper exactly as in Patterns to follow — `resolve_self`, resolution order,
  the two guard clauses, `exec node "$cli" "$@"`.
- **GOTCHA**: `chmod +x` and commit the mode bit, or the symlink install silently fails.
- **VALIDATE**: `shellcheck bin/event-push && test -x bin/event-push`

#### CREATE bin/event-push.spec.sh — the harness
- **IMPLEMENT**: subcommands `symlink` (single **and** double link), `bare-env` (with and without
  `EVENT_PUSH_HOME`), `exit-codes` (assert exactly 2), `cwd` (run from `/tmp` and `$HOME`), and
  `args` (an argument containing a space and a quote survives intact).
- **PATTERN**: `set -euo pipefail`; each case prints PASS/FAIL and the harness exits non-zero on
  any failure.
- **VALIDATE**: `shellcheck bin/event-push.spec.sh && bash bin/event-push.spec.sh all`

#### VERIFY the no-event-logic guardrail
- **IMPLEMENT**: confirm the wrapper contains no type/priority/key vocabulary.
- **VALIDATE**: `! rg -nE 'alert|notification|\.json|p[1-8]' bin/event-push`

#### VERIFY portability constraints
- **IMPLEMENT**: confirm no GNU-only constructs.
- **VALIDATE**: `! rg -nE 'readlink -f|realpath|--version' bin/event-push`

#### CREATE docs/event-push-recipes.md
- **IMPLEMENT**: the four required recipes with the `PATH=`/`EVENT_BUCKET` preamble; note the
  exit-code table and that a failed push exits non-zero (unlike AWE-162's hook CLI).
- **VALIDATE**: `rg -c '^## ' docs/event-push-recipes.md` reports ≥ 4, and the success/failure
  one-liner runs in dry-run form.

#### UPDATE .agents/plans/local-sync-client/s3-poll-core.md — the AC-10 retrofit
- **IMPLEMENT**: replace the `aws s3 cp exemplars/valid-github.json s3://<bucket>/<built-key>`
  validation step with the equivalent `event-push` invocation; note the dependency on AWE-214 in
  that story's Notes.
- **GOTCHA**: that file belongs to the `local-sync-client` feature. Confirm it is still in a
  planning state before editing; if it has moved to `in-progress:*`, stop and coordinate.
- **VALIDATE**: `! rg -n 'aws s3 cp .*s3://' .agents/plans/ && rg -q 'event-push' .agents/plans/local-sync-client/s3-poll-core.md`

#### UPDATE README.md and packages/s3-repository/README.md
- **IMPLEMENT**: the `ln -s "$PWD/bin/event-push" ~/.local/bin/event-push` install line and links
  to the recipes doc.
- **VALIDATE**: `rg -q 'event-push-recipes' README.md`

#### REFACTOR — guidance conformance pass
- **IMPLEMENT**: reconcile both scripts against `.agents/languages/shell.md` — quoting, `set -euo
  pipefail`, no unquoted expansions, clear error messages naming the remedy.
- **VALIDATE**: `shellcheck bin/*.sh bin/event-push`

### Testing strategy

- **Unit**: n/a in the TypeScript sense. `bin/event-push.spec.sh` is the executable test suite and
  is the story's primary gate; it deliberately requires no Node toolchain beyond `node` itself so
  it can run in the same bare conditions it is testing.
- **Integration**: the wrapper's integration surface is the **AWE-213 CLI**, exercised through
  `--dry-run`. No AWS calls and therefore **no production write** — every criterion is provable
  offline. This is a deliberate property of the design: the wrapper is testable without touching
  the bucket because it contains no event logic.
- **Edge cases**: chained symlinks; invocation from `/tmp` and `$HOME`; `env -i` with and without
  `EVENT_PUSH_HOME`; arguments containing spaces and quotes; unbuilt CLI; `node` absent from
  `$PATH`; underlying CLI exiting 2/3/4.
- **Skip inventory**: **none** — there are no conditional or opt-in suites, and no credential-gated
  case. Expected unexpected-skip count is **0**. If `bin/event-push.spec.sh` cannot run, the story
  is blocked, not passed.

### Validation commands

- Level 1 — Syntax & style: `shellcheck bin/event-push bin/event-push.spec.sh`
- Level 2 — Portability & guardrail greps:
  `! rg -nE 'readlink -f|realpath' bin/event-push` and
  `! rg -nE 'alert|notification|\.json|p[1-8]' bin/event-push`
- Level 3 — Behavioural suite: `bash bin/event-push.spec.sh all`
- Level 4 — Retrofit guard: `! rg -n 'aws s3 cp .*s3://' .agents/plans/ docs/ bin/ packages/`
