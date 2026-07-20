# The GitHub-specific half of the webhook ingest: the shared HMAC secret, and the extra permissions
# the function needs to read it and to keep delivery-dedupe markers.
#
# Kept in its own file, and attached as a **second** role policy rather than merged into
# `lambda.tf`'s, so the generic ingest's permissions and one integration's permissions have separate
# reasons to change. Adding Claude Code later adds a third file, not an edit to these.

# Created with a placeholder so the parameter exists and the IAM policy can name it. The real secret
# is set OUT OF BAND and never enters Terraform state:
#
#   aws ssm put-parameter --name /personal-events/github/webhook-secret \
#     --type SecureString --value "$(openssl rand -hex 32)" --overwrite
#
# `ignore_changes = [value]` is what keeps a later `terraform apply` from reverting it.
resource "aws_ssm_parameter" "github_webhook_secret" {
  name        = var.github_webhook_secret_parameter
  description = "Shared HMAC secret for GitHub webhook deliveries. Set out of band; Terraform only creates the placeholder."
  type        = "SecureString"
  value       = "placeholder-set-me-out-of-band"

  lifecycle {
    ignore_changes = [value]
  }
}

data "aws_iam_policy_document" "webhook_ingest_github" {
  statement {
    sid       = "ReadGithubWebhookSecret"
    effect    = "Allow"
    actions   = ["ssm:GetParameter"]
    resources = [aws_ssm_parameter.github_webhook_secret.arn]
  }

  # Scoped to the delivery-marker prefix, not the whole state bucket: the ingest function has no
  # business reading or writing a poller cursor, and this is the boundary that says so.
  statement {
    sid       = "MaintainDeliveryMarkers"
    effect    = "Allow"
    actions   = ["s3:GetObject", "s3:PutObject"]
    resources = ["${module.operational_state.arn}/${var.github_delivery_prefix}/*"]
  }
}

resource "aws_iam_role_policy" "webhook_ingest_github" {
  name   = "webhook-ingest-github"
  role   = aws_iam_role.webhook_ingest.id
  policy = data.aws_iam_policy_document.webhook_ingest_github.json
}
