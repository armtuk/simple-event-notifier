
provider "aws" {
  alias = "us_east_1"
  profile     = var.aws_profile
  region      = "us-east-1"
  max_retries = 1
}
