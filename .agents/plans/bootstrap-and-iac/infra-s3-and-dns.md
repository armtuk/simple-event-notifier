---
id: AWE-151
title: "IaC: S3 event bucket & Route53 delegated zone (Terraform)"
type: story
status: Implementation Adjustment
parent: ./feature.md
branch: feat/bootstrap-and-iac
project: https://airtable.com/appnae8GXuj1rNVoQ/tblQuFDLYQGrcoiTf/recAmtlL5Goesb0p1
created: 2026-06-28
updated: 2026-07-19
---

# Story: IaC — S3 event bucket & Route53 delegated zone (Terraform)

## Definition

### User story
As the operator of the personal-events system
I want the AWS foundation provisioned reproducibly with Terraform
So that the event bucket and the project's DNS zone exist deterministically and can be torn
down or recreated without click-ops.

### Acceptance criteria
- A Terraform project under `infra/` provisions:
  - An **S3 event bucket** with versioning enabled, sensible lifecycle rules, public access
    fully blocked, and server-side encryption.
  - A **delegated Route53 hosted zone** for `personal-events.fifthdimensionengineering.com`:
    a new public hosted zone for the subdomain, plus the `NS` delegation record set added to
    the existing `fifthdimensionengineering.com` parent zone pointing at the new zone's
    nameservers.
- **Remote state**: backend configured to an S3 state bucket with a DynamoDB lock table; the
  story defines how these are seeded (the chicken-and-egg bootstrap) before `terraform init`.
- Inputs are parameterized via variables (parent zone id/name, subdomain, bucket name,
  region, tags); useful values (bucket name/ARN, zone id, nameservers) are exposed as outputs.
- `terraform fmt -check` and `terraform validate` pass; `terraform plan` is clean and a second
  `plan` after `apply` shows **no drift**.
- After `apply`, querying the parent zone returns an `NS` record for
  `personal-events.fifthdimensionengineering.com` delegating to the new zone.
- **Failure modes:** missing/incorrect AWS credentials fail with a clear error; a
  non-existent parent zone fails the plan with an actionable message; re-apply is idempotent.

### Notes / Open questions
- Parent zone `fifthdimensionengineering.com` is assumed to already exist and be writable by
  the credentials used (confirmed by the user). `/plan-story` should decide whether to
  reference it via `data "aws_route53_zone"` lookup or an injected zone-id variable.
- The SNS/SQS fan-out queue with TTL is **out of scope** here (later feature); this story is
  bucket + DNS + state only. The desktop client polls the bucket directly.
- Open: AWS region, exact bucket naming convention, and lifecycle/expiration policy (README
  suggests events stay queryable as history — likely no expiration, or a long one).
- Open: ACM certificate + any `A`/`ALIAS` records are deferred until the API Gateway/UI
  features need them; this story creates only the zone + delegation.
- Depends on **monorepo-bootstrap** (AWE-149) for the `infra` workspace member + wrapper
  script; Terraform/HCL itself sits outside the TS build graph.

## Plan

> Validate provider/CLI versions and the backend story before writing resources. This is
> declarative IaC: organize by concern (one file per responsibility), keep all environment /
> account-specific values in variables, and make every run idempotent.

### Decisions resolved during planning (open questions answered)
- **State locking: use native S3 locking (`use_lockfile = true`), NOT a DynamoDB table.**
  Terraform 1.11 (Feb 2025) made `use_lockfile` GA and deprecated the DynamoDB lock args. For
  a 2026 greenfield project there is no reason to provision DynamoDB. (The acceptance criterion
  mentioning a DynamoDB table is **superseded** — flagged for the user; the lock file lives in
  the state bucket via S3 conditional writes.)
- **Parent zone reference: `data "aws_route53_zone"` lookup by name** (`name =
  "fifthdimensionengineering.com."`, `private_zone = false`), not a hardcoded zone id — keeps
  the config portable and fails clearly if the zone is absent.
- **Lifecycle / retention: retain current versions indefinitely** (events are permanent
  history per the README): tier current objects to STANDARD_IA (90d) then GLACIER_IR (365d),
  but **no expiration** of current versions; only trim *noncurrent* versions (keep ≥5, expire
  after 180d) and abort incomplete multipart uploads after 7d.
- **Encryption:** SSE-S3 (`AES256`) — no KMS cost/complexity for this use case.
- **Region:** parameterized via `var.region`, default `us-east-1` (confirm; Route53 is global
  but the bucket and state backend are regional).
- **Bootstrap:** a separate `infra/bootstrap/` module with **local** state creates the state
  bucket, then migrates its own state into it (`-migrate-state`). The main root module
  (`infra/personal-events/`) uses the S3 backend with `use_lockfile`.

