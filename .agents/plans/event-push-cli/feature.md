---
id: event-push-cli
title: Event Push CLI & shell wrapper
type: feature
status: todo:backlog
parent: none
pm-tool: Airtable
functional-area: producer-tooling
depends-on: [bootstrap-and-iac]
project: https://airtable.com/appnae8GXuj1rNVoQ/tblQuFDLYQGrcoiTf/recAmtlL5Goesb0p1
created: 2026-08-02
updated: 2026-08-02
branch-name: feature/event-push-cli
---

# Feature: Event Push CLI & shell wrapper

## Definition

### Problem

There is no way to **push an arbitrary event into the S3 event bucket from a shell**. Every
producer path currently planned requires deployed infrastructure or a TypeScript program:

| Producer | Story | Shell-invocable? |
|---|---|---|
| Webhook → API Gateway + Lambda | AWE-155 / AWE-156 | No — needs deployed infra and HMAC signing |
| GitHub activity poller | AWE-157 | No — a deployed Railway service |
| `@personal-events/s3-push` | AWE-160 | No — a library with no `bin` |
| `@alexrmturner/claude-events` | AWE-162 | No — its stdin contract is the Claude Code hook envelope |

So a cron job, CI step, git hook, or one-off script has no supported way to say *"something
happened, put it in the bucket."*

This is not merely a convenience gap — **the existing plan already depends on a tool it does
not ship.** `bootstrap-and-iac/feature.md` states the bucket is "populated manually to prove
the consumer path", and AWE-152's validation step is literally
`aws s3 cp exemplars/valid-github.json s3://<bucket>/<built-key>` with a **hand-computed**
object key. That validates the system's single load-bearing contract using the most
error-prone method available, and it does so *by hand, every time*.

It also breaks the symmetry the README establishes. The **consume** side has a blessed naive
path — `aws s3 sync` on a cron, enshrined in `system.md` — while the **produce** side has
none. Several roadmap sources (package delivery, incident pages, meeting-approaching, daily
calendar summary) are natural five-line shell integrations that today have nowhere to go.

### Goals

- Push a well-formed canonical event to the bucket from **one shell command**, from any
  directory on the local system.
- The `{timestamp}.{type}.{priority}.{source}.{name}.json` object-key contract has **exactly
  one implementation** — the `event-model` codec. The wrapper must never rebuild keys in bash.
- Accept the full event surface: `eventType`, `priority`, `source`, `name`, optional
  `payload` (file or stdin), optional `workItem`, with `acknowledged`/`handled` defaulting
  to `false`.
- Become the **validation instrument** for AWE-151 (bucket) and AWE-152 (desktop notifier),
  retiring hand-built keys from those stories' validation steps.
- Fail loudly and precisely: a bad flag, missing credentials, or unreachable bucket produces
  an actionable message and a non-zero exit — this is an interactive/scripted tool, so unlike
  the Claude hook CLI it **must not** silently exit 0.

### Solution summary

Two workspace artifacts:

- **`@personal-events/event-push`** — a TypeScript CLI exposing a `bin`. It parses argv into
  a candidate event, reads an optional JSON payload from a file or stdin, validates the whole
  thing through the `event-model` effect Schema, builds the object key via the **event-model
  codec** (never by hand), and `PutObject`s it with the AWS SDK v3 **default credential
  chain**. Structured as Gather (argv + stdin + env) → Compute (pure `buildEvent` +
  `buildKey`) → Persist (the S3 write), with a typed `Either`/tagged result at the boundary.
- **`bin/event-push`** — a thin, shellcheck-clean bash wrapper placed on `$PATH`. It resolves
  the built CLI and execs it, forwarding argv and stdin verbatim. It contains **no event
  logic whatsoever** — resolution and delegation only.

Shipped alongside: a documented set of copy-paste recipes (cron entry, git `post-merge` hook,
CI step, "notify me when this long job finishes" one-liner).

### Out of scope

- **Publishing to npm.** AWE-162 establishes the publish pattern under `@alexrmturner`; this
  feature stays a workspace package plus a local wrapper. Promoting it to a published package
  is a later increment (see Risks).
- **Reading, listing, acknowledging, or handling events** — this is a write-only push tool.
  Consumption is AWE-152 and the future Event UI.
- **Source-specific classification.** The caller states `--type` and `--priority` explicitly;
  there is no mapping config and no `integration-core` dependency.
- **Batching, spooling, retry queues, or offline buffering.** One invocation writes one event.
- **Windows support.** bash/zsh on macOS and Linux only.

### Acceptance criteria

- `event-push --type alert --priority 5 --source cron --name backup-failed` writes exactly one
  object to the bucket, whose key matches the event-model codec byte-for-byte and whose body
  validates against the `event-model` schema.
- The wrapper runs correctly **from any working directory**, under **both bash and zsh**, on
  **macOS and Linux**, and passes `shellcheck` with no warnings.
- A JSON payload is accepted from a file (`--payload ./x.json`) and from stdin (`--payload -`),
  and lands verbatim under the event's `payload` key.
- **Key-codec parity is proven by test, not asserted:** a round-trip test shows the key this
  CLI produces parses back to the same components via the event-model codec, for a matrix of
  inputs including `source`/`name` values containing dots (which the codec normalizes).
