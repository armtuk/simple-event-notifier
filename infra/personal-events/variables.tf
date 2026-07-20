variable "region" {
  description = "AWS region for the regional resources (the event bucket and the remote state backend). Route53 itself is global."
  type        = string
  default     = "us-east-1"
}

variable "env" {
  description = "Deployment environment. Forms the second label of the resource naming scheme, {usage}.{env}.{system}.{domain}."
  type        = string
  default     = "prod"

  validation {
    condition     = contains(["prod", "dev", "staging", "qa", "local"], var.env)
    error_message = "env must be one of prod, dev, staging, qa, local."
  }
}

variable "parent_zone_name" {
  description = "The existing public hosted zone this system's subdomain is delegated from. Must already exist and be writable by the credentials in use."
  type        = string
  default     = "fifthdimensionengineering.com"
}

variable "subdomain" {
  description = "The system label delegated beneath the parent zone. The system domain is {subdomain}.{parent_zone_name}."
  type        = string
  default     = "personal-events"
}

variable "event_bucket_name" {
  description = "Override for the event bucket name. Leave null to derive it as events.{env}.{subdomain}.{parent_zone_name}."
  type        = string
  default     = null
}

variable "ns_record_ttl" {
  description = "TTL in seconds for the NS delegation record in the parent zone. Kept low initially so a re-delegation propagates quickly."
  type        = number
  default     = 300
}

variable "noncurrent_version_retention_days" {
  description = "How long a superseded object version is kept before expiry. Current versions are never expired — the bucket is the permanent event history."
  type        = number
  default     = 180
}

variable "tags" {
  description = "Additional tags merged over the defaults and applied to every taggable resource."
  type        = map(string)
  default     = {}
}
