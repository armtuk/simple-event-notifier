# `infra/` — the personal-events AWS substrate

Terraform for the S3 event bucket and the delegated Route53 zone. See ADR
[`2026-07-19-1900-iac-foundation`](../docs/decisions/2026-07-19-1900-iac-foundation/adr-body.md)
for why it is shaped this way.

| Module | Kind | State | Creates | Applied |
| :--- | :--- | :--- | :--- | :--- |
| `bootstrap/` | root | local, then migrated into the bucket it creates | the Terraform remote-state bucket | once, by hand |
| `personal-events/` | root | remote (S3 + `use_lockfile`) | the S3 event bucket, the operational-state bucket, the delegated hosted zone, the `NS` delegation in the parent zone, the webhook ingest (Lambda + HTTP API + `hooks.` hostname + the GitHub secret), and the github poller (an EventBridge-scheduled Lambda + its two SSM PAT parameters) | on every change |
| `modules/hardened-bucket/` | shared | — | the bucket hardening both roots need: ACLs off, public access blocked four ways, versioned, SSE-S3, incomplete uploads reaped | called, never applied directly |

`modules/hardened-bucket/` exists so "how we harden an S3 bucket" changes in one place. Only the
retention and tiering rules genuinely differ between the two buckets, and those are module inputs.
The bootstrap module uses it too: its bootstrapping constraint is about *Terraform state*, not
module resolution — a local module directory is just files on disk.

## Two buckets, and why they must stay two

The **event bucket** is the permanent log. The **operational-state bucket** holds delivery-dedupe
markers and (from AWE-157) poller cursors, and expires them.

They are separate buckets rather than separate prefixes for a hard correctness reason.
`apps/desktop-notifier/src/poller.ts` lists the event bucket with `ListObjectsV2` `StartAfter` and
**no prefix filter**, then advances its high-water mark to the highest key it saw. Event keys lead
with a year (`2026-…`); `deliveries/…` and `state/…` start with a letter, which sorts **above** every
digit. One marker object in the event bucket would push a consumer's mark above every event key that
will ever exist, and that consumer would silently never receive another event.

Do not "simplify" this by folding the state bucket into a prefix of the event bucket.

## Naming

Everything follows `{usage}.{env}.{system}.{domain}` from `.agents/guidance/aws.md`:

- system domain — `personal-events.fifthdimensionengineering.com`
- event bucket — `events.production.personal-events.fifthdimensionengineering.com`
- state bucket (Terraform) — `tfstate.production.personal-events.fifthdimensionengineering.com`
- operational-state bucket — `state.production.personal-events.fifthdimensionengineering.com`
- webhook ingest — `hooks.personal-events.fifthdimensionengineering.com`

The ingest hostname omits the `{env}` label that the bucket names carry. This is a single-environment
personal system and the URL is pasted into third-party webhook settings by hand, so the shorter name
wins; set `-var ingest_subdomain=…` if a second environment ever needs `hooks-dev.`.

## Offline checks (no AWS account required)

```bash
pnpm --filter @personal-events/infra lint      # terraform fmt -check -recursive .
pnpm --filter @personal-events/infra validate  # init -backend=false + validate, BOTH roots
```

`validate` runs `terraform init -backend=false -input=false` before `terraform validate` for each
root, because `validate` needs an initialized working directory and `.terraform/` is gitignored —
without the `init` it fails on a clean checkout with *"Module not installed"*. `-backend=false`
skips remote-state initialization, so neither command needs an AWS account or the state bucket.

## First-time bootstrap (creates real AWS resources)

```bash
# 1. Create the remote-state bucket with local state.
terraform -chdir=bootstrap init
terraform -chdir=bootstrap apply

# 2. Adopt the S3 backend for the bootstrap module itself and migrate its state into the bucket.
mv bootstrap/backend.tf.example bootstrap/backend.tf
terraform -chdir=bootstrap init -migrate-state

# 3. Point the main root module at the same bucket.
terraform -chdir=bootstrap output -raw backend_config > personal-events/backend.hcl
terraform -chdir=personal-events init -backend-config=backend.hcl
```

`backend.hcl` is gitignored — it names the state bucket, which is environment-specific.

## Build before you plan

**Two** Lambdas' deployment packages are tsup bundles zipped by `data "archive_file"`, and Terraform
reads those directories at **plan** time — so a plan before they are built fails with *"could not
archive missing directory"* rather than producing empty functions. Build both first:

