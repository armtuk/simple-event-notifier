variable "bucket_name" {
  description = "Globally unique name for the bucket."
  type        = string
}

variable "transitions" {
  description = "Storage-class transitions applied to current object versions. Empty means current versions are never moved."
  type = list(object({
    days          = number
    storage_class = string
  }))
  default = []
}

variable "noncurrent_version_retention_days" {
  description = "How long a superseded object version is kept before expiry."
  type        = number
}

variable "newer_noncurrent_versions_kept" {
  description = "How many superseded versions are always retained regardless of age."
  type        = number
}

variable "abort_incomplete_upload_days" {
  description = "How long an incomplete multipart upload may linger before it is aborted."
  type        = number
  default     = 7
}
