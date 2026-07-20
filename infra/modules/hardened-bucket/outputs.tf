output "name" {
  description = "Name of the bucket."
  value       = aws_s3_bucket.this.bucket
}

output "arn" {
  description = "ARN of the bucket, for IAM policies."
  value       = aws_s3_bucket.this.arn
}

output "region" {
  description = "Region the bucket lives in."
  value       = aws_s3_bucket.this.region
}
