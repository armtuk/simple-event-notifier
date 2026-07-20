---
id: 2026-07-19-1900-iac-foundation
title: Terraform, native S3 state locking, and a delegated Route53 subdomain for the AWS substrate
status: Accepted
created: 2026-07-19
updated: 2026-07-19
supersedes: none
superseded-by: none
---

# Terraform, native S3 state locking, and a delegated Route53 subdomain for the AWS substrate

## Decision

The AWS substrate for personal-events is provisioned with **Terraform**, in two root modules under
`infra/`:

- `infra/bootstrap/` — runs with **local** state and creates the remote-state bucket
  `tfstate.{env}.{system_domain}`, then migrates its own state into that bucket. Applied once.
- `infra/personal-events/` — the system's substrate: the S3 event bucket and the delegated Route53
  zone. Its state lives in the bucket the bootstrap module created.

Three sub-decisions ride along:

1. **State locking uses native S3 conditional writes (`use_lockfile = true`), not a DynamoDB lock
   table.** The lock object lives beside the state object in the state bucket.
2. **DNS is a delegated subdomain.** A new public hosted zone is created for
   `personal-events.fifthdimensionengineering.com`, and the only record written into the existing
   `fifthdimensionengineering.com` parent zone is the `NS` delegation pointing at it. The parent
   zone is referenced by a `data "aws_route53_zone"` name lookup, not a hardcoded zone id.
3. **The event bucket keeps current object versions forever.** They tier to STANDARD_IA at 90 days
   and GLACIER_IR at 365, but never expire; only superseded (noncurrent) versions are trimmed.

## Context

Every later feature — the webhook ingest Lambda, the fan-out pipe, the Event UI — needs a bucket to
write into and a domain to be reachable at, and needs both to be reproducible rather than
click-opped. This is the first architectural element in the system, so the choices here set the
shape for everything that follows.

Two forces drove the sub-decisions. First, Terraform 1.11 (Feb 2025) made `use_lockfile` GA and
deprecated the DynamoDB lock arguments; provisioning a DynamoDB table in 2026 buys nothing but a
second resource to manage and pay for. Second, `system.md` establishes that **S3 is the source of
record, not a cache** — the bucket *is* the permanent event history, so an expiration lifecycle rule
on current versions would silently delete the system's data.

## Blast radius

- `infra/` in its entirety, and the `infra` workspace member's turbo `plan`/`deploy` tasks.
- Every consumer's configuration: the event bucket name and region are Terraform **outputs**, and
  clients (starting with the desktop notifier) read them into environment variables.
- The parent `fifthdimensionengineering.com` zone, which gains exactly one `NS` record set.
- IAM: producers and consumers are granted access by the bucket ARN output, not by a bucket name
  duplicated into each policy.
- Anyone running `terraform` in this repo must first obtain the state bucket name (via
  `backend.hcl`) — the backend is not self-describing.

## Alternatives & trade-offs

- **CloudFormation / CDK / Pulumi** instead of Terraform — rejected: `.agents/guidance/aws.md`
  mandates Terraform, and it is the tool with the least friction across the mixed
  AWS + Railway topology this system will end up with.
- **DynamoDB lock table** — rejected: deprecated in favour of `use_lockfile`, and an extra resource
  with its own cost and lifecycle for a single-operator project with no concurrent applies.
- **Terraform Cloud / HCP remote state** — rejected: introduces a third-party dependency and an
  account to manage for a personal project whose state is a few kilobytes.
- **Records directly in the parent zone**, no child zone — rejected: it couples every future record
  in this system to write access on the parent zone and forecloses delegating the system to a
  separate AWS account later. The cost is one extra zone (~$0.50/month) and a delegation that must
  be destroyed before the child zone.
- **Expiring old events** — rejected: the bucket is the history. Tiering gets the cost benefit
  without the data loss.
- **SSE-KMS** instead of SSE-S3 — rejected: these are personal notifications, not regulated data;
  KMS adds per-request cost and key administration for no threat-model benefit. Revisit if event
  payloads ever carry secrets.

## Reversibility

**Two-way door for the storage and encryption choices** — the lifecycle policy, encryption mode,
and lock mechanism are all changeable with a single apply and no data migration.

**One-way door in practice for the object-key scheme and the delegated domain.** Once producers have
written objects and consumers have recorded high-water marks, renaming the bucket or restructuring
keys means migrating history. Once the subdomain is delegated and referenced, moving it means a DNS
propagation window. Neither is technically hard; both are disruptive after adoption.

## References

- Implemented in story `AWE-151` (`.agents/plans/bootstrap-and-iac/infra-s3-and-dns.md`) on branch
  `feat/bootstrap-and-iac`.
- Naming conventions: `.agents/guidance/aws.md`.
- [Terraform S3 backend — `use_lockfile`](https://developer.hashicorp.com/terraform/language/backend/s3)
- Runbook: `infra/README.md`.
