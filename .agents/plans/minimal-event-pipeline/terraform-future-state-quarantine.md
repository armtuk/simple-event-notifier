---
id: AWE-215
title: Terraform future-state quarantine
type: story
status: ready
parent: ./feature.md
pm-tool: Airtable
branch: feature/minimal-event-pipeline
project: https://airtable.com/appnae8GXuj1rNVoQ/tblQuFDLYQGrcoiTf/recAmtlL5Goesb0p1
created: 2026-08-03
updated: 2026-08-03
---

# Story: Terraform future-state quarantine

## Definition

### User story

As the person about to provision this system's first real AWS resources
I want the inherited Terraform reduced to only what the minimal pipeline needs, with everything else
parked somewhere explicit
So that `terraform apply` creates a bucket and a DNS zone rather than a VPC, a NAT gateway, a Lambda
and an API Gateway for a system that does not exist yet.

### Acceptance criteria

- A future-state area exists under `infra/` holding the deferred configuration, clearly named and
  **not referenced by any active module**.
- The following move there: `vpc.tf`, `lambda.tf`, `cert.tf`, `apiGateway.tf` (including its webhook
  DNS record and custom domain), and the ALB/logging portions of `network.tf` and `main.tf`.
- **`network.tf` is split, not moved.** `aws_s3_bucket "data_bucket"` is extracted into its own
  `s3.tf` and becomes the event bucket; the logging bucket, its policy and ownership controls, the
  Lambda security group and the availability-zone lookups go to future-state.
- **`main.tf`, `iam.tf`, `outputs.tf` and `locals.tf` are likewise split, not moved:**
  `aws_elb_service_account` and the Lambda/VPC IAM policies go to future-state;
  `aws_caller_identity` and the shared `tags` local stay. `outputs.tf`'s `api_base_url` goes.
- **The pre-existing breakage is fixed** (see Notes): the environment module `source` path, the
  missing required `project_name` argument, and the misplaced `output` inside `dns.tf`.
- `terraform init` and `terraform validate` succeed against the reduced module with **no errors and
  no references to moved resources** — no orphaned variables, locals or outputs.
- `terraform plan` runs to completion. It is **not** expected to be empty — it will still fail or
  show a diff for the event bucket and zone until AWE-151 completes them — but it must not fail on
  *missing references*.
- The future-state area carries a short README stating what is parked, why, and which story restores
  it (AWE-155, in the GitHub feature).
- **No AWS resources are created or destroyed by this story.** It is a source-tree reorganization;
  nothing has been applied, so there is no state to migrate.
- Guidance conformance: HCL is `terraform fmt`-clean; any helper script follows
  `.agents/languages/shell.md` and passes `shellcheck`.

### Notes / Open questions

- **This is a split-and-move, not a file move.** Five files contain a mix of keep-and-defer
  resources. Mis-splitting silently strands a resource — either leaving VPC scaffolding active in
  the minimal module, or moving something the bucket depends on.
- **The inherited config does not currently work.** Three defects found on 2026-08-03, all of which
  this story should fix while it is in these files anyway:
  1. `environments/development/main.tf` sets `source = "../../module"` — the directory is
     `modules` (plural). `terraform init` cannot resolve it.
  2. The same module call omits `project_name`, which `modules/variables.tf` declares with **no
     default**, so it is a required argument.
  3. `modules/dns.tf` declares an `output "name_servers"` inside a resource file rather than in
     `outputs.tf`, and its `data` lookup **creates nothing** — it assumes the zone already exists.
- **Open — future-state location.** `infra/modules/future-state/` already exists on disk and is
  empty. That path sits *inside* the active module directory; Terraform only loads `.tf` files in
  the directory it is invoked on (not recursively), so it is safe — but `infra/future-state/` is
  less likely to mislead a reader. Confirm the choice and, if moving, remove the empty directory.
- **Open — whether to keep `variables.tf` whole.** `aws_region`, `aws_profile`, `env`,
  `project_name` and `parent_domain` are needed by both the minimal module and the parked
  configuration. Duplicating them is ugly; leaving unused ones is untidy. Recommendation: keep the
  five as-is (all are still needed) and move only genuinely Lambda/VPC-specific variables.
- Terraform has **never been applied** in this repo, which is what makes this cheap — the same
  reorganization after `apply` would require `terraform state mv` for every resource.

## Plan

> Validate every reference before and after moving. This story is pure source-tree surgery: its
> success criterion is that `terraform validate` passes on the reduced module and that nothing
> parked is still referenced. Do not restate the user story.

### Decisions resolved during planning

- **Future-state lives at `infra/future-state/`**, a sibling of `modules/` and `environments/`. The
  existing empty `infra/modules/future-state/` is removed. Rationale: a reader scanning
  `infra/modules/` should see only live configuration, and a nested `future-state` inside the active
  module invites someone to `terraform apply` from the wrong directory.
- **Parked files keep their `.tf` extension.** Renaming to `.tf.bak` or similar would lose editor
  support and `terraform fmt`. They are inert because nothing invokes Terraform in that directory.
