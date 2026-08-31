---
id: AWE-151
title: "IaC: S3 event bucket & delegated DNS (development + production)"
type: story
status: ready
parent: ./feature.md
pm-tool: Airtable
pm-record: recPu1D6pNIIVJ891
pm-url: https://airtable.com/appnae8GXuj1rNVoQ/tblpJmL4dJ7Q4rw3U/recPu1D6pNIIVJ891
branch: feature/minimal-event-pipeline
project: https://airtable.com/appnae8GXuj1rNVoQ/tblQuFDLYQGrcoiTf/recAmtlL5Goesb0p1
created: 2026-06-28
updated: 2026-08-31
---

# Story: IaC: S3 event bucket & delegated DNS (development + production)

## Definition

### User story
As the operator of the personal-events system
I want the AWS foundation provisioned reproducibly with Terraform
So that the event bucket and the project's DNS zones exist deterministically for both
development and production, and can be torn down or recreated without click-ops.

### Acceptance criteria

- **AC-01** — Terraform provisions **one S3 event bucket per environment**, named
  `events.{env}.personal-events.fifthdimensionengineering.com` where `{env}` is the short
  environment name (`dev` or `prod`), with: versioning enabled, **all four**
  public-access-block flags set to `true`, server-side encryption `AES256` (SSE-S3), and a
  lifecycle configuration that transitions current objects to `STANDARD_IA` at 90 days and
  `GLACIER_IR` at 365 days but **never expires a current version**.
- **AC-02** — A **three-level delegated Route53 topology** exists, mirroring the established
  `soulofyoga.fifthdimensionengineering.com` precedent:
  1. a **product zone** `personal-events.fifthdimensionengineering.com`, delegated from the
     existing parent zone `fifthdimensionengineering.com` by an `NS` record set (TTL 300);
  2. a **development zone** `dev.personal-events.fifthdimensionengineering.com`, delegated
     from the product zone by an `NS` record set (TTL 300);
  3. a **production zone** `prod.personal-events.fifthdimensionengineering.com`, delegated
     from the product zone by an `NS` record set (TTL 300).
  No zone's auto-created apex `SOA`/`NS` record set is managed by Terraform.
- **AC-03** — Remote state uses the **pre-existing shared state bucket**
  `terraform.tfstate.us-west-2.fifthdimensionengineering.com` (region `us-west-2`) with
  `encrypt = true` and **`use_lockfile = true`** for native S3 locking. **No DynamoDB lock
  table and no bootstrap module are created.** State keys are
  `fifthd-personal-events/{shared|dev|prod}/terraform.tfstate` — one key per root, never shared.
- **AC-04** — For **every** root module (`shared`, `development`, `production`):
  `terraform fmt -check -recursive` passes, `terraform validate` passes, `terraform plan`
  completes with no errors, and a second `terraform plan` run **after** `terraform apply`
  reports `No changes.` — i.e. zero drift, with no perpetual diff on lifecycle rules or `NS`
  record sets.
- **AC-05** — After apply, `dig +short NS personal-events.fifthdimensionengineering.com`,
  `dig +short NS dev.personal-events.fifthdimensionengineering.com`, and
  `dig +short NS prod.personal-events.fifthdimensionengineering.com` each return the
  nameservers of the corresponding created zone — resolved from the **public** DNS system, not
  merely present in the Route53 API.
- **AC-06** — Inputs are parameterized via variables (`aws_region`, `aws_profile`, `env`,
  `project_name`, `parent_domain`); no account id, domain, region or environment string is
  inlined in a resource body. Outputs expose, per environment: event bucket name and ARN, the
  environment zone id, and its `name_servers`.
- **AC-07** — The **inherited `parent_domain` defect is fixed**: `parent_domain` is
  `fifthdimensionengineering.com` and `project_name` is `personal-events`, so the zone name
  interpolation produces `dev.personal-events.fifthdimensionengineering.com` and **not** the
  currently-configured duplicated `development.simple-eventer.simple-eventer.fifthdimensionengineering.com`.
  `var.env` carries the **short** name (`dev`/`prod`) per
  `.agents/guidance/deployment-environments/aws.md`, while the environment *directories* retain
  their long names (`development/`, `production/`).
