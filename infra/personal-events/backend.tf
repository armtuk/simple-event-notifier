# Remote state lives in the bucket created by ../bootstrap. Locking uses S3 conditional writes
# (`use_lockfile`, GA in Terraform 1.11) — there is deliberately no DynamoDB lock table.
#
# The bucket name is not interpolable here (backend blocks take no variables), so it is passed at
# init time from ./backend.hcl:
#
#   terraform init -backend-config=backend.hcl
#
# To work offline without touching the remote state at all:
#
#   terraform init -backend=false && terraform validate
terraform {
  backend "s3" {
    key          = "personal-events/terraform.tfstate"
    encrypt      = true
    use_lockfile = true
  }
}
