locals {
  system_domain = "${var.subdomain}.${var.parent_zone_name}"

  # {usage}.{env}.{system}.{domain}, per .agents/guidance/aws.md.
  event_bucket_name = coalesce(var.event_bucket_name, "events.${var.env}.${local.system_domain}")

  # Operational state (dedupe markers, poller cursors) is a SEPARATE bucket from the event log —
  # see state-bucket.tf. The naming follows the same {usage}.{env}.{system}.{domain} scheme.
  state_bucket_name = coalesce(var.state_bucket_name, "state.${var.env}.${local.system_domain}")

  ingest_domain        = "${var.ingest_subdomain}.${local.system_domain}"
  ingest_function_name = "${var.subdomain}-webhook-ingest-${var.env}"
  poller_function_name = "${var.subdomain}-github-poller-${var.env}"

  tags = merge({
    System      = var.subdomain
    Environment = var.env
    ManagedBy   = "terraform"
    Repository  = "aws-work-eventer"
  }, var.tags)
}
