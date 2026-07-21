variable "region" {
  description = "AWS region for the Terraform remote-state bucket."
  type        = string
  default     = "us-east-1"
}

variable "env" {
  description = "Deployment environment, forming the second label of the {usage}.{env}.{system}.{domain} naming scheme. The project uses development / production per .agents/guidance/aws.md, identical to the TypeScript daemon."
  type        = string
  default     = "production"

  validation {
    condition     = contains(["development", "production"], var.env)
    error_message = "env must be one of development, production."
  }
}

variable "system_domain" {
  description = "The system's domain. The state bucket is named tfstate.{env}.{system_domain}."
  type        = string
  default     = "personal-events.fifthdimensionengineering.com"
}

variable "state_bucket_name" {
  description = "Override for the state bucket name. Leave null to derive it as tfstate.{env}.{system_domain}."
  type        = string
  default     = null
}

variable "tags" {
  description = "Additional tags merged over the defaults."
  type        = map(string)
  default     = {}
}
