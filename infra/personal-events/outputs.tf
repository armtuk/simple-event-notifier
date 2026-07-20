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
