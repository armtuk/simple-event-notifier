---
id: AWE-215
title: Terraform future-state quarantine
type: story
status: todo:backlog
parent: ./feature.md
pm-tool: Airtable
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
- The following move there: `vpc.tf`, `lambda.tf`, `cert.tf`, `apiGateway.tf` (including its
  webhook DNS record and custom domain), and the ALB/logging portions of `network.tf` and `main.tf`.
- **`network.tf` is split, not moved.** `aws_s3_bucket "data_bucket"` is extracted into its own
  `s3.tf` and becomes the event bucket; the logging bucket, its policy and ownership controls, the
  Lambda security group and the availability-zone lookups go to future-state.
- **`main.tf`, `iam.tf` and `outputs.tf` are likewise split, not moved:** `aws_elb_service_account`
  and the Lambda/VPC IAM policies go to future-state; `aws_caller_identity` and anything the bucket
  or DNS needs stays. `outputs.tf`'s `api_base_url` goes; bucket and zone outputs replace it.
- `terraform init` and `terraform plan` succeed against the reduced module with **no errors and no
  references to moved resources** — no orphaned variables, locals or outputs.
- `terraform validate` passes for the active module.
- The future-state area carries a short README stating what is parked, why, and which story is
  expected to restore it (AWE-155, in the GitHub feature).
- **No AWS resources are created or destroyed by this story.** It is a source-tree reorganization;
  nothing has been applied yet, so there is no state to migrate.
- Guidance conformance: HCL is `terraform fmt`-clean; any helper scripts follow
  `.agents/languages/shell.md` and pass `shellcheck`.

### Notes / Open questions

- **This is a split-and-move, not a file move.** Four files contain a mix of keep-and-defer
  resources. Mis-splitting silently strands a resource — either leaving VPC scaffolding active in
  the minimal module, or moving something the bucket depends on. The acceptance criteria enumerate
  the splits deliberately.
- **Open — future-state location.** Candidates: `infra/future-state/`, `infra/modules/future-state/`,
  or a sibling module directory. It must be somewhere Terraform will not auto-load into the active
  module; a nested directory under an active module's path would still be picked up only if
  referenced, but the layout should make the intent obvious to a reader.
- **Open — whether to keep `variables.tf` whole.** Several variables (`aws_region`, `aws_profile`,
  `env`, `project_name`, `parent_domain`) are needed by both the minimal module and the parked
  configuration. Duplicating them is ugly; leaving unused ones is untidy. Decide in `/plan-story`.
- The existing `environments/development/` layout stays; AWE-151 adds `production` alongside it.
- Terraform has never been applied in this repo, which is what makes this cheap — the same
  reorganization after `apply` would require `terraform state mv` for every resource.

<!-- ## Plan is filled in later by /plan-story when this story is about to be worked. -->
