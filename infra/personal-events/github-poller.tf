# The GitHub poller: an EventBridge-scheduled Lambda, the no-admin ingestion path. Where the webhook
# handler carries real-time load for repos you can configure, this polls the Notifications inbox and
# the Events API on a timer for repos you cannot. It replaced an earlier Railway container -- the
# platform is AWS-only (system.md) -- which is why it is a Lambda with an IAM role rather than a
# long-running service with a long-lived access key.
#
# One invocation is one poll cycle: read state, poll each source, write state. EventBridge is the
# loop; the handler has none.

data "archive_file" "github_poller" {
  type        = "zip"
  source_dir  = var.poller_lambda_dist_path
  output_path = "${path.module}/.terraform-artifacts/github-poller.zip"
}

resource "aws_lambda_function" "github_poller" {
  function_name = local.poller_function_name
  role          = aws_iam_role.github_poller.arn

  runtime = "nodejs24.x"
  handler = "handler.handler"

  filename         = data.archive_file.github_poller.output_path
  source_code_hash = data.archive_file.github_poller.output_base64sha256

  # A poll is a state GET, two conditional GitHub GETs, a handful of PutObjects, a state PUT. 30s is
  # generous headroom well inside the 60s schedule; the handler also aborts a hung GitHub fetch at 20s.
  timeout     = 30
  memory_size = 256

  # THE invariant that makes one combined state object safe: never two invocations at once. With
  # single-read/single-write per invocation (see apps/github-poller/src/poller-state.ts), reserving
  # one concurrent execution rules out the lost update the old concurrent-loop design had.
  reserved_concurrent_executions = 1

  environment {
    variables = {
      EVENT_BUCKET_NAME = module.event_log.name
      # A DIFFERENT bucket from the events, deliberately -- see state-bucket.tf.
      STATE_BUCKET_NAME              = module.operational_state.name
      STATE_KEY                      = var.poller_state_key
      GITHUB_USERNAME                = var.github_username
      GITHUB_NOTIFICATIONS_PAT_PARAM = var.github_notifications_pat_parameter
      GITHUB_EVENTS_PAT_PARAM        = var.github_events_pat_parameter
      ENV                            = var.env
      LOG_LEVEL                      = var.lambda_log_level
      NODE_OPTIONS                   = "--enable-source-maps"
    }
  }

  depends_on = [aws_cloudwatch_log_group.github_poller]
}

resource "aws_cloudwatch_log_group" "github_poller" {
  name              = "/aws/lambda/${local.poller_function_name}"
  retention_in_days = var.lambda_log_retention_days
}

# The schedule. `rate(1 minute)` is EventBridge's floor and is the right cadence, not a compromise:
# GitHub's own `X-Poll-Interval` asks for >= 60s, and the poller is only the fallback for repos where
# a webhook (which carries real-time load) cannot be set. When GitHub asks for longer, the handler
# records a `notBefore` in state and skips intervening ticks.
resource "aws_cloudwatch_event_rule" "github_poller" {
  name                = local.poller_function_name
  description         = "Fires the GitHub poller Lambda once a minute"
  schedule_expression = var.poller_schedule_expression
}

resource "aws_cloudwatch_event_target" "github_poller" {
  rule      = aws_cloudwatch_event_rule.github_poller.name
  target_id = "github-poller-lambda"
  arn       = aws_lambda_function.github_poller.arn
}

resource "aws_lambda_permission" "github_poller_schedule" {
  statement_id  = "AllowExecutionFromEventBridge"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.github_poller.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.github_poller.arn
}

# The two PATs live in SSM SecureStrings, aligned with the webhook secret (github-webhook.tf) so both
# GitHub credentials live in one place. Terraform creates placeholders; the real values are set OUT
# OF BAND and never enter state:
#
#   aws ssm put-parameter --name /personal-events/github/notifications-pat \
#     --type SecureString --value "<classic PAT>" --overwrite
#   aws ssm put-parameter --name /personal-events/github/events-pat \
#     --type SecureString --value "<any PAT>" --overwrite
#
# Set only the ones you have: a missing/placeholder token disables its own source and leaves the
# other running (apps/github-poller/src/composition.ts).
resource "aws_ssm_parameter" "github_notifications_pat" {
  name        = var.github_notifications_pat_parameter
  description = "Classic GitHub PAT for GET /notifications. Set out of band; Terraform only creates the placeholder."
  type        = "SecureString"
  value       = "placeholder-set-me-out-of-band"

  lifecycle {
    ignore_changes = [value]
  }
}

resource "aws_ssm_parameter" "github_events_pat" {
  name        = var.github_events_pat_parameter
  description = "GitHub PAT (any type) for the Events API. Set out of band; Terraform only creates the placeholder."
  type        = "SecureString"
  value       = "placeholder-set-me-out-of-band"

  lifecycle {
    ignore_changes = [value]
  }
}

resource "aws_iam_role" "github_poller" {
  name = local.poller_function_name
  # The same trust policy the webhook function uses -- both are Lambdas.
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
}

data "aws_iam_policy_document" "github_poller" {
  statement {
    sid       = "WriteOwnLogs"
    effect    = "Allow"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.github_poller.arn}:*"]
  }

  # Write-only into the event log. A producer has no reason to read permanent history.
  statement {
    sid       = "AppendEvents"
    effect    = "Allow"
    actions   = ["s3:PutObject"]
    resources = ["${module.event_log.arn}/*"]
  }

  # Exactly one object in the state bucket: its own cursor file. Not the prefix, not the bucket.
  statement {
    sid       = "MaintainPollerState"
    effect    = "Allow"
    actions   = ["s3:GetObject", "s3:PutObject"]
    resources = ["${module.operational_state.arn}/${var.poller_state_key}"]
  }

  # HeadBucket, for the start-up pre-flight `.agents/guidance/aws.md` § S3 requires. No condition:
  # HeadBucket supplies no `s3:prefix` context key, so a `StringLike s3:prefix` condition would void
  # the grant and make every probe fail (the mistake R1-7 caught on the old IAM user).
  statement {
    sid       = "ProbeEventBucket"
    effect    = "Allow"
    actions   = ["s3:ListBucket"]
    resources = [module.event_log.arn]
  }

  # Read the two PATs at invocation time.
  statement {
    sid       = "ReadGithubPats"
    effect    = "Allow"
    actions   = ["ssm:GetParameter"]
    resources = [aws_ssm_parameter.github_notifications_pat.arn, aws_ssm_parameter.github_events_pat.arn]
  }
}

resource "aws_iam_role_policy" "github_poller" {
  name   = "github-poller"
  role   = aws_iam_role.github_poller.id
  policy = data.aws_iam_policy_document.github_poller.json
}
