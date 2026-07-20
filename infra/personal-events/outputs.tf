output "event_bucket_name" {
  description = "Name of the S3 event bucket. Consumers (e.g. the desktop notifier) read this into EVENT_BUCKET."
  value       = module.event_log.name
}

output "event_bucket_arn" {
  description = "ARN of the S3 event bucket, for IAM policies granting producers and consumers access."
  value       = module.event_log.arn
}

output "event_bucket_region" {
  description = "Region the event bucket lives in."
  value       = module.event_log.region
}

output "system_domain" {
  description = "The delegated domain this system owns."
  value       = local.system_domain
}

output "system_zone_id" {
  description = "Hosted zone id of the delegated system zone, for later features adding records beneath it."
  value       = aws_route53_zone.system.zone_id
}

output "system_zone_name_servers" {
  description = "Nameservers of the delegated system zone. These are what the parent zone's NS record delegates to."
  value       = aws_route53_zone.system.name_servers
}

output "ingest_url" {
  description = "The webhook ingest base URL. A third-party webhook is configured to POST to {ingest_url}/{integration}, e.g. .../github."
  value       = "https://${local.ingest_domain}"
}

output "ingest_function_name" {
  description = "Name of the webhook-ingest Lambda function, for log tailing and manual invocation."
  value       = aws_lambda_function.webhook_ingest.function_name
}

output "ingest_function_role_arn" {
  description = "ARN of the ingest function's execution role. Later stories extend its policy rather than replacing it."
  value       = aws_iam_role.webhook_ingest.arn
}

output "ingest_api_endpoint" {
  description = "The API's generated execute-api endpoint. Useful for diagnosing a DNS or certificate problem by bypassing the custom domain; not a stable URL."
  value       = aws_apigatewayv2_api.ingest.api_endpoint
}

output "state_bucket_name" {
  description = "Operational-state bucket: delivery-dedupe markers and (from AWE-157) poller cursors. Deliberately NOT the event bucket."
  value       = module.operational_state.name
}

output "state_bucket_arn" {
  description = "ARN of the operational-state bucket, for IAM policies granting producers access to their own prefixes."
  value       = module.operational_state.arn
}

output "github_webhook_secret_parameter" {
  description = "SSM parameter the ingest reads the GitHub HMAC secret from. Set its value out of band; Terraform only creates the placeholder."
  value       = aws_ssm_parameter.github_webhook_secret.name
}

output "github_webhook_url" {
  description = "The exact Payload URL to paste into a GitHub webhook's settings."
  value       = "https://${local.ingest_domain}/github"
}
