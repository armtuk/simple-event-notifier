output "state_bucket_name" {
  description = "Name of the Terraform remote-state bucket. Feed this to every root module's -backend-config."
  value       = aws_s3_bucket.state.bucket
}

output "state_bucket_region" {
  description = "Region of the remote-state bucket."
  value       = aws_s3_bucket.state.region
}

output "backend_config" {
  description = "Ready-to-paste contents of a root module's backend.hcl."
  value       = "bucket = \"${aws_s3_bucket.state.bucket}\"\nregion = \"${aws_s3_bucket.state.region}\"\n"
}