- **AC-08** — **Failure modes**, each producing a clear, actionable message rather than a crash
  or a silent partial apply:
  - missing or expired AWS credentials → `plan` fails naming the credential problem;
  - a `parent_domain` whose zone does not exist → the `data "aws_route53_zone"` lookup fails
    with a message naming the missing zone;
  - a bucket name longer than 63 characters → caught by a `validation` block on the variable,
    at plan time, not by an AWS API error;
  - re-running `apply` with no source change is **idempotent** (no resource replaced).
- **AC-09** — Guidance conformance: HCL is split one-responsibility-per-file with no catch-all
  `main.tf`; every environment/account value is a variable
  (`.agents/general.md` "Infrastructure conditionals are not domain code"); `terraform fmt` is
  clean; any helper shell script passes `shellcheck`.

### Notes / Open questions

- **Superseded acceptance criteria, approved 2026-08-31.** Two criteria in this story's prior
  Definition were retired with explicit user approval and are recorded here so the change is not
  silently lost:
  1. *"Remote state: backend configured to an S3 state bucket with a **DynamoDB lock table**;
     the story defines how these are seeded (the chicken-and-egg bootstrap)."* — **Retired.** The
     shared state bucket already exists (measured: 2026-08-30 via
     `aws s3api head-bucket`, 1 day ago relative to conversational context), and Terraform 1.11+
     provides native S3 locking via `use_lockfile`. There is no bootstrap problem and no
     DynamoDB table. Replaced by AC-03.
  2. *"A delegated Route53 hosted zone for `personal-events.fifthdimensionengineering.com`"*
     (singular). — **Retired.** The 2026-08-03 restructure requires both `development` and
     `production`. Replaced by AC-02's three-zone topology.
- **The product zone is owned by a `shared` root, not by an environment root.** This is forced:
  both environment roots call the same `modules/`, so if that module created the product zone,
  `development` and `production` would each try to own
  `personal-events.fifthdimensionengineering.com` and the second `apply` would fail on a
  duplicate zone. The product zone and its delegation from the parent therefore live in
  `infra/environments/shared/`, applied **once and first**; each environment root creates only
  its own environment zone plus that zone's `NS` record inside the product zone.
- **`terraform` is installed and verified: v1.16.0 at `/usr/bin/terraform`** (measured:
  2026-08-31 via `terraform version`). This satisfies AC-03's `use_lockfile` requirement, which
  needs Terraform ≥ 1.11. An earlier note in this file recorded it as *absent* (measured
  2026-08-30); that is superseded — it was installed between the two measurements.
- **This story requires a production write.** Unlike every other story in this feature, its
  acceptance criteria cannot be satisfied without `terraform apply` against the real AWS account
  `269378281721` — creating three Route53 hosted zones (which bill monthly) and two S3 buckets,
  and mutating the parent zone `fifthdimensionengineering.com` by adding an `NS` record set.
  Per `.agents/tests.md` this is **not** covered by execute's automatic read-only authorization.
  **The approval was requested and GRANTED by the user on 2026-08-31**, as specified and without
  modification, covering both `development` and `production`. The granted scope is recorded verbatim
  in `infra-s3-and-dns.acceptance.json` → `thirdPartyIntegration.tests[].productionWriteApproval`.
  Execution does not need to re-ask; anything **beyond** that scope does.
- Depends on **AWE-215 — Terraform future-state quarantine** for the reduced module, and on
  **AWE-149 — Monorepo & tooling bootstrap** for the `infra` workspace member. Does **not**
  depend on the TypeScript track.
- The ACM certificate and any `A`/`ALIAS` records remain deferred to AWE-155 — Generic webhook
  ingest; this story creates zones and delegation only.

## Plan

> Validate provider/CLI versions and the module layout that AWE-215 leaves behind before writing
> resources. This is declarative IaC: organize by concern, keep every account/environment value
> in variables, and make every run idempotent.

