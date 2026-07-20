# The event log. S3 is the source of record, not a cache: current object versions are never
# expired, only tiered to colder storage. Versioning exists to make the triage flags
# (acknowledged / handled) recoverable after a client rewrites an object, not for retention.

module "event_log" {
  source = "../modules/hardened-bucket"

  bucket_name = local.event_bucket_name

  transitions = [
    { days = 90, storage_class = "STANDARD_IA" },
    { days = 365, storage_class = "GLACIER_IR" }
  ]

  noncurrent_version_retention_days = var.noncurrent_version_retention_days
  newer_noncurrent_versions_kept    = 5
}
