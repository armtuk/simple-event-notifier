data "aws_iam_policy_document" "s3_logging_bucket_policy" {
  statement {
    actions = [
      "s3:PutObject"
    ]
    effect = "Allow"
    principals {
      type        = "AWS"
      identifiers = [data.aws_elb_service_account.main.arn]
    }

    resources = [
      aws_s3_bucket.logging_bucket.arn,
      "${aws_s3_bucket.logging_bucket.arn}/*",
      "${aws_s3_bucket.logging_bucket.arn}/*",
      "${aws_s3_bucket.logging_bucket.arn}/alb-logs/*",
      "${aws_s3_bucket.logging_bucket.arn}/cdn-logs/*"
    ]

    principals {
      identifiers = [
        "elasticloadbalancing.amazonaws.com",
        "logdelivery.elasticloadbalancing.amazonaws.com",
        "delivery.logs.amazonaws.com"
      ]
      type = "Service"
    }
  }
}

resource "aws_s3_bucket" "logging_bucket" {
  bucket = "logs.${var.env}.${var.project_name}.${var.parent_domain}"
  force_destroy = true

  tags = {
    Environment = var.env
    Name        = "${var.env}-web-logs-s3-bucket"
  }
}

resource "aws_s3_bucket" "data_bucket" {
  bucket = "data.${var.env}.${var.project_name}.${var.parent_domain}"
  force_destroy = true

  tags = {
    Environment = var.env
    Name        = "${var.env}-data-s3-bucket"
  }
}

resource "aws_s3_bucket_ownership_controls" "logging_bucket_ownership_controls" {
  bucket = aws_s3_bucket.logging_bucket.id
  rule {
    object_ownership = "BucketOwnerPreferred"
  }
}

resource "aws_s3_bucket_public_access_block" "log_bucket_acl_access" {
  bucket = aws_s3_bucket.logging_bucket.id

  block_public_acls       = false
  block_public_policy     = false
  ignore_public_acls      = false
  restrict_public_buckets = false
}

resource "aws_s3_bucket_acl" "logging_bucket_acl" {
  bucket = aws_s3_bucket.logging_bucket.id
  acl = "log-delivery-write"
  depends_on = [
    aws_s3_bucket_ownership_controls.logging_bucket_ownership_controls,
    aws_s3_bucket_public_access_block.log_bucket_acl_access
  ]
}

resource "aws_s3_bucket_policy" "allow_logging_from_alb_to_s3" {
  bucket = aws_s3_bucket.logging_bucket.id
  policy = data.aws_iam_policy_document.s3_logging_bucket_policy.json
}

resource "aws_security_group" "lambda_sg" {
  name        = "lambda-vpc-security-group"
  description = "Security group for Lambda function inside VPC"
  vpc_id      = aws_vpc.main.id

  # Egress rule allowing all outbound traffic (needed to call external APIs/services)
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "${var.env}-${var.project_name}-lambda-sg"
  }
}

data "aws_availability_zones" "available" {
  state = "available"
}