### Decisions resolved during planning

- **Layout: extend the inherited `modules/` + `environments/` structure.** The prior version of
  this plan proposed a greenfield `infra/personal-events/` root module. That is **rejected** —
  AWE-215 — Terraform future-state quarantine explicitly reduces and keeps the existing layout
  and directs this story to reconcile to it. A third parallel layout would strand AWE-215's work.
- **Three roots, three state keys.** `infra/environments/shared/` (product zone + parent
  delegation), `infra/environments/development/` (env `dev`), `infra/environments/production/`
  (env `prod`). Each has its own backend key so no root can corrupt another's state.
- **Product name `personal-events`** (user decision, 2026-08-31), matching `system.md`,
  `CLAUDE.md` and the `@personal-events/*` npm scope. The inherited `simple-eventer` defaults are
  a template leftover and are corrected.
- **Bucket naming `events.{env}.personal-events.fifthdimensionengineering.com`** per
  `aws.md`'s `{usage}.{env-short}.{product-domain}` convention. Longest form
  (`events.prod....`) is **57 characters**, within S3's 63-character limit — a `validation`
  block enforces this rather than leaving it to an AWS runtime error.
- **Native S3 state locking** (`use_lockfile = true`), no DynamoDB (user decision, 2026-08-31).
- **Retention: never expire current versions.** `system.md` states S3 is the permanent history,
  so expiry would destroy the product's central promise. Only noncurrent versions are trimmed
  (retain 5, expire after 180 days) and incomplete multipart uploads aborted after 7 days.
- **SSE-S3 (`AES256`), not KMS** — no per-request key cost or key policy management for a
  personal event log.
- **Region `us-west-2`**, matching the existing backend and the inherited `aws_region` default.
  Route53 is global; the buckets and state are regional.
- **The parent zone is referenced by `data "aws_route53_zone"` lookup on
  `fifthdimensionengineering.com.`**, not a hardcoded zone id — portable, and it fails with an
  actionable message when absent (AC-08).

### Acceptance evidence design

- **AC-01 (bucket properties)**
  - *Defining input property*: a real applied bucket in each environment, not a plan preview.
  - *Direct assertions*: `Status: Enabled` from get-bucket-versioning; all four PAB flags
    `true`; `SSEAlgorithm: AES256`; lifecycle JSON contains transitions at 90/365 days and
    **no** `Expiration` key on current versions.
  - *Evidence command*: `bash infra/scripts/verify-bucket.sh events.dev.personal-events.fifthdimensionengineering.com`
  - *Counterexample*: assert the lifecycle document has no `Expiration` member — a rule that
    expires current versions would otherwise pass a naive "lifecycle exists" check.
  - *Environment*: production AWS account `269378281721`.
- **AC-02 / AC-05 (delegation)**
  - *Defining input property*: resolution through the **public** DNS system after apply.
  - *Direct assertions*: `dig +short NS <zone>` returns a non-empty set equal to the zone's
    `name_servers` output for all three zones.
  - *Evidence command*: `bash infra/scripts/verify-dns.sh`
  - *Counterexample*: query a zone that was **not** created
    (`dig +short NS staging.personal-events.fifthdimensionengineering.com`) and assert empty —
    proves the check distinguishes real delegation from a resolver returning the parent's answer.
  - *Environment*: public DNS + production AWS.
- **AC-03 (state/locking)**
  - *Direct assertions*: `terraform init` succeeds against the shared bucket; a
    `.tflock` object appears under the state key during an apply and is released after.
  - *Evidence command*: `terraform -chdir=infra/environments/development init -reconfigure`
  - *Counterexample*: no `dynamodb_table` argument appears anywhere —
    `! rg -q 'dynamodb_table' infra/`.