```bash
pnpm --filter @personal-events/webhook-ingest build   # writes apps/webhook-ingest/dist
pnpm --filter @personal-events/github-poller build     # writes apps/github-poller/dist
terraform -chdir=personal-events plan
```

`pnpm deploy` at the repo root runs the app build first (turbo `dependsOn: ["build"]`), so the
one-liner is safe; the two-step form above is what to run when driving Terraform directly.

## Apply the substrate

```bash
terraform -chdir=personal-events plan     # review
terraform -chdir=personal-events apply
```

### Set the GitHub webhook secret (out of band)

Terraform creates the SSM parameter with a **placeholder** and `ignore_changes = [value]`, so the
real secret never enters state and a later `apply` will not revert it:

```bash
aws ssm put-parameter \
  --name "$(terraform -chdir=personal-events output -raw github_webhook_secret_parameter)" \
  --type SecureString --value "$(openssl rand -hex 32)" --overwrite
```

The same value goes into the GitHub webhook's *Secret* field — see
`apps/webhook-ingest/src/integrations/github/setup.md` for the whole operator runbook.

### Verify the ingest

```bash
INGEST=$(terraform -chdir=personal-events output -raw ingest_url)

curl -sS -o /dev/null -w '%{http_code}\n' -XPOST "$INGEST/github" -d '{}'   # => 401, unsigned
curl -sS -o /dev/null -w '%{http_code}\n' -XPOST "$INGEST/nope"   -d '{}'   # => 404, unroutable

aws logs tail "/aws/lambda/$(terraform -chdir=personal-events output -raw ingest_function_name)" --since 5m
```

A **401** from `/github` is the correct answer to an unsigned request: the route exists, and the
signature check rejected it. A **404** means the GitHub integration failed to register — check the
log for `github integration disabled`. A **403** means the request never reached the function at all
— check the custom domain mapping and the certificate.

### Verify the apply

```bash
BUCKET=$(terraform -chdir=personal-events output -raw event_bucket_name)
aws s3api get-bucket-versioning --bucket "$BUCKET"           # => Status: Enabled
aws s3api get-public-access-block --bucket "$BUCKET"         # => all four flags true
aws s3api get-bucket-encryption --bucket "$BUCKET"           # => AES256

dig +short NS personal-events.fifthdimensionengineering.com  # => the child zone's nameservers
terraform -chdir=personal-events plan                        # => "No changes."
```

NS delegation is not instant — allow the parent zone's TTL (300s by default) plus resolver caching
before `dig` reflects the change.

## Destroy order

**Destroy the parent zone's `NS` record before the child zone**, or the delegation is left dangling
at a zone that no longer exists:

```bash
terraform -chdir=personal-events destroy -target=aws_route53_record.system_delegation
terraform -chdir=personal-events destroy
```

The event bucket and the state bucket both set `force_destroy = false`, so a `destroy` fails while
either holds objects. That is deliberate: the event bucket is the system's permanent history, and
the state bucket is the only recovery path for state. Empty them consciously if you really mean it.

## Failure modes

| Symptom | Cause | Fix |
| :--- | :--- | :--- |
| `NoCredentialProviders` / `ExpiredToken` on plan | no or stale AWS credentials | refresh the profile; `aws sts get-caller-identity` should succeed first |
| `no matching Route 53 Hosted Zone found` | `parent_zone_name` does not exist in this account | check the account, or set `-var parent_zone_name=…` |
| `Backend initialization required` | the state bucket is not reachable, or `backend.hcl` is missing | re-run step 3 above, or use `-backend=false` for offline checks |
| `BucketAlreadyExists` | S3 bucket names are globally unique | override with `-var event_bucket_name=…` |
| `could not archive missing directory` on plan | the Lambda bundle has not been built | `pnpm --filter @personal-events/webhook-ingest build` |
| ACM validation hangs at `PENDING_VALIDATION` | the child zone is not yet delegated, so the validation record is unreachable | confirm `dig +short NS personal-events.…` returns the child zone's nameservers first |
| `certificate not found` when creating the custom domain | the certificate is in a different region from the API | HTTP API custom domains are REGIONAL — the cert must be in `var.region`, **not** pinned to us-east-1 |
| `curl` to the ingest returns 403 with no log line | the request never reached the function | check `aws_apigatewayv2_api_mapping` and that DNS resolves to the API's regional endpoint |
