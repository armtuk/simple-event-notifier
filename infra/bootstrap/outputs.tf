output "state_bucket_name" {
  description = "Name of the Terraform remote-state bucket. Feed this to every root module's -backend-config."
  value       = module.state.name
}

output "state_bucket_region" {
  description = "Region of the remote-state bucket."
  value       = module.state.region
}

output "backend_config" {
  description = "Ready-to-paste contents of a root module's backend.hcl."
  value       = "bucket = \"${module.state.name}\"\nregion = \"${module.state.region}\"\n"
}
