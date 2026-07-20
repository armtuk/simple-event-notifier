## 2026-07-19T19:00:00Z — Initial decision recorded — Alex Turner

First draft, written alongside the AWE-151 implementation. Records the Terraform choice, the
two-root-module bootstrap for remote state, native S3 locking in place of a DynamoDB lock table,
the delegated-subdomain DNS approach, and the never-expire retention policy for the event bucket.

## 2026-07-19T21:00:00Z — Extracted the shared hardened-bucket module; recorded the dotted-bucket-name trade-off — Alex Turner

Following R1 code review (findings #8 and #20). The six-resource bucket-hardening block was
duplicated across both root modules; it now lives in `infra/modules/hardened-bucket/` and both roots
call it, with retention and tiering as inputs. Resource addresses moved under `module.event_log.*` /
`module.state.*`; no state existed yet, so no `terraform state mv` was needed. Separately, the
dotted-bucket-name consequence (path-style addressing only, no same-name CloudFront origin) is now
recorded as an accepted trade-off rather than left implicit. The decision itself is unchanged.
