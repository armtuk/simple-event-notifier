locals {
  system_domain = "${var.subdomain}.${var.parent_zone_name}"

  # {usage}.{env}.{system}.{domain}, per .agents/guidance/aws.md.
  event_bucket_name = coalesce(var.event_bucket_name, "events.${var.env}.${local.system_domain}")

  tags = merge({
    System      = var.subdomain
    Environment = var.env
    ManagedBy   = "terraform"
    Repository  = "aws-work-eventer"
  }, var.tags)
}
