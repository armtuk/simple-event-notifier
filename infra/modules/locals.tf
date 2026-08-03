locals {
  name          = "${var.env}-${var.project_name}"
  author        = "Alex Turner"
  email         = "alex@fifthdimensionengineering.com"
  lambda_memory = 128

  tags = {
    Name      = "${var.env} ${var.project_name}"
    ManagedBy = "Terraform"
    Owner     = local.email
    Environment = var.env
  }
}
