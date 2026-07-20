variable "region" {
  description = "AWS region for the regional resources (the event bucket and the remote state backend). Route53 itself is global."
  type        = string
  default     = "us-east-1"
}

variable "env" {
  description = "Deployment environment. Forms the second label of the resource naming scheme, {usage}.{env}.{system}.{domain}. Same closed set as the bootstrap root and the TypeScript daemon — see CLAUDE.md."
  type        = string
  default     = "prod"

  validation {
    condition     = contains(["local", "dev", "qa", "staging", "prod"], var.env)
    error_message = "env must be one of local, dev, qa, staging, prod."
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

variable "ingest_subdomain" {
  description = "The host label the webhook ingest is reachable at, beneath the system domain. The full URL goes into third-party webhook configuration, so changing it means editing settings in those systems."
  type        = string
  default     = "hooks"

  validation {
    condition     = can(regex("^[a-z0-9]([a-z0-9-]*[a-z0-9])?$", var.ingest_subdomain))
    error_message = "ingest_subdomain must be a single DNS label: lowercase letters, digits and hyphens, not starting or ending with a hyphen."
  }
}

variable "lambda_dist_path" {
  description = "Directory zipped into the webhook-ingest Lambda deployment package. Must be built (pnpm --filter @personal-events/webhook-ingest build) before plan or apply."
  type        = string
  default     = "../../apps/webhook-ingest/dist"
}

variable "lambda_log_level" {
  description = "LOG_LEVEL for the webhook-ingest function. Same closed set winston understands; anything else silences the function rather than erroring."
  type        = string
  default     = "info"

  validation {
    condition     = contains(["error", "warn", "info", "debug"], var.lambda_log_level)
    error_message = "lambda_log_level must be one of error, warn, info, debug."
  }
}

variable "lambda_log_retention_days" {
  description = "CloudWatch retention for the ingest function and API access logs. Logs are operational telemetry, not the event history — the bucket is the permanent record."
  type        = number
  default     = 30

  validation {
    condition     = contains([1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653], var.lambda_log_retention_days)
    error_message = "lambda_log_retention_days must be one of the retention periods CloudWatch Logs accepts."
  }
}

variable "ingest_throttle_burst" {
  description = "API Gateway stage burst limit. Sized well above any real webhook rate; it exists to cap the cost of an anonymous flood, not to shape traffic."
  type        = number
  default     = 50

  validation {
    condition     = var.ingest_throttle_burst > 0
    error_message = "ingest_throttle_burst must be greater than zero."
  }
}

variable "ingest_throttle_rate" {
  description = "API Gateway stage steady-state request rate limit, in requests per second."
  type        = number
  default     = 20

  validation {
    condition     = var.ingest_throttle_rate > 0
    error_message = "ingest_throttle_rate must be greater than zero."
  }
}
