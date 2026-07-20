# `@personal-events/github`

The GitHub **instance** of the integration template. It knows GitHub's wire shapes and nothing about
classification; `@personal-events/integration-core` owns classification and knows nothing about
GitHub. This package is **pure** — no HTTP, no S3, no clock. The edges that do I/O are
`apps/webhook-ingest` (AWE-156) and `apps/github-poller` (AWE-157).

## Three channels, one config

GitHub reaches us three ways, and their vocabularies overlap without agreeing:

| Channel | Source | Trigger fields | Timestamp |
| :--- | :--- | :--- | :--- |
| `webhook` | a repo/org webhook delivery | `event` (+ `action`) | `receivedAt`, injected by the edge |
| `notification` | `GET /notifications` (classic PAT) | `reason` | the item's `updated_at` |
| `events_api` | `GET /users/{u}/received_events` | `type` (+ `action`) | *reserved — AWE-157 finalizes it* |

A webhook says `pull_request` + `review_requested`; the inbox says `reason: review_requested`. Same
words, different meanings — which is why `GithubTriggerSchema` is a real `Schema.Union` of
literal-tagged structs, and why `loadGithubConfig` decodes every rule's trigger against it with
`onExcessProperty: "error"`. The framework's trigger schema has to stay open to host providers it
has never seen; that openness would otherwise let a misspelt channel or a cross-channel field
compile to a match-key nothing ever produces — a rule that validates, deploys, and silently never
fires.

## Editing the classification

`src/github-mapping.json` is the file to edit. Rules are matched **exactly**, so:

- A rule's fields must be *precisely* the fields the normalizer builds. `push` has no action, so its
  rule has no `action`; `pull_request` always has one, so its rules always name it.
- There is **no specificity ladder**: `{ "channel": "webhook", "event": "pull_request" }` does *not*
  catch every `pull_request` action, because a real delivery's trigger always carries an action and
  the keys differ. Enumerate the actions you care about and let the rest fall to `default`.
- Notification triggers carry **only `reason`** — deliberately not `subject.type`. Every item has a
  subject type and essentially no rule wants to discriminate on it, so including it would force
  every rule to enumerate every type. A rule that names `subjectType` is *rejected* at load rather
  than accepted-and-never-fired. The subject type is still in the event's `payload`.
- An unmapped event or reason classifies to `default` and **is written**. Nothing is dropped for
  being unfamiliar; `classify(...).matched === false` is how an edge logs the gap.

Adding a specificity ladder (try the most specific key, fall back to less specific ones) is the
lever if the exact-match rule becomes limiting — it is a `integration-core` change affecting every
integration, recorded as a follow-up in `.agents/plans/github-integration/feature.md`.

## Two things worth knowing before you trust a timestamp

- **A webhook delivery has no reliable event-time.** Payloads vary and several covered events carry
  none at all, so the edge injects `receivedAt` — honestly the moment we learned of it.
- **A notification's `updated_at` is second-precision.** Widened to the contract's mandatory
  three-digit fraction it becomes `.000`, so **every item GitHub touched in the same second shares a
  millisecond**. Same-instant siblings are the norm for this producer, not a coincidence. That
  interacts badly with a consumer using a bare high-water mark — see `src/instant.ts`,
  `packages/event-model/README.md` § "Key order is not write order", and the open delivery-semantics
  question in the feature plan. This package deliberately does not invent sub-second detail GitHub
  did not send.

## API

| Export | Purpose |
| :--- | :--- |
| `normalizeWebhook`, `normalizeNotification` | Raw GitHub shape → `NormalizedEvent` (pure, `Either`) |
| `githubToEvent`, `githubNotificationToEvent` | The whole path an edge calls: normalize + classify |
| `loadGithubConfig`, `loadGithubConfigFrom` | Validate + compile the mapping config, GitHub's gate first |
| `readerFor`, `isModelledWebhookEvent` | The `X-GitHub-Event` → payload-reader registry |
| `GithubTriggerSchema` and the three builders | The non-confusable trigger union and its constructors |
| `NotificationSchema`, the webhook subset schemas | Runtime validation of the fields we read |
| `toDotSafe`, `toCanonicalInstant` | The two normalizations the event contract requires |

## Exemplars

`exemplars/` holds one payload per covered event and reason, plus `invalid-*.json` per failure mode.

**They are hand-authored from GitHub's OpenAPI-generated definitions
(`@octokit/openapi-webhooks-types`) and documented samples — not captured from a live delivery**,
because registering a real webhook was outside this feature's execution fence. `src/octokit-alignment.ts`
compensates in the dimension that matters: it asserts *at compile time* that a payload of GitHub's
own generated type is assignable to each subset schema, so an upstream rename breaks the build.
Replaying one real delivery against the suite is recorded as deferred verification in
`.agents/plans/github-integration/github-event-mapping.md`.