- **Failure modes each produce a clear message and a non-zero exit** — never a silent success,
  never a partial write:
  - invalid `--type` (not `alert`/`notification`) or `--priority` outside 1–8;
  - missing/expired AWS credentials;
  - bucket unreachable, missing, or access denied;
  - `--payload` file absent or containing malformed JSON;
  - required flags omitted.
- `--dry-run` prints the resolved key and event body and writes nothing, so a recipe can be
  verified before it is wired to a cron.
- Re-running the identical command does not silently clobber a prior event under the same key
  (documented behavior, consistent with the idempotency stance in AWE-160).
- **Guidance conformance is definition-of-done for every story** — per `.agents/general.md`
  (G-C-P separation, module SRP, pure compute, slice-don't-dump, no accumulator loops,
  `Either`/tagged result types, no enums, `Record` lookups over if/else chains),
  `.agents/languages/typescript/*` for the CLI, and `.agents/languages/shell.md` for the
  wrapper — verified by `biome`, `typecheck`, and `shellcheck`.

## Plan

### Approach overview

Bottom-up in two steps, with the seam between them deliberately narrow. The **CLI package**
owns all event logic and is fully testable without a shell; the **wrapper** owns only
resolution, `$PATH` placement, and the documented recipes. Keeping the wrapper logic-free is
what guarantees the key codec cannot fork into a second bash implementation — the single
failure mode most damaging to the system's contract.

Both stories depend only on `event-model` (AWE-150) and the provisioned bucket (AWE-151).
Neither needs `integration-core` (AWE-153), the webhook ingest, or any GitHub work — so this
feature can be executed as soon as `bootstrap-and-iac` lands.

### Story decomposition

Ordered by dependency. Each is a coherent ~1hr-review increment (not a micro-PR).

1. **push-cli-package** — `@personal-events/event-push`: argv parsing, payload from file/stdin,
   event assembly validated by the `event-model` schema, key building via the event-model
   codec, `PutObject` via the AWS SDK v3 default credential chain, `--dry-run`, typed results,
   precise non-zero exits, and the key round-trip parity tests. *(AWE-213)*
2. **shell-wrapper-and-recipes** — the shellcheck-clean `bin/event-push` bash wrapper (resolve
   + exec + forward stdin, no event logic), its `$PATH` installation story, and the documented
   recipe set (cron, git hook, CI, long-job notification), including retrofitting AWE-151/152's
   validation steps to use it instead of hand-built keys. *(AWE-214)*

### Risks

- **`s3-push` (AWE-160) overlap — the deliberate tradeoff.** `@personal-events/s3-push` is the
  intended shared Persist boundary for all producers, but it currently lives in
  `claude-code-integration`, which sits behind **all** of `github-integration` in the recorded
  DAG. Three options were weighed:
  1. *Depend on AWE-160* — best factoring, but it drags this feature behind all of GitHub and
     destroys the entire point of the tool, which is to exist **early** enough to validate
     AWE-151/152.
  2. *Duplicate a minimal write inline* — available immediately, at the cost of a second
     `PutObject` implementation.
  3. *Pull AWE-160 forward into `bootstrap-and-iac`* — best long-term, but re-plans another
     feature and is out of this feature's authority.

  **Chosen: (2), bounded.** The S3 write lives behind a single small `putEvent` module whose
  signature is a deliberate drop-in for `s3-push`'s, so adoption later is a one-file swap with
  no changes to argv parsing, event assembly, or key building. **Recommendation for the user:**
  AWE-160 is misfiled for the same reason AWE-153 is — both are shared infrastructure trapped
  inside a leaf feature. Pulling both into `bootstrap-and-iac` would let this feature consume
  `s3-push` directly and remove the duplication before it is ever written.
- **Wrapper resolution is the fragile part.** "Runs from anywhere" means the wrapper must find
  the built CLI without a relative path — via an env var (e.g. `EVENT_PUSH_HOME`), a resolved
  symlink target, or an `npx` fallback. Getting this wrong yields a tool that works in the repo
  and fails in cron, which is precisely the environment it exists to serve. Cron's minimal
  environment (no `nvm`, bare `$PATH`, no shell profile) must be an explicit test case.
- **Exit-code posture is the opposite of AWE-162.** The Claude hook CLI must exit 0 on failure
  to protect the agent session; this tool must exit non-zero so scripts and CI can detect a
  failed push. Two CLIs in one repo with opposing failure contracts is a real trap — document
  it prominently in both.
- **Bucket identity has no home yet.** The bucket name comes from AWE-151's Terraform outputs;
  until a convention exists (env var vs config file vs flag), the CLI needs a documented
  precedence order. `--bucket` should always win so the tool is testable against a scratch
  bucket.
- **Clock skew and timestamp trust.** The key leads with the machine's clock, so a skewed host
  writes events that sort wrongly and are effectively invisible to time-ordered consumers.
  Decide whether the CLI stamps client-side (simple, skew-prone) or accepts an override.
- **Unpublished tool limits reach.** Without npm publication the wrapper only works on machines
  with a repo checkout — acceptable for the user's own machines now, but it does not serve the
  "any server I'm working on" case in the README. Revisit once AWE-162 proves the publish path.
