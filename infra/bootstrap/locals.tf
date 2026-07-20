locals {
  state_bucket_name = coalesce(var.state_bucket_name, "tfstate.${var.env}.${var.system_domain}")

  tags = merge({
    System      = "personal-events"
    Environment = var.env
    ManagedBy   = "terraform"
    Repository  = "aws-work-eventer"
    Purpose     = "terraform-remote-state"
  }, var.tags)
}
