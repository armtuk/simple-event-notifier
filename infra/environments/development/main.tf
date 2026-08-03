module "fifthd-work-eventer" {
  source = "../../module"

  aws_region = var.aws_region
  aws_profile = var.aws_profile
  env = var.env
  parent_domain = var.parent_domain
}
