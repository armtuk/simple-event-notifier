terraform {
  required_version = ">= 1.11, < 2.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }

    # Zips the webhook-ingest bundle into the Lambda deployment package. Terraform's own provider,
    # so it needs no credentials and runs offline.
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.7"
    }
  }
}