- **AC-04 (no drift)**
  - *Defining input property*: a plan run **after** a completed apply, not before.
  - *Direct assertions*: exit status 0 and `No changes.` in output.
  - *Evidence command*: `terraform -chdir=infra/environments/development plan -detailed-exitcode`
    (exit code **0** means no diff; **2** means drift and fails this criterion).
  - *Counterexample*: the `-detailed-exitcode` flag is what makes this real — a bare `plan`
    exits 0 even when it reports changes.
- **AC-07 (name correctness)**
  - *Direct assertions*: the planned zone name equals
    `dev.personal-events.fifthdimensionengineering.com` exactly.
  - *Evidence command*:
    `terraform -chdir=infra/environments/development plan -json | rg -q '"dev\.personal-events\.fifthdimensionengineering\.com"'`
  - *Counterexample*: assert the duplicated form is **absent** —
    `! terraform -chdir=infra/environments/development plan -json | rg -q 'simple-eventer\.simple-eventer'`.
- **AC-08 (failure modes)**
  - *Evidence commands*: `AWS_PROFILE=__nonexistent__ terraform -chdir=infra/environments/development plan`
    (expect non-zero + credential message); a `-var 'parent_domain=does-not-exist.invalid'` plan
    (expect the zone-lookup failure message); a `-var 'project_name=<40 chars>'` plan (expect the
    variable `validation` block to reject it at plan time).
- **Complete-set inventory (AC-04 says *every* root module)**: the supported set is exactly
  `infra/environments/{shared,development,production}`. Enumerate with
  `find infra/environments -mindepth 1 -maxdepth 1 -type d` and run fmt/validate/plan against
  each; the expected count is **3** and the verification script asserts that count rather than
  iterating whatever happens to be present.

**Production-write approval — GRANTED 2026-08-31. The question as asked and approved:**

> AWE-151 — IaC: S3 event bucket & delegated DNS cannot be verified without writing to
> production AWS. May I run `terraform apply` against account `269378281721` (`us-west-2`) to
> create: (a) three Route53 public hosted zones — `personal-events.fifthdimensionengineering.com`,
> `dev.` and `prod.` beneath it, billed at roughly $0.50/zone/month; (b) two S3 buckets,
> `events.dev.…` and `events.prod.…`; and (c) **one `NS` record set added to your existing
> parent zone `fifthdimensionengineering.com`**? The parent-zone change is the only mutation to
> pre-existing infrastructure. Rollback is `terraform destroy` in reverse order (parent `NS`
> record first, then the child zones), which returns the account to its current state.

### Architectural constraints — VERIFY BEFORE WRITING ANY TASK

- **Infrastructure conditionals are not domain code** (`.agents/general.md`): every
  account/region/environment-specific value is a Terraform **variable**; nothing is inlined in a
  resource body.
- **Separation by axis of change** (`.agents/general.md`): one responsibility per `.tf` file —
  `versions.tf`, `provider.tf`, `variables.tf`, `outputs.tf`, `s3.tf`, `dns.tf`. The event
  bucket's reason-to-change is not the DNS zone's. Do **not** reintroduce a catch-all `main.tf`.
- **`aws.md` naming**: short environment names in DNS and bucket names
  (`production → prod`, `development → dev`); buckets named `{usage}.{env-short}.{product-domain}`.
- **`aws.md` S3**: versioning is not required by default, but this project explicitly requires it
  (S3 is the source of record) — this is a deliberate project-level deviation, recorded here.
- **Idempotency**: every resource must re-plan clean. The two classic offenders are lifecycle
  rules missing a `filter {}` and managing a zone's auto-created apex `NS`/`SOA`.
- **ADR** (`.agents/guidance/adr.md`): this story adds a new architectural element — the cloud
  substrate, its three-zone delegation topology, and the state backend. Write an ADR under
  `docs/decisions/` following the existing dated-directory convention.

### Files to read — READ THESE BEFORE IMPLEMENTING

- `.agents/plans/minimal-event-pipeline/terraform-future-state-quarantine.md` (AWE-215) —
  Why: defines the exact module layout this story extends, and the three inherited defects it
  fixes. **This story starts from AWE-215's output, not from the current tree.**
