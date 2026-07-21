# The webhook ingest function. One of two Lambdas in this root module (the other is the github
# poller, github-poller.tf); the only other producer, the desktop notifier, runs on a laptop. The
# bucket is the system and the rest is producers and consumers of it.
#
# The deployment package is the tsup bundle from apps/webhook-ingest, zipped verbatim. `terraform
# plan` therefore requires that the bundle already exist — see infra/README.md for the
# build-before-apply order. The bundle includes the AWS SDK deliberately (see the app's
# tsup.config.ts), so the function's behaviour does not shift when AWS rolls the managed runtime.

data "archive_file" "webhook_ingest" {
  type        = "zip"
  source_dir  = var.lambda_dist_path
  output_path = "${path.module}/.terraform-artifacts/webhook-ingest.zip"
}

resource "aws_lambda_function" "webhook_ingest" {
  function_name = local.ingest_function_name
  role          = aws_iam_role.webhook_ingest.arn

  runtime = "nodejs24.x"
  handler = "handler.handler"

  filename         = data.archive_file.webhook_ingest.output_path
  source_code_hash = data.archive_file.webhook_ingest.output_base64sha256

  # A webhook delivery is one HMAC verification, one dedupe HEAD, and one PutObject. GitHub gives
  # roughly ten seconds before it records the delivery as failed and -- crucially -- does not retry,
  # so the timeout is set well inside that budget: failing fast and visibly beats a delivery that
  # times out on GitHub's side while the write is still in flight.
  timeout     = 10
  memory_size = 512

  environment {
    variables = {
      EVENT_BUCKET_NAME = module.event_log.name
      # A different bucket from the events, deliberately — see state-bucket.tf.
      STATE_BUCKET_NAME           = module.operational_state.name
      GITHUB_WEBHOOK_SECRET_PARAM = aws_ssm_parameter.github_webhook_secret.name
      GITHUB_DELIVERY_PREFIX      = var.github_delivery_prefix
      ENV                         = var.env
      LOG_LEVEL                   = var.lambda_log_level
      # The bundle ships sourcemaps; without this they are inert and every stack trace points at a
      # single-line bundle.
      NODE_OPTIONS = "--enable-source-maps"
    }
  }

  depends_on = [aws_cloudwatch_log_group.webhook_ingest]
}

# Created explicitly rather than left to Lambda's implicit creation, so retention is actually set --
# an implicitly created group keeps logs forever and is invisible in the plan.
resource "aws_cloudwatch_log_group" "webhook_ingest" {
  name              = "/aws/lambda/${local.ingest_function_name}"
  retention_in_days = var.lambda_log_retention_days
}

resource "aws_iam_role" "webhook_ingest" {
  name               = local.ingest_function_name
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
}

data "aws_iam_policy_document" "lambda_assume_role" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

# Least privilege, and specifically NOT AWSLambdaBasicExecutionRole: that managed policy grants
# logging on every log group in the account. This grants it on this function's group only.
data "aws_iam_policy_document" "webhook_ingest" {
  statement {
    sid       = "WriteOwnLogs"
    effect    = "Allow"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.webhook_ingest.arn}:*"]
  }

  # PutObject only. The function is a producer: it has no reason to read, list, or delete the
  # permanent event history, and an internet-facing function that could would be a much worse
  # thing to have a signature-verification bug in.
  statement {
    sid       = "WriteEvents"
    effect    = "Allow"
    actions   = ["s3:PutObject"]
    resources = ["${module.event_log.arn}/*"]
  }
}

resource "aws_iam_role_policy" "webhook_ingest" {
  name   = "webhook-ingest"
  role   = aws_iam_role.webhook_ingest.id
  policy = data.aws_iam_policy_document.webhook_ingest.json
}
