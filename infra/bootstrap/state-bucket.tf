# Resolves the chicken-and-egg of remote state: this module runs with LOCAL state, creates the
# bucket that every other root module's state lives in, then migrates its own state into that
# bucket (see ../README.md). It is applied once and thereafter almost never touched.
#
# It shares the hardened-bucket module with the main root rather than restating the six resources.
# The bootstrapping constraint is about *Terraform state*, not module resolution — a local module
# directory is just files on disk and needs nothing to exist before it can be used.
#
# Versioning (which the shared module always enables) is not optional here: it is the only recovery
# path from a corrupted or truncated state write. State objects are small and rewritten constantly,
# so nothing is tiered to colder storage; only superseded versions are trimmed.

module "state" {
  source = "../modules/hardened-bucket"

  bucket_name = local.state_bucket_name

  noncurrent_version_retention_days = 90
  newer_noncurrent_versions_kept    = 20
}
