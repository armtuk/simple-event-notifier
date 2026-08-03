
resource "aws_acm_certificate_validation" "acm_certificate_validation" {
  certificate_arn         = aws_acm_certificate.cert-regional.arn
  validation_record_fqdns = [for record in aws_route53_record.validation_route53_record : record.fqdn]
}

resource "aws_acm_certificate" "cert-regional" {
  domain_name               = "www.${var.project_name}.${var.env}.${var.parent_domain}"
  validation_method         = "DNS"
  subject_alternative_names = [
    "${var.project_name}.${var.env}.${var.parent_domain}",
    "api.${var.project_name}.${var.env}.${var.parent_domain}",
    "admin.${var.project_name}.${var.env}.${var.parent_domain}",
    "search.${var.project_name}.${var.env}.${var.parent_domain}",
    "js.${var.project_name}.${var.env}.${var.parent_domain}",
    "static.${var.project_name}.${var.env}.${var.parent_domain}"
  ]
}

resource "aws_acm_certificate" "cert-global" {
  provider                  = aws.us_east_1
  domain_name               = "www.${var.project_name}.${var.env}.${var.parent_domain}"
  validation_method         = "DNS"
  subject_alternative_names = [
    "${var.project_name}.${var.env}.${var.parent_domain}",
    "api.${var.project_name}.${var.env}.${var.parent_domain}",
    "admin.${var.project_name}.${var.env}.${var.parent_domain}",
    "search.${var.project_name}.${var.env}.${var.parent_domain}",
    "js.${var.project_name}.${var.env}.${var.parent_domain}",
    "static.${var.project_name}.${var.env}.${var.parent_domain}"
  ]
}

resource "aws_route53_record" "validation_route53_record" {
  for_each = {
    for dvo in aws_acm_certificate.cert-regional.domain_validation_options : dvo.domain_name => {
      name   = dvo.resource_record_name
      type   = dvo.resource_record_type
      record = dvo.resource_record_value
    }
  }

  name    = each.value.name
  type    = each.value.type
  zone_id = data.aws_route53_zone.project-zone.zone_id
  records = [each.value.record]
  ttl     = 60
}
