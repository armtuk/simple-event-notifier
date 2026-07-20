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