- `infra/modules/dns.tf` — Why: currently only a `data` lookup that **creates nothing**; this
  story replaces it with real zone creation. Also the source of the `{env}.{project}.{parent}`
  interpolation pattern to preserve.
- `infra/modules/variables.tf` (all 6 variables) and `infra/environments/development/variables.tf`
  — Why: the defaults to correct (`project_name`, `parent_domain`, `env`).
- `infra/environments/development/provider.tf` — Why: the existing `backend "s3"` block, its
  bucket/key/region, and the `required_providers` pin (`hashicorp/aws 6.57.1`) to mirror.
- `infra/modules/locals.tf` — Why: the shared `tags` local applied to bucket and zones.
- `.agents/guidance/deployment-environments/aws.md` — Why: naming conventions, S3 rules,
  short-environment-name mapping.
- `.agents/plans/system.md` — Why: establishes S3 as permanent history, which is *why* the
  lifecycle policy must not expire current versions.

### Files to create / change

- `infra/environments/shared/{provider.tf,variables.tf,dns.tf,outputs.tf,config/terraform.tfvars}`
  — **new root**: the product zone `personal-events.fifthdimensionengineering.com`, the parent
  `NS` delegation, and outputs (`product_zone_id`, `product_zone_name_servers`). Backend key
  `fifthd-personal-events/shared/terraform.tfstate`.
- `infra/environments/production/{main.tf,provider.tf,variables.tf,config/terraform.tfvars}`
  — **new root**, mirroring `development/` with `env = "prod"` and backend key
  `fifthd-personal-events/prod/terraform.tfstate`.
- `infra/environments/development/provider.tf` — add `use_lockfile = true`, `encrypt = true`;
  change key to `fifthd-personal-events/dev/terraform.tfstate`.
- `infra/environments/development/variables.tf` + `config/terraform.tfvars` — correct
  `project_name = "personal-events"`, `parent_domain = "fifthdimensionengineering.com"`,
  `env = "dev"`.
- `infra/modules/dns.tf` — **replace** the inert data lookup with:
  `data "aws_route53_zone" "product"` (lookup of the product zone),
  `resource "aws_route53_zone" "environment"`, and
  `resource "aws_route53_record" "environment_ns"` (the `NS` set written into the product zone).
- `infra/modules/s3.tf` — extend AWE-215's extracted `data_bucket` into the event bucket:
  rename to `event_bucket`, correct the name to the `events.{env}.…` convention, and add
  `aws_s3_bucket_versioning`, `aws_s3_bucket_public_access_block`,
  `aws_s3_bucket_server_side_encryption_configuration`, `aws_s3_bucket_lifecycle_configuration`.
- `infra/modules/variables.tf` — add `validation` blocks: `env` ∈ `["dev","prod"]`; computed
  bucket name length ≤ 63.
- `infra/modules/outputs.tf` — `event_bucket_name`, `event_bucket_arn`, `environment_zone_id`,
  `environment_zone_name_servers`.
- `infra/scripts/verify-bucket.sh`, `infra/scripts/verify-dns.sh` — the AC evidence commands;
  `shellcheck`-clean, `#!/usr/bin/env bash`, `set -euo pipefail`.
- `infra/README.md` — the runbook: apply order (`shared` → `development` → `production`),
  destroy order (reverse, parent `NS` record first), and the `terraform` install prerequisite.
- `docs/decisions/<YYYY-MM-DD-NNNN-aws-substrate-and-dns-delegation>/adr-body.md` (+ the sibling
  `adr-revision-log.md` / `adr-state-changes.md` files the existing ADRs use) — the ADR.
- `README.md` — add the new ADR to the ADR index table.

### Relevant documentation