- **The three inherited defects are fixed here, not deferred.** They sit in exactly the files this
  story edits, and leaving a knowingly-broken `source` path for AWE-151 to trip over would be
  gratuitous.
- **`locals.tf` splits.** `lambda_memory` is future-state; `name`, `author`, `email` and `tags` stay
  — `tags` is applied to the bucket and zones.

### Architectural constraints — VERIFY BEFORE WRITING ANY TASK

- **Infrastructure conditionals are not domain code** (`general.md`): environment/account values stay
  in variables, never inlined.
- **Separation by axis of change** (`general.md`): one responsibility per file. The point of
  extracting `s3.tf` is that the event bucket's reason-to-change is not the logging bucket's.
- **No resource may be created or destroyed** by this story — it must be provably inert. The
  evidence is that `terraform plan` output is unchanged in *substance* before and after (both fail
  or diff identically on the still-incomplete bucket/zone), not that it is empty.
- **`.agents/guidance/deployment-environments/aws.md`**: the naming convention
  `{env}.{system}.{domain}` is what `dns.tf` already encodes; preserve it for AWE-151.

### Files to read — READ THESE BEFORE IMPLEMENTING

- `infra/modules/network.tf` — Why: the primary split. Contains `aws_s3_bucket "data_bucket"`
  (**keep**, becomes the event bucket) alongside `aws_s3_bucket "logging_bucket"`, its ownership
  controls / ACL / public-access-block / policy, `aws_iam_policy_document "s3_logging_bucket_policy"`,
  `aws_security_group "lambda_sg"` and `data "aws_availability_zones" "available"` (**all defer**).
- `infra/modules/main.tf` — Why: `data "aws_elb_service_account" "main"` (defer, ALB logging) versus
  `data "aws_caller_identity" "current"` (keep).
- `infra/modules/iam.tf` — Why: entirely Lambda/VPC-oriented (`lambda_assume_role_document`,
  `lambda_document`, `lambda_policy`, `lambda_role`, `lambda_attachment`, `lambda_vpc_access`) —
  defer all of it. Confirm nothing the bucket needs is hiding here.
- `infra/modules/locals.tf` — Why: the `lambda_memory`/`tags` split described above.
- `infra/modules/dns.tf` and `infra/modules/outputs.tf` — Why: the misplaced output, and
  `api_base_url` which references `aws_api_gateway_deployment` and must leave with it.
- `infra/environments/development/main.tf` — Why: the broken `source` path and missing
  `project_name`.
- `.agents/guidance/deployment-environments/aws.md` — Why: the naming and S3 conventions AWE-151
  builds on.

### Files to create / change

- `infra/future-state/` — new directory holding `vpc.tf`, `lambda.tf`, `cert.tf`, `apiGateway.tf`,
  plus new `network-logging.tf`, `iam-lambda.tf`, `main-alb.tf`, `locals-lambda.tf` and
  `outputs-api.tf` receiving the split-out fragments.
- `infra/future-state/README.md` — what is parked, why, and that AWE-155 restores it.
- `infra/modules/s3.tf` — **new**, receiving `aws_s3_bucket "data_bucket"` from `network.tf`.
- `infra/modules/network.tf` — reduced or deleted if nothing remains after the split.
- `infra/modules/main.tf`, `iam.tf`, `locals.tf`, `outputs.tf`, `dns.tf` — reduced.
- `infra/environments/development/main.tf` — fixed `source` path, `project_name` passed through.
- `infra/environments/development/config/terraform.tfvars` — populated (currently empty).
- Remove the empty `infra/modules/future-state/` directory.

### Relevant documentation

