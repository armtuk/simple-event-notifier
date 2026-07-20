# A module boundary is a contract, so every input is validated here rather than at apply time
# against real AWS — a bad value should fail `terraform validate`, not leave a half-created bucket.

variable "bucket_name" {
  description = "Globally unique name for the bucket."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$", var.bucket_name))
    error_message = "bucket_name must be 3-63 characters of lowercase letters, digits, dots or hyphens, starting and ending alphanumeric (S3 bucket naming rules)."
  }

  validation {
    condition     = !can(regex("^([0-9]{1,3}\\.){3}[0-9]{1,3}$", var.bucket_name))
    error_message = "bucket_name must not be formatted as an IP address (S3 forbids it)."
  }
}

variable "transitions" {
  description = "Storage-class transitions applied to current object versions. Empty means current versions are never moved."
  type = list(object({
    days          = number
    storage_class = string
  }))
  default = []

  validation {
    condition     = alltrue([for t in var.transitions : t.days > 0])
    error_message = "every transition's days must be greater than 0."
  }

  validation {
    condition     = alltrue([for t in var.transitions : contains(["STANDARD_IA", "ONEZONE_IA", "INTELLIGENT_TIERING", "GLACIER_IR", "GLACIER", "DEEP_ARCHIVE"], t.storage_class)])
    error_message = "every transition's storage_class must be a valid S3 transition target (STANDARD_IA, ONEZONE_IA, INTELLIGENT_TIERING, GLACIER_IR, GLACIER, DEEP_ARCHIVE)."
  }
}

variable "noncurrent_version_retention_days" {
  description = "How long a superseded object version is kept before expiry."
  type        = number

  validation {
    condition     = var.noncurrent_version_retention_days > 0
    error_message = "noncurrent_version_retention_days must be greater than 0; S3 rejects a zero-day noncurrent expiry."
  }
}

variable "newer_noncurrent_versions_kept" {
  description = "How many superseded versions are always retained regardless of age."
  type        = number

  validation {
    condition     = var.newer_noncurrent_versions_kept >= 0 && floor(var.newer_noncurrent_versions_kept) == var.newer_noncurrent_versions_kept
    error_message = "newer_noncurrent_versions_kept must be a non-negative whole number."
  }
}

variable "abort_incomplete_upload_days" {
  description = "How long an incomplete multipart upload may linger before it is aborted."
  type        = number
  default     = 7

  validation {
    condition     = var.abort_incomplete_upload_days > 0
    error_message = "abort_incomplete_upload_days must be greater than 0."
  }
}