### Architectural constraints — VERIFY BEFORE WRITING ANY TASK
<!-- From .agents/general.md (infrastructure-as-config), .agents/guidance/adr.md. -->
- **Infrastructure conditionals are not domain code** (`general.md`): all account/region/
  environment-specific values are Terraform **variables**, never inlined. No domain logic here.
- **Separation by axis of change** (`general.md`): split the config into `versions.tf`,
  `providers.tf`, `backend.tf`, `variables.tf`, `outputs.tf`, `s3.tf`, `dns.tf` — each file one
  responsibility. Do not pile everything into `main.tf`.
- **ADR** (`.agents/guidance/adr.md`): this story adds a new architectural element (the cloud
  substrate + state backend). **Write a short ADR** recording the IaC-tool choice (Terraform),
  the native-S3-locking decision, and the delegated-subdomain approach.
- **Idempotency**: every resource must re-plan clean (no perpetual diffs) — especially the
  Route53 NS record and lifecycle rules.

### Files to read — READ THESE BEFORE IMPLEMENTING
- `.agents/guidance/adr.md` — Why: ADR format for the infra decisions.
- `.agents/languages/shell.md` — Why: the `infra` member's wrapper script (plan/apply) and any
  bootstrap helper script follow shell conventions.
- `.agents/plans/bootstrap-and-iac/monorepo-bootstrap.md` (this feature) — Why: the `infra`
  stub `package.json` + turbo `plan`/`deploy` passthrough tasks defined there; mirror them.
- `.agents/plans/system.md` — Why: confirms the domain `personal-events.fifthdimensionengineering.com`
  and that S3 is the source of record (drives retention policy).

### Files to create / change
- `infra/package.json` — stub member (`@personal-events/infra`, private) with
  `plan`/`deploy`/`lint` scripts wrapping terraform, so it joins the turbo graph (`cache:false`
  on deploy; AWS creds via `passThroughEnv`).
- `infra/bootstrap/{versions.tf,main.tf,backend.tf,outputs.tf}` — local-state module that
  creates the Terraform **state bucket** (versioned, public-access-blocked, SSE), then adopts
  the S3 backend and migrates.
- `infra/personal-events/versions.tf` — `required_version >= 1.11, < 2.0`;
  `required_providers { aws = { source = "hashicorp/aws", version = "~> 6.0" } }`.
- `infra/personal-events/providers.tf` — `provider "aws" { region = var.region }`.
- `infra/personal-events/backend.tf` — `backend "s3"` with `bucket`, `key`, `region`,
  `encrypt = true`, `use_lockfile = true`.
- `infra/personal-events/variables.tf` — `region`, `parent_zone_name`, `subdomain`,
  `event_bucket_name`, `tags`.
- `infra/personal-events/s3.tf` — `aws_s3_bucket` + `aws_s3_bucket_versioning` +
  `aws_s3_bucket_public_access_block` + `aws_s3_bucket_server_side_encryption_configuration` +
  `aws_s3_bucket_lifecycle_configuration` (split-resource model).
- `infra/personal-events/dns.tf` — `data "aws_route53_zone" "parent"`,
  `aws_route53_zone "personal_events"`, `aws_route53_record "ns_delegation"` (NS in parent).
- `infra/personal-events/outputs.tf` — bucket name/ARN, child zone id, `name_servers`.
- `infra/README.md` — bootstrap + apply runbook.
- `.agents/plans/bootstrap-and-iac/adr/0001-iac-foundation.md` (or repo ADR dir) — the ADR.

