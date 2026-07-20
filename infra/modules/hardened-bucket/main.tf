# One place that answers "how do we harden an S3 bucket in this project": ACLs off, public access
# blocked four ways, versioned, encrypted at rest, and incomplete uploads reaped. Both root modules
# call this; only the retention/tiering rules genuinely differ between them, and those are inputs.

resource "aws_s3_bucket" "this" {
  bucket        = var.bucket_name
  force_destroy = false
}

resource "aws_s3_bucket_public_access_block" "this" {
  bucket = aws_s3_bucket.this.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "this" {
  bucket = aws_s3_bucket.this.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_versioning" "this" {
  bucket = aws_s3_bucket.this.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "this" {
  bucket = aws_s3_bucket.this.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "this" {
  bucket = aws_s3_bucket.this.id

  # Lifecycle rules operate on versions, so versioning must settle first or the plan flaps.
  depends_on = [aws_s3_bucket_versioning.this]

  # Current versions are only ever moved to colder storage, never expired — a caller that wants
  # expiry must say so explicitly by adding a rule of its own.
  dynamic "rule" {
    for_each = length(var.transitions) > 0 ? [1] : []

    content {
      id     = "tier-current-versions"
      status = "Enabled"

      filter {}

      dynamic "transition" {
        for_each = var.transitions

        content {
          days          = transition.value.days
          storage_class = transition.value.storage_class
        }
      }
    }
  }

  rule {
    id     = "trim-superseded-versions"
    status = "Enabled"

    filter {}

    noncurrent_version_expiration {
      newer_noncurrent_versions = var.newer_noncurrent_versions_kept
      noncurrent_days           = var.noncurrent_version_retention_days
    }
  }

  rule {
    id     = "abort-incomplete-uploads"
    status = "Enabled"

    filter {}

    abort_incomplete_multipart_upload {
      days_after_initiation = var.abort_incomplete_upload_days
    }
  }
}