- [Terraform: module sources](https://developer.hashicorp.com/terraform/language/modules/sources)
  — Why: the local-path `source` semantics behind defect #1.
- [Terraform: files and directories](https://developer.hashicorp.com/terraform/language/files)
  — Why: confirms Terraform loads `.tf` only from the invoked directory, **not** recursively, which
  is what makes a sibling `future-state/` inert.
- [`terraform validate`](https://developer.hashicorp.com/terraform/cli/commands/validate)
  — Why: the primary gate for this story; it catches dangling references without needing credentials.

### Patterns to follow

- **Split by moving whole resource blocks**, never by editing their bodies. If a block needs changing
  to survive the split, that is AWE-151's work, not this story's — record it and move on.
- **Fix the module call minimally:**
  ```hcl
  module "personal-events" {
    source = "../../modules"          # was "../../module" — broken
    aws_region    = var.aws_region
    aws_profile   = var.aws_profile
    env           = var.env
    project_name  = var.project_name  # was missing; variables.tf declares it with no default
    parent_domain = var.parent_domain
  }
  ```
- **Move the stray output**: `output "name_servers"` goes from `dns.tf` into `outputs.tf`. Leave the
  `data "aws_route53_zone"` lookup in place — AWE-151 replaces it with real zone creation.
- **Validate after every move**, not once at the end. A dangling reference is far cheaper to find
  against the single move that caused it.

### Codebase irregularities to ignore

- **The inherited Terraform is a template for a different system.** It provisions an ALB-fronted,
  VPC-resident Lambda API. Do not treat any of it as evidence of intended architecture for this
  system — the intended architecture is ADR `2026-08-03-0028-layered-architecture` plus
  `.agents/guidance/deployment-environments/aws.md`.
- **`modules/` is plural, and one file says `module` singular.** The plural directory is correct;
  the reference is the defect.
- **`.agents/plans/minimal-event-pipeline/infra-s3-and-dns.md` (AWE-151) proposes a different layout**
  (`infra/personal-events/` as a fresh root module). That plan predates the decision to extract from
  the inherited template. **This story keeps the existing `modules/` + `environments/` layout**;
  AWE-151's re-plan reconciles to it.

### Step-by-step tasks

Execute in order, top to bottom. Run `terraform validate` after each move.

#### CREATE `infra/future-state/` and its README
- **IMPLEMENT**: the directory plus a README naming what is parked, why (F1 delivers only bucket +
  DNS), and that AWE-155 restores the API Gateway/Lambda/cert set.
- **IMPLEMENT**: remove the empty `infra/modules/future-state/`.
- **VALIDATE**: `test -f infra/future-state/README.md && ! test -d infra/modules/future-state`

#### MOVE whole-file deferrals
- **IMPLEMENT**: `git mv` `vpc.tf`, `lambda.tf`, `cert.tf`, `apiGateway.tf` from `infra/modules/` to
  `infra/future-state/`.
- **GOTCHA**: use `git mv` so history follows the files.
- **VALIDATE**: `cd infra/modules && terraform fmt -check` (expect reference errors at this stage —
  the next tasks resolve them)

#### SPLIT `network.tf` → `s3.tf` + future-state
- **IMPLEMENT**: move `aws_s3_bucket "data_bucket"` into a new `infra/modules/s3.tf`. Move the
  logging bucket, its ownership controls, ACL, public-access-block, policy, the
  `s3_logging_bucket_policy` data source, `aws_security_group "lambda_sg"` and
  `data "aws_availability_zones" "available"` into `infra/future-state/network-logging.tf`.
- **GOTCHA**: the logging bucket policy references `aws_elb_service_account` from `main.tf` — both
  move to future-state, so the reference stays intact *within* future-state.
- **GOTCHA**: if `data_bucket` references anything VPC/logging-related, note it and leave the
  reference for AWE-151 to resolve — do not silently rewrite the block.
- **VALIDATE**: `cd infra/modules && terraform validate`

#### SPLIT `main.tf`, `iam.tf`, `locals.tf`, `outputs.tf`
- **IMPLEMENT**: `aws_elb_service_account` → `future-state/main-alb.tf`; all six Lambda/VPC IAM
  blocks → `future-state/iam-lambda.tf`; `lambda_memory` → `future-state/locals-lambda.tf`;
  `api_base_url` → `future-state/outputs-api.tf`. Keep `aws_caller_identity` and the `tags`/`name`
  locals in `infra/modules/`.
- **GOTCHA**: a `locals` block cannot be split across files with the same name in the same
  directory — but future-state is a *different* directory, so a second `locals` block there is fine.
- **VALIDATE**: `cd infra/modules && terraform validate`

#### FIX the inherited defects
- **IMPLEMENT**: correct `source` to `../../modules`; pass `project_name`; move `output
  "name_servers"` from `dns.tf` to `outputs.tf`; populate `terraform.tfvars` with `project_name`,
  `parent_domain`, `aws_region`, `aws_profile`, `env` for the development environment.
- **GOTCHA**: `environments/development/variables.tf` must declare `project_name` too, or the
  root-level `var.project_name` reference in `main.tf` will not resolve.
- **VALIDATE**: `cd infra/environments/development && terraform init -backend=false && terraform validate`

#### VERIFY the quarantine is complete and inert
- **IMPLEMENT**: grep the active module for any reference to a parked resource type.
- **VALIDATE**:
  `! rg -q 'aws_(vpc|subnet|nat_gateway|lambda_|api_gateway|acm_|security_group|elb_service_account)' infra/modules/`
  and `cd infra/modules && terraform fmt -check && terraform validate`

### Testing strategy

- **Unit**: n/a — declarative configuration with no logic.
- **Integration**: `terraform init -backend=false` + `terraform validate` on both
  `infra/modules/` and `infra/environments/development/`. These need no AWS credentials and are the
  real gate for this story.
- **Edge cases**: a resource moved to future-state that is still referenced from the active module
  (caught by `validate`); an orphaned variable or local left behind (caught by the grep); the
  `future-state` directory being accidentally loadable (verified by `terraform validate` in
  `infra/modules/` not seeing those resources).
- **Explicitly not tested**: `terraform plan` against real AWS. This story creates nothing, and
  planning requires credentials plus a zone that AWE-151 has not yet created.

### Validation commands

- Level 1 — Format: `cd infra && terraform fmt -recursive -check`
- Level 2 — Active module: `cd infra/modules && terraform init -backend=false && terraform validate`
- Level 3 — Environment root: `cd infra/environments/development && terraform init -backend=false && terraform validate`
- Level 4 — Quarantine proof:
  `! rg -q 'aws_(vpc|subnet|nat_gateway|lambda_|api_gateway|acm_|security_group|elb_service_account)' infra/modules/`
