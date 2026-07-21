## 2026-07-19T21:30:00Z — Initial decision recorded — Alex Turner

Written alongside the AWE-153 implementation, the first story of the `github-integration` feature.
Records the config-driven integration template (`@personal-events/integration-core`), the `channel`
trigger discriminant and its rename from the stubs' `source`, the compile-then-lookup classification
path, the mandatory default classification, interfaces-only adapters, and the dual webhook/poller
ingestion design for GitHub with a single shared S3 write path.

One ADR covers the whole feature: AWE-154 through AWE-157 reference this record rather than
authoring their own, and append a revision-log entry here when they make a decision that changes it.

## 2026-07-19T22:10:00Z — Operational state moved to its own bucket; HMAC and dedupe mechanics recorded — Alex Turner

Following the AWE-156 implementation. Two changes to the body's design, and one correction of a
decision the story plans had made:

- **Operational state (delivery-dedupe markers, and from AWE-157 poller cursors) lives in a separate
  `state.{env}.{system}.{domain}` bucket, not a prefix of the event bucket.** The story plans had
  placed both inside the event bucket. That is a silent-total-loss defect: the desktop notifier lists
  the event bucket with `StartAfter` and no prefix filter and advances its high-water mark to the
  highest key seen, and `"deliveries/…"` / `"state/…"` sort above every `"2026-…"` event key — so one
  marker would strand the consumer past every event that will ever exist. The decision itself (S3 as
  the dedupe store, no new datastore) is unchanged; only which bucket.
- **HMAC verification uses the low-level `verify` from `@octokit/webhooks-methods`**, over the raw
  body before any JSON parse, rather than a `Webhooks` receiver instance.
- **The webhook secret is an SSM SecureString**, created by Terraform as a placeholder with
  `ignore_changes = [value]` and set out of band, so it never enters Terraform state.

## 2026-07-19T22:50:00Z — Poller state joins the operational-state bucket; per-source isolation recorded — Alex Turner

Following the AWE-157 implementation. The decision is unchanged; three details are now explicit:

- **The poller's cursor object joins the operational-state bucket** for the same reason the delivery
  markers did — `"state/…"` sorts above every `"2026-…"` event key, so a state object in the event
  bucket would strand the desktop notifier past every event that will ever exist. Both AWE-156's and
  AWE-157's plans had placed their state in the event bucket; one bucket fixes both.
- **The two sources are isolated by credential, not just by loop.** `GET /notifications` accepts a
  **classic** PAT only — not fine-grained, not an App token — while the Events API accepts any. A
  missing token disables that source and leaves the other running; it is never a startup failure.
- **The Railway poller's IAM access key is created out of band**, like the webhook secret.
  Terraform owns the user and its (write-only, single-key-scoped) policy, and nothing else, so no
  credential enters Terraform state.

## 2026-07-21T00:00:00Z — Poller re-architected to AWS; overwrite collision fixed in the contract; R1 findings applied — Alex Turner

Two substantive changes and one platform change, following the R1 review and a user direction:

- **AWS-only.** The poller moves from a long-running Railway container to an EventBridge-scheduled
  Lambda (`rate(1 minute)`), with state in the operational-state bucket and PATs in SSM. The platform
  is now AWS-only (`system.md`). This mooted the R1 concurrent-cursor-clobber finding (a scheduled
  Lambda with `reserved_concurrent_executions = 1` has no concurrent loops).
- **The overwrite collision is solved, not just recorded.** The event-model contract gained
  `producer` and `eventId`, extending the object key to
  `…{name}.{producer}.{eventId}.json` so two distinct same-second same-classification events no longer
  collide and a re-delivery is idempotent. Made on the user's explicit approval. The "Known
  limitations" section is rewritten accordingly; the ordering skip remains, now with a *decided*
  consumer-side lookback remedy deferred to its own story.
- **R1 findings applied**: `SourceAdapter` (0/2 adoption) replaced by a `Normalizer` function type;
  `matchKey` fields escaped; the API Gateway `source_arn` corrected to a wildcard; `putObjects`
  bounded to the default parallelism of 10; the secret-repository and Events-API-immunity docblocks
  corrected; the two-bucket rule now enforced by branded types.

The core decision — a config-driven template with dual webhook + poller ingestion on one shared S3
write path — is unchanged.
