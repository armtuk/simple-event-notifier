# The event log. S3 is the source of record, not a cache: current object versions are never
# expired, only tiered to colder storage. Versioning exists to make the triage flags
# (acknowledged / handled) recoverable after a client rewrites an object, not for retention.

resource "aws_s3_bucket" "event_log" {
  bucket        = local.event_bucket_name
  force_destroy = false
}

resource "aws_s3_bucket_public_access_block" "event_log" {
  bucket = aws_s3_bucket.event_log.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "event_log" {
  bucket = aws_s3_bucket.event_log.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_versioning" "event_log" {
  bucket = aws_s3_bucket.event_log.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "event_log" {
  bucket = aws_s3_bucket.event_log.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "event_log" {
  bucket = aws_s3_bucket.event_log.id

  # Lifecycle rules operate on versions, so versioning must settle first or the plan flaps.
  depends_on = [aws_s3_bucket_versioning.event_log]

  rule {
    id     = "tier-current-versions"
    status = "Enabled"

    filter {}

    transition {
      days          = 90
      storage_class = "STANDARD_IA"
    }

    transition {
      days          = 365
      storage_class = "GLACIER_IR"
    }
  }

  rule {
    id     = "trim-superseded-versions"
    status = "Enabled"

    filter {}

    noncurrent_version_expiration {
      newer_noncurrent_versions = 5
      noncurrent_days           = var.noncurrent_version_retention_days
    }
  }

  rule {
    id     = "abort-incomplete-uploads"
    status = "Enabled"

    filter {}

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}
