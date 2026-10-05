# Delegated subdomain: this system owns its own hosted zone, and the parent zone merely points at
# it. That keeps the system's records independently manageable (and independently delegatable to a
# different account later) without granting write access to the parent zone's other records.

data "aws_route53_zone" "parent" {
  name         = "${var.parent_zone_name}."
  private_zone = false
}

resource "aws_route53_zone" "system" {
  name    = local.system_domain
  comment = "Delegated zone for the personal-events system"
}

# The child zone's own apex NS and SOA records are created by Route53 and are deliberately not
# managed here — adopting them causes perpetual drift.
resource "aws_route53_record" "system_delegation" {
  zone_id = data.aws_route53_zone.parent.zone_id
  name    = local.system_domain
  type    = "NS"
  ttl     = var.ns_record_ttl
  records = aws_route53_zone.system.name_servers
}
