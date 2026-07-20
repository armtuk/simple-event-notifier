# `@personal-events/desktop-notifier`

A long-running daemon that polls the S3 event bucket and raises a native desktop notification for
each new event. It is the first real consumer of the event bus, and the end-to-end proof that the
bucket plus `@personal-events/event-model` work before any webhook ingest exists.

## How it works

One tick is a straight Gather → Compute → Persist pipeline:

| Phase | Module | Does |
| :--- | :--- | :--- |
| Gather | `s3-client.ts`, `poller.ts` | lists keys strictly after the high-water mark (`StartAfter`) and fetches their bodies |
| Compute | `classify.ts`, `notification-content.ts` | parses each body through the event model and derives the notification wording — both pure |
| Persist | `notify.ts`, `state.ts` | raises the OS notification and saves the advanced mark |

Keys begin with an ISO instant, so they sort chronologically and the last key processed is a
sufficient high-water mark. Ordering is by **key string**, never `LastModified` — producers' clocks
are not synchronised.

Ticks are self-scheduling (`setTimeout` after the previous tick finishes, not `setInterval`), so a
slow poll can never overlap the next one. A failing tick backs off exponentially with ±25% jitter,
capped at `MAX_BACKOFF_MS`, and resets on the first success.

## Running it

```bash
pnpm --filter @personal-events/desktop-notifier build
EVENT_BUCKET=events.prod.personal-events.fifthdimensionengineering.com \
AWS_REGION=us-east-1 \
node apps/desktop-notifier/dist/index.js
```

`Ctrl-C` (or `SIGTERM`) finishes the tick in flight, persists the mark, and exits.

## Configuration

| Variable | Default | Purpose |
| :--- | :--- | :--- |
| `EVENT_BUCKET` | **required** | the bucket to poll |
| `AWS_REGION` / `AWS_DEFAULT_REGION` | `us-east-1` | region for the S3 client |
| `POLL_INTERVAL_MS` | `30000` | delay between successful ticks |
| `MAX_BACKOFF_MS` | `300000` | ceiling for the error backoff |
| `STATE_FILE` | `$XDG_STATE_HOME/personal-events/desktop-notifier.json` | where the high-water mark is persisted |
| `NOTIFIER` | `auto` | `auto` (toasted-notifier, falling back to a shell command), `toasted`, or `shell` |
| `LOG_LEVEL` | `info` | winston level |
| `LOG_FILE` | unset | when set, JSON logs are also written here |
| `ENV` | `dev` | stamped on every log record |

Credentials come from the standard AWS provider chain and are probed once at startup, so a
misconfigured machine fails immediately with one clear line.

## Behaviour worth knowing

- **First run does not replay history.** With no stored mark the daemon seeds from "now"; replaying
  the whole bucket as desktop notifications would be unusable. A `--backfill` flag can come later.
- **A malformed object is logged with its key and reason, then skipped.** The mark advances past it,
  so one bad object cannot wedge the daemon or block the events behind it.
- **A restart does not re-notify.** The mark is written temp-then-`rename` in the same directory,
  so it is atomic on POSIX.
- **`toasted-notifier` is isolated, and on macOS + pnpm it does not actually work.** Its bundled
  `terminal-notifier` helper arrives without its executable bit (the package has no postinstall to
  set it), so every call fails `EACCES`. The `auto` notifier absorbs this: it falls through to the
  shell adapter and **latches**, so the dead helper is attempted once per process rather than once
  per event. Set `NOTIFIER=shell` to skip the wasted first attempt entirely. This is exactly the
  risk the feature plan flagged, and why the library sits behind `NotifierAdapter` in `notify.ts`
  with a dependency-free `osascript` / `notify-send` / PowerShell fallback — replacing or dropping
  it is a change to that one file plus the `types/` shim.

## Tests

`pnpm --filter @personal-events/desktop-notifier test` runs the unit suite with no AWS account
required. The real-bucket suite is opt-in:

```bash
TEST_EVENT_BUCKET=<a disposable bucket> AWS_REGION=us-east-1 \
  pnpm --filter @personal-events/desktop-notifier test
```

It writes fixtures tracked by key and deletes them by key afterwards — never a bucket wipe.