### Relevant documentation
- [Terraform S3 backend (`use_lockfile`)](https://developer.hashicorp.com/terraform/language/backend/s3)
  — Why: native S3 locking; DynamoDB deprecation; required lock-file IAM perms.
- [`aws_s3_bucket`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/s3_bucket)
  + [`_versioning`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/s3_bucket_versioning)
  + [`_lifecycle_configuration`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/s3_bucket_lifecycle_configuration)
  + [`_public_access_block`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/s3_bucket_public_access_block)
  + [`_server_side_encryption_configuration`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/s3_bucket_server_side_encryption_configuration)
  — Why: the v6 split-resource model (inline args removed).
- [`data.aws_route53_zone`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/data-sources/route53_zone)
  + [`aws_route53_zone`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/route53_zone)
  + [`aws_route53_record`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/route53_record)
  — Why: delegated-subdomain pattern; `name_servers` attribute wiring.
- [AWS provider v6 upgrade guide](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/guides/version-6-upgrade)
  — Why: breaking changes to be aware of on v6.

### Patterns to follow
- **Versions:** Terraform CLI `>= 1.11` (pin CI to a specific 1.15.x), `hashicorp/aws ~> 6.0`;
  **commit `.terraform.lock.hcl`**, gitignore `.terraform/` and `*.tfstate*`.
- **Lifecycle gotcha:** `aws_s3_bucket_lifecycle_configuration` must
  `depends_on = [aws_s3_bucket_versioning.event_log]` and every `rule` needs a `filter {}`.
- **NS delegation:** `records = aws_route53_zone.personal_events.name_servers`, `type = "NS"`,
  low `ttl` (300) initially; never hardcode nameservers; do NOT manage the child zone's
  auto-created apex SOA/NS (causes perpetual drift).
- **Destroy order:** destroy the parent NS record before the child zone
  (`-target` the NS record first) — note in the runbook.

### Codebase irregularities to ignore
- Online examples still show `dynamodb_table` for state locking and inline `versioning`/`acl`
  args on `aws_s3_bucket` — both are the **old** pattern. Use `use_lockfile` and the
  split-resource model respectively.
- The Definition's acceptance criterion names a "DynamoDB lock table"; the resolved plan
  supersedes it with native S3 locking (flagged to user). Update the criterion's wording on
  acceptance if the user agrees.

### Step-by-step tasks
Execute in order.

#### CREATE infra/bootstrap module (state bucket) and migrate
- **IMPLEMENT**: local-state module creating the versioned, locked-down state bucket; then add
  `backend.tf` and `terraform init -migrate-state`.
- **GOTCHA**: state bucket name must be globally unique; keep `force_destroy = false`.
- **VALIDATE**: `cd infra/bootstrap && terraform init && terraform apply` then
  `terraform init -migrate-state` succeeds; `terraform plan` clean.

#### CREATE infra/personal-events root config (versions/providers/backend/variables)
- **IMPLEMENT**: the four config files + variables with descriptions/types/defaults.
- **VALIDATE**: `cd infra/personal-events && terraform init && terraform validate && terraform fmt -check`.

#### CREATE s3.tf (event bucket, split-resource model)
- **IMPLEMENT**: bucket + versioning + public-access-block + SSE + lifecycle per decisions.
- **PATTERN**: research §1 example; `depends_on` versioning for lifecycle.
- **VALIDATE**: `terraform plan` shows the bucket set with no errors.

#### CREATE dns.tf (delegated zone + NS delegation) and outputs.tf
- **IMPLEMENT**: parent data lookup, child zone, NS record in parent; outputs for bucket + zone
  + nameservers.
- **VALIDATE**: `terraform plan` clean; after `apply`, `dig NS personal-events.fifthdimensionengineering.com`
  (and a query against the parent zone) returns the child zone's nameservers; re-`plan` = no drift.

#### WRITE ADR + infra/README runbook
- **IMPLEMENT**: ADR 0001 (Terraform choice, native S3 locking, delegated subdomain); runbook
  for bootstrap → apply → destroy order.
- **VALIDATE**: peer-readable; links resolve.

#### REFACTOR — guidance conformance pass (HCL hygiene + general.md for TS/shell)
- **IMPLEMENT**: Reconcile against the guidance: HCL is split one-concern-per-file (no
  catch-all `main.tf`), every account/region/environment value is a **variable** (infrastructure
  conditionals are not domain code, `general.md`), and resource naming/tagging is consistent.
  Any TS/shell wrapper (the `infra` member scripts, the bootstrap helper) follows
  `.agents/languages/shell.md` / `.agents/languages/typescript/*` — pure helpers, explicit
  types, no accumulator loops, clear error messages.
- **VALIDATE**: `terraform -chdir=infra/personal-events fmt -check -recursive` and `validate`
  clean; any shell scripts pass `shellcheck`.

### Testing strategy
- **Validation-as-test**: `terraform fmt -check`, `terraform validate`, and a clean
  `terraform plan` are the primary gates (no unit-test framework for HCL).
- **Integration** (per `.agents/tests.md`, real infra): `terraform apply` into the real
  account, then assert: bucket exists with versioning+PAB+SSE (`aws s3api get-bucket-versioning`
  etc.), and DNS delegation resolves (`dig`/`aws route53 list-resource-record-sets`). Tear down
  with `terraform destroy` (NS record first).
- **Edge cases / failure modes**: run a `plan` with no/invalid AWS creds (clear error); with a
  wrong `parent_zone_name` (data lookup fails actionably); re-apply is idempotent.

### Validation commands
- Level 1 — Format/validate: `terraform -chdir=infra/personal-events fmt -check -recursive` and
  `terraform -chdir=infra/personal-events validate`
- Level 2 — Plan (no apply): `terraform -chdir=infra/personal-events plan`
- Level 3 — Apply + verify: `terraform -chdir=infra/personal-events apply`, then
  `aws s3api get-bucket-versioning --bucket <name>` and
  `dig +short NS personal-events.fifthdimensionengineering.com`
- Level 4 — Drift check: a second `terraform -chdir=infra/personal-events plan` reports
  "No changes."

## Execution notes (2026-07-19)

Deltas from the plan as written, and why:

- **Layout is `infra/bootstrap/` + `infra/personal-events/`** as planned, with an extra `locals.tf`
  in each (the derived bucket names and the merged tag map have their own axis of change from the
  input variables). `s3.tf` is named `state-bucket.tf` in the bootstrap module — it creates the
  state bucket, not the event bucket, and the filename should say so.
- **Terraform CLI in use is 1.15.7**; `required_version = ">= 1.11, < 2.0"` as planned.
  AWS provider resolved under `~> 6.0`. `.terraform.lock.hcl` is committed for both modules.
- **The backend is configured but deliberately not wired to a real bucket.** `personal-events/backend.tf`
  carries only the non-environment-specific settings (`key`, `encrypt`, `use_lockfile`); the bucket
  and region arrive at init time via `-backend-config=backend.hcl` (a `.example` is committed, the
  real file is gitignored). The bootstrap module's own backend ships as `backend.tf.example` so a
  clean checkout can run `terraform init -backend=false && terraform validate` with no AWS account
  behind it. **No DynamoDB lock table** — native S3 locking, as resolved during planning.
- **`aws_s3_bucket_ownership_controls` with `BucketOwnerEnforced` added** to both buckets. Not in
  the plan; it disables ACLs entirely, which is the current AWS default posture and closes the ACL
  vector that `block_public_acls` only partly covers.
- **`default_tags` on the provider** rather than a `tags` argument repeated on every resource — one
  place to change, and it covers resources added later for free.
- **Retention as resolved:** current versions tier to STANDARD_IA at 90d and GLACIER_IR at 365d and
  **never expire**; noncurrent versions keep the newest 5 and expire after
  `var.noncurrent_version_retention_days` (180); incomplete multipart uploads abort after 7d. Every
  rule carries a `filter {}` and the lifecycle config `depends_on` the versioning resource.
- **ADR written to `docs/decisions/2026-07-19-1900-iac-foundation/`** (the canonical location in
  `.agents/guidance/adr.md`), not to a `.agents/plans/.../adr/` directory as the plan's file list
  suggested. Indexed in the root `README.md`.
- **Acceptance-criterion wording superseded:** the Definition says "a DynamoDB lock table". The
  implementation uses native S3 locking (`use_lockfile`). Recommend the user amend the criterion.
- `shellcheck` is not installed on this machine, and no shell scripts were written — the `infra`
  member's wrapper is `package.json` scripts calling `terraform` directly, so there is nothing for
  it to check.

## Deferred verification — NOT met under the code-and-dry-run fence

This story was executed under an explicit constraint: **no command that creates, modifies, or
deletes real AWS resources.** The following acceptance criteria therefore remain **unverified**.
They are not failures and they are not met — they are untested.

| Acceptance criterion | Status | Command the user must run to close it |
| :--- | :--- | :--- |
| `terraform apply` creates the event bucket and the delegated zone | **Unverified** | `terraform -chdir=infra/personal-events apply` (after the bootstrap runbook in `infra/README.md`) |
| Querying the parent zone returns an `NS` record delegating `personal-events.fifthdimensionengineering.com` | **Unverified** | `dig +short NS personal-events.fifthdimensionengineering.com` |
| A second `plan` after `apply` shows no drift | **Unverified** | `terraform -chdir=infra/personal-events plan` → expect "No changes." |
| Bucket versioning / public-access-block / SSE are actually set on the live bucket | **Unverified** | `aws s3api get-bucket-versioning`, `get-public-access-block`, `get-bucket-encryption` |
| Re-apply is idempotent | **Unverified** | a second `terraform apply` |
| Remote state initializes against the S3 backend with `use_lockfile` | **Unverified** | the bootstrap runbook, then `terraform init -backend-config=backend.hcl` |
| A non-existent parent zone fails the plan with an actionable message | **Unverified** | `terraform -chdir=infra/personal-events plan -var parent_zone_name=does-not-exist.example` |
| Missing/incorrect credentials fail with a clear error | **Unverified** | `AWS_PROFILE=nope terraform -chdir=infra/personal-events plan` |

**No NS records were written into the live `fifthdimensionengineering.com` zone.**

### What WAS verified

- `terraform fmt -check -recursive` clean across both modules (also runs as the `infra` member's
  turbo `lint` task).
- `terraform -chdir=<root> init -backend=false -input=false && terraform -chdir=<root> validate` —
  **Success** for both `bootstrap/` and `personal-events/`, from a clean checkout with `.terraform/`
  removed. This is exactly what `pnpm --filter @personal-events/infra validate` runs.
- **A real, clean `terraform plan`.** Run against a scratch copy of `personal-events/` with
  `backend.tf` removed (so local state was used and the non-existent remote-state bucket was not
  touched): `Plan: 8 to add, 0 to change, 0 to destroy` with **no errors**. Nothing was applied.
  - The `data "aws_route53_zone" "parent"` lookup **resolved against the real account**
    (zone id `Z022596723T54QKGKXEYR`), so the parent zone exists, is readable by the configured
    credentials, and `aws_route53_record.system_delegation` is correctly targeted at it.
  - Planned resources: the bucket plus its public-access-block, ownership-controls, versioning,
    SSE, and lifecycle configurations; the child hosted zone; and the parent-zone NS record.
  - Computed outputs resolved as expected —
    `event_bucket_name = "events.prod.personal-events.fifthdimensionengineering.com"`,
    `system_domain = "personal-events.fifthdimensionengineering.com"`.


## R1 review fixes (2026-07-19)

Applied after the independent R1 pass (`claude-automated-code-review.md` → `## R1 — 2026-07-19`).

- **#8 MINOR (dry-wet) — the six-resource hardened-bucket block was duplicated** across
  `bootstrap/state-bucket.tf` and `personal-events/s3.tf`, along with a byte-identical `versions.tf`.
  The axis of change is "how we harden an S3 bucket", and it changed in two places. Extracted
  `infra/modules/hardened-bucket/`, parameterized by `bucket_name`, `transitions`,
  `noncurrent_version_retention_days`, `newer_noncurrent_versions_kept`, and
  `abort_incomplete_upload_days`; both roots now call it. The bootstrap module uses it too — its
  bootstrapping constraint is about *Terraform state*, not module resolution, and a local module
  directory is just files on disk. That reasoning is now a comment in `state-bucket.tf` rather than
  left implicit.
  - Resource addresses moved to `module.event_log.*` / `module.state.*`. **No state exists yet, so no
    `terraform state mv` is required** — but if this branch is ever rebased onto an applied state, a
    `state mv` per resource is the migration. The bootstrap root's lifecycle **rule id** also changed,
    from `trim-superseded-state-versions` to the module's `trim-superseded-versions`; the retention
    values are identical, and because a rule id is a child of `aws_s3_bucket_lifecycle_configuration`
    it is an in-place update of that resource, not a destroy.
  - **Re-planned after the refactor:** still `Plan: 8 to add, 0 to change, 0 to destroy`, the same
    eight resources, the same parent-zone lookup (`Z022596723T54QKGKXEYR`), and — in the
    `personal-events` root — all three lifecycle rules intact (`tier-current-versions` 90d→STANDARD_IA / 365d→GLACIER_IR, `trim-superseded-versions`
    keep-5 / 180d, `abort-incomplete-uploads` 7d).
- **#16 MINOR (docs) — `infra/README.md` claimed `pnpm … validate` was an offline check; it was not.**
  The script was a bare `terraform validate` with no `init`, which fails on a clean checkout
  (`.terraform/` is gitignored) with *"Module not installed"*, and `bootstrap` had no `validate`
  script at all despite this story claiming both modules validate. Both scripts now run
  `init -backend=false -input=false` first, `validate` covers **both** roots, and `lint` is a single
  recursive `fmt -check` that also covers the new shared module. Verified from a clean checkout with
  `.terraform/` deleted.
- **#17 NIT — two deferred-verification commands omitted `-chdir`** and so would have failed from the
  repo root for the wrong reason. Corrected above; the table is now copy-pasteable.
- **#20 NIT — dotted bucket names force path-style addressing.** Not a deviation (it follows
  `.agents/guidance/aws.md` exactly), but now recorded as a conscious trade-off in the ADR's
  "Accepted trade-off: dotted bucket names" section rather than left implicit.

**Nothing in this round changed the fence position:** no `terraform apply`, no AWS resource created,
no NS record written into the live `fifthdimensionengineering.com` zone. Every row in the
"Deferred verification" table above still stands as written.
