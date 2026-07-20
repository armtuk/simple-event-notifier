# Operational state, in its own bucket — deliberately NOT a prefix inside the event bucket.
#
# This is a correctness requirement, not tidiness. `apps/desktop-notifier/src/poller.ts` lists the
# event bucket with `ListObjectsV2` `StartAfter` and **no prefix filter**, then advances its
# high-water mark to the highest key it saw. Event keys lead with a year — "2026-…" — while
# "deliveries/…" and "state/…" both start with a letter, which sorts **above** every digit. A single
# marker object in the event bucket would therefore push a consumer's mark above every event key
# that will ever exist, and that consumer would silently never receive another event.
#
# AWE-156's stories originally placed delivery markers under a `deliveries/` prefix in the event
# bucket, and AWE-157's placed poller state under `state/`. Both are hosted here instead.
#
# Unlike the event bucket, this data IS transient and expires: markers only need to outlive GitHub's
# three-day manual-redelivery window, and a poller cursor is rewritten every cycle.

module "operational_state" {
  source = "../modules/hardened-bucket"

  bucket_name = local.state_bucket_name

  # No tiering. Objects here are small, short-lived, and read on a hot path; moving them to colder
  # storage would add retrieval latency to every dedupe check for no meaningful saving.
  transitions = []

  prefix_expirations = [
    {
      id     = "expire-github-delivery-markers"
      prefix = "${var.github_delivery_prefix}/"
      days   = var.delivery_marker_retention_days
    }
  ]

  # Versioning is on (the module hardens every bucket the same way), so a rewritten poller cursor
  # leaves superseded versions behind. Trim them aggressively: the current version is the only one
  # anything reads, and the history of a cursor is of no interest.
  noncurrent_version_retention_days = 7
  newer_noncurrent_versions_kept    = 3
}
