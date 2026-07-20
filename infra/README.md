# `infra/` — the personal-events AWS substrate

Terraform for the S3 event bucket and the delegated Route53 zone. See ADR
[`2026-07-19-1900-iac-foundation`](../docs/decisions/2026-07-19-1900-iac-foundation/adr-body.md)
for why it is shaped this way.

| Root module | State | Creates | Applied |
| :--- | :--- | :--- | :--- |
| `bootstrap/` | local, then migrated into the bucket it creates | the Terraform remote-state bucket | once, by hand |
| `personal-events/` | remote (S3 + `use_lockfile`) | the S3 event bucket, the delegated hosted zone, and the `NS` delegation in the parent zone | on every change |

## Naming

Everything follows `{usage}.{env}.{system}.{domain}` from `.agents/guidance/aws.md`:

- system domain — `personal-events.fifthdimensionengineering.com`
- event bucket — `events.prod.personal-events.fifthdimensionengineering.com`
- state bucket — `tfstate.prod.personal-events.fifthdimensionengineering.com`

## Offline checks (no AWS account required)

```bash
terraform -chdir=personal-events init -backend=false
terraform -chdir=personal-events validate
terraform fmt -check -recursive .
```

`-backend=false` skips remote-state initialization, so these work on a clean checkout. This is also
what `pnpm --filter @personal-events/infra lint` and `… validate` run.

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

## Apply the substrate

```bash
terraform -chdir=personal-events plan     # review
terraform -chdir=personal-events apply
```

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