- [Terraform S3 backend — `use_lockfile`](https://developer.hashicorp.com/terraform/language/backend/s3)
  — Why: native S3 locking; the DynamoDB arguments are deprecated; lists the extra IAM
  permissions the lock object requires (`s3:DeleteObject` on the lock key).
- [`aws_s3_bucket_lifecycle_configuration`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/s3_bucket_lifecycle_configuration)
  — Why: every rule needs a `filter {}` block or the plan never stabilizes; ordering against
  versioning.
- [`aws_s3_bucket_versioning`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/s3_bucket_versioning)
  — Why: the split-resource model; lifecycle must `depends_on` it.
- [`aws_route53_zone`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/route53_zone)
  and [`aws_route53_record`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/route53_record)
  — Why: the `name_servers` attribute and the delegated-subdomain pattern.
- [`data.aws_route53_zone`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/data-sources/route53_zone)
  — Why: parent/product zone lookup by name, and its failure behaviour when absent (AC-08).
- [AWS provider v6 upgrade guide](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/guides/version-6-upgrade)
  — Why: the pinned provider is `6.57.1`; inline `versioning`/`acl` arguments no longer exist.

### Patterns to follow

- **Delegation, mirroring the measured `soulofyoga` precedent** (verified against Route53
  2026-08-30): the child zone's own nameservers are written into the *parent's* zone as an `NS`
  set with TTL 300 — never hardcoded:
  ```hcl
  resource "aws_route53_record" "environment_ns" {
    zone_id = data.aws_route53_zone.product.zone_id
    name    = "${var.env}.${var.project_name}.${var.parent_domain}"
    type    = "NS"
    ttl     = 300
    records = aws_route53_zone.environment.name_servers
  }
  ```
- **Never manage the apex `SOA`/`NS`** of a zone you create — Route53 creates them, and
  declaring them produces a permanent diff.
- **Lifecycle rule shape** — `filter {}` is mandatory even when empty, and the resource must
  order after versioning:
  ```hcl
  resource "aws_s3_bucket_lifecycle_configuration" "event_bucket" {
    bucket     = aws_s3_bucket.event_bucket.id
    depends_on = [aws_s3_bucket_versioning.event_bucket]
    rule {
      id     = "retain-current-tier-noncurrent"
      status = "Enabled"
      filter {}
      transition { days = 90  storage_class = "STANDARD_IA" }
      transition { days = 365 storage_class = "GLACIER_IR" }
      noncurrent_version_expiration { noncurrent_days = 180 newer_noncurrent_versions = 5 }
      abort_incomplete_multipart_upload { days_after_initiation = 7 }
    }
  }
  ```
  There is deliberately **no `expiration` block** — see AC-01's counterexample.
- **Variable validation over runtime failure:**
  ```hcl
  variable "env" {
    type = string
    validation {
      condition     = contains(["dev", "prod"], var.env)
      error_message = "env must be the short name 'dev' or 'prod' (see aws.md)."
    }
  }
  ```
- **Commit `.terraform.lock.hcl`**; gitignore `.terraform/` and `*.tfstate*`.
- **Tag everything** from the shared `tags` local in `modules/locals.tf`.

### Codebase irregularities to ignore

- **`infra/modules/dns.tf` creates nothing.** It is a `data` lookup for a zone that does not
  exist, plus a misplaced `output`. It is inherited template scaffolding, not a working
  reference — AWE-215 moves the output, and this story replaces the lookup with real zones.
- **The inherited `terraform.tfvars` is empty and the variable defaults are wrong**
  (`project_name = "simple-eventer"`, `parent_domain = "simple-eventer.fifthdimensionengineering.com"`,
  which double-interpolates). Do not preserve these values; AC-07 replaces them.
- **`env` defaults to the long name `development`.** `aws.md` requires the short form in DNS and
  bucket names. The directory stays `development/`; the variable value becomes `dev`.
- **`infra/modules/provider.tf` declares an aliased `us_east_1` provider — it is dead and AWE-215
  deletes it** (decided 2026-08-31). It existed for an edge-optimized/CloudFront ACM certificate;
  AWE-155 — Generic webhook ingest uses a **regional** REST API endpoint with a regional
  certificate and a `REGIONAL`-scope WAF, so nothing in the system needs a `us-east-1` provider.
  This story must not reintroduce it.
- **Online examples still show `dynamodb_table` for locking and inline `versioning`/`acl` on
  `aws_s3_bucket`.** Both are the old pattern. Use `use_lockfile` and the split-resource model.
- **The prior version of this story's own `## Plan` proposed `infra/personal-events/` and an
  `infra/bootstrap/` module.** Both are superseded — see Decisions resolved during planning.

### Step-by-step tasks

Execute in order. Run `terraform validate` after every structural change.

#### VERIFY prerequisites
- **IMPLEMENT**: confirm `terraform` is installed and ≥ 1.11 (required for `use_lockfile`), and
  that AWE-215's quarantine has landed (`infra/future-state/` exists, `infra/modules/s3.tf`
  exists).
