terraform {
  required_providers {
    aws = {
      source = "hashicorp/aws"
      version = "6.57.1"
    }
  }

  backend "s3" {
    bucket         = "terraform.tfstate.us-west-2.fifthdimensionengineering.com"
    key            = "fifthd-simple-eventer/dev/terraform.tfstate"
    region         = "us-west-2"
    profile = "default"
  }
}

provider "aws" {
  profile     = var.aws_profile
  region      = var.aws_region
  max_retries = 1
}


