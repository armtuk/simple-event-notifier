# Credentials for the GitHub poller, which runs on Railway rather than in AWS. It is the one
# component that cannot use an IAM role: there is no AWS compute to attach one to, so it needs a
# long-lived access key held as a Railway secret.
#
# That makes least privilege matter more here than anywhere else in this project. The key is scoped
# to exactly two things: append events, and read/write its own state object. It cannot read the event
# history it writes to, cannot delete anything, and cannot touch another producer's state.

resource "aws_iam_user" "github_poller" {
  name = "${var.subdomain}-github-poller-${var.env}"
  path = "/service/"
}

data "aws_iam_policy_document" "github_poller" {
  # Write-only into the event log. A producer has no reason to read permanent history, and a
  # compromised Railway environment should not be able to exfiltrate it.
  statement {
    sid       = "AppendEvents"
    effect    = "Allow"
    actions   = ["s3:PutObject"]
    resources = ["${module.event_log.arn}/*"]
  }

  # Exactly one object: its own cursor file. Not the prefix, not the bucket -- the single key.
  statement {
    sid       = "MaintainPollerState"
    effect    = "Allow"
    actions   = ["s3:GetObject", "s3:PutObject"]
    resources = ["${module.operational_state.arn}/${var.poller_state_key}"]
  }

  # HeadBucket, for the start-up pre-flight `.agents/guidance/aws.md` § S3 requires.
  statement {
    sid       = "ProbeEventBucket"
    effect    = "Allow"
    actions   = ["s3:ListBucket"]
    resources = [module.event_log.arn]

    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = [""]
    }
  }
}

resource "aws_iam_user_policy" "github_poller" {
  name   = "github-poller"
  user   = aws_iam_user.github_poller.name
  policy = data.aws_iam_policy_document.github_poller.json
}

# Access keys are deliberately NOT created here. `aws_iam_access_key` writes the secret into
# Terraform state, and this state lives in an S3 bucket that more things can read than should ever
# see a credential. Create the key out of band and paste it into Railway:
#
#   aws iam create-access-key --user-name "$(terraform output -raw github_poller_user_name)"
#
# Rotation is the same command plus `aws iam delete-access-key` for the old one; nothing in Terraform
# needs to change.