- **GOTCHA**: `terraform` was **absent** from this machine as of 2026-08-30. If missing, stop and
  report — do not attempt the story without it.
- **VALIDATE**: `terraform version | head -1` and
  `test -d infra/future-state && test -f infra/modules/s3.tf`

#### UPDATE infra/modules/variables.tf — correct defaults and add validation
- **IMPLEMENT**: `project_name` default `personal-events`; `parent_domain` default
  `fifthdimensionengineering.com`; `env` with a `validation` block restricting to `dev`/`prod`;
  a bucket-name-length validation.
- **PATTERN**: the `validation` block shown in Patterns to follow.
- **VALIDATE**: `terraform -chdir=infra/modules fmt -check && terraform -chdir=infra/modules validate`

#### CREATE infra/environments/shared — product zone + parent delegation
- **IMPLEMENT**: a root module creating `aws_route53_zone "product"` for
  `personal-events.fifthdimensionengineering.com`, a `data "aws_route53_zone" "parent"` lookup on
  `fifthdimensionengineering.com.`, and the `NS` record in the parent. Backend key
  `fifthd-personal-events/shared/terraform.tfstate` with `use_lockfile = true`.
- **GOTCHA**: this root does **not** call `modules/` — it owns only the product zone. Calling the
  shared module here would create a bucket with no environment.
- **VALIDATE**: `terraform -chdir=infra/environments/shared init && terraform -chdir=infra/environments/shared validate`

#### REFACTOR infra/modules/dns.tf — real zone creation and NS delegation
- **IMPLEMENT**: replace the inert lookup with a `data` lookup of the **product** zone, the
  `aws_route53_zone "environment"` resource, and the `aws_route53_record "environment_ns"` set.
- **GOTCHA**: do not manage the new zone's apex `NS`/`SOA` — guaranteed perpetual drift.
- **VALIDATE**: `terraform -chdir=infra/modules validate`

#### REFACTOR infra/modules/s3.tf — the event bucket
- **IMPLEMENT**: rename `data_bucket` → `event_bucket`, set the name to
  `events.${var.env}.${var.project_name}.${var.parent_domain}`, drop `force_destroy`, and add
  versioning, public-access-block (all four flags `true`), SSE-S3, and the lifecycle
  configuration.
- **PATTERN**: the lifecycle block in Patterns to follow — `filter {}` present, **no**
  `expiration`.
- **GOTCHA**: `force_destroy = true` is inherited from the template. The event log is permanent
  history; leave it `false` so a stray `destroy` cannot silently delete events.
- **VALIDATE**: `terraform -chdir=infra/modules validate`

#### UPDATE infra/environments/development — backend, tfvars, module wiring
- **IMPLEMENT**: `use_lockfile = true`, `encrypt = true`, key
  `fifthd-personal-events/dev/terraform.tfstate`; populate `config/terraform.tfvars` with
  `env = "dev"`, `project_name`, `parent_domain`, `aws_region`, `aws_profile`.
- **VALIDATE**: `terraform -chdir=infra/environments/development init -reconfigure && terraform -chdir=infra/environments/development validate`

#### CREATE infra/environments/production — mirror of development
- **IMPLEMENT**: same shape with `env = "prod"` and key
  `fifthd-personal-events/prod/terraform.tfstate`.
- **GOTCHA**: the two roots must not share a state key — that is the single most damaging
  copy-paste error available here.
