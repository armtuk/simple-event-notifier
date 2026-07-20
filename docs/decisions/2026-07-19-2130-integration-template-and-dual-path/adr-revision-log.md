## 2026-07-19T21:30:00Z — Initial decision recorded — Alex Turner

Written alongside the AWE-153 implementation, the first story of the `github-integration` feature.
Records the config-driven integration template (`@personal-events/integration-core`), the `channel`
trigger discriminant and its rename from the stubs' `source`, the compile-then-lookup classification
path, the mandatory default classification, interfaces-only adapters, and the dual webhook/poller
ingestion design for GitHub with a single shared S3 write path.

One ADR covers the whole feature: AWE-154 through AWE-157 reference this record rather than
authoring their own, and append a revision-log entry here when they make a decision that changes it.