- **VALIDATE**: `terraform -chdir=infra/environments/production init && terraform -chdir=infra/environments/production validate`
  and `! diff <(rg -o 'key\s*=\s*"[^"]+"' infra/environments/development/provider.tf) <(rg -o 'key\s*=\s*"[^"]+"' infra/environments/production/provider.tf)`

#### CREATE infra/scripts/verify-bucket.sh and verify-dns.sh
- **IMPLEMENT**: the AC-01/AC-02/AC-05 evidence commands, asserting the properties listed in
  Acceptance evidence design, including the negative checks.
- **PATTERN**: `#!/usr/bin/env bash`, `set -euo pipefail`, per `.agents/languages/shell.md`.
- **VALIDATE**: `shellcheck infra/scripts/*.sh`

#### APPLY — production write (only after explicit approval)
- **IMPLEMENT**: apply in order `shared` → `development` → `production`, then run both verify
  scripts and the drift check.
- **GOTCHA**: NS propagation is not instant. Poll `dig` with a bounded retry rather than
  asserting once immediately after apply.
- **VALIDATE**: `terraform -chdir=infra/environments/development plan -detailed-exitcode`
  (exit 0), `bash infra/scripts/verify-dns.sh`, `bash infra/scripts/verify-bucket.sh <name>`

#### WRITE the ADR and the infra runbook
- **IMPLEMENT**: ADR recording Terraform as the IaC tool, the three-zone delegation topology and
  why the product zone is a separate root, native S3 locking, and never-expire retention. Add it
  to the ADR index table in `README.md`. Write `infra/README.md` with apply/destroy order and the
  `terraform` prerequisite.
- **VALIDATE**: `test -f infra/README.md` and the new ADR path appears in `README.md`.

#### REFACTOR — guidance conformance pass
- **IMPLEMENT**: reconcile against `.agents/general.md` and `aws.md` — one concern per file, no
  inlined environment values, consistent tagging, no orphaned variables or outputs left by the
  refactor.
- **VALIDATE**: `terraform -chdir=infra fmt -check -recursive`, `shellcheck infra/scripts/*.sh`,
  and `! rg -q 'simple-eventer' infra/`

### Testing strategy

- **Unit**: n/a — declarative configuration with no logic. `validate` is the type-checker
  analogue.
- **Integration (live, production)**: this story's integration surface **is** AWS. Per
  `.agents/tests.md` the live case executes against the real account: `terraform apply`, then
  `infra/scripts/verify-bucket.sh` and `infra/scripts/verify-dns.sh` assert the applied state via
  the AWS API and public DNS respectively. Credentials resolve through the standard AWS chain
  (`aws_profile` variable → `AWS_PROFILE` → default). **This is a production *write*** and is
  gated on the approval question above — it is not covered by execute's automatic read-only
  authorization.
- **Edge cases / failure modes**: invalid credentials; non-existent parent zone; over-length
  bucket name (plan-time `validation`); duplicate apply (idempotence); `destroy` ordering with
  the parent `NS` record still present.
- **Skip inventory**: none. There are no conditional or opt-in suites in this story; expected
  unexpected-skip count is **0**. The drift check must use `-detailed-exitcode`, since a bare
  `plan` exits 0 while reporting changes and would silently "pass".

### Validation commands

- Level 1 — Format: `terraform -chdir=infra fmt -check -recursive` and `shellcheck infra/scripts/*.sh`
- Level 2 — Validate (all three roots, no credentials needed):
  `for d in shared development production; do terraform -chdir=infra/environments/$d init -backend=false && terraform -chdir=infra/environments/$d validate || exit 1; done`
- Level 3 — Plan (credentials required): same loop with `plan`
- Level 4 — Apply + verify + drift: `bash infra/scripts/verify-dns.sh`,
  `bash infra/scripts/verify-bucket.sh events.dev.personal-events.fifthdimensionengineering.com`,
  and `terraform -chdir=infra/environments/development plan -detailed-exitcode`
