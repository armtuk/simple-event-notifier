# A stable hostname for the ingest, under the zone this system already owns. The URL goes into a
# third party's webhook configuration, where changing it means an operator editing settings in
# GitHub -- so it must not be the API's generated execute-api hostname, which changes whenever the
# API is recreated.
#
# Everything here lives in the **delegated child zone** (aws_route53_zone.system), never the parent.
# The parent zone holds exactly one record for this system: the NS delegation created in dns.tf.

resource "aws_acm_certificate" "ingest" {
  domain_name       = local.ingest_domain
  validation_method = "DNS"

  # An HTTP API custom domain uses a REGIONAL endpoint, so the certificate must live in the API's
  # own region. This is the difference from CloudFront, which requires us-east-1 -- getting it wrong
  # fails at apply with an unhelpful "certificate not found".
  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "ingest_certificate_validation" {
  for_each = {
    for option in aws_acm_certificate.ingest.domain_validation_options : option.domain_name => {
      name   = option.resource_record_name
      record = option.resource_record_value
      type   = option.resource_record_type
    }
  }

  zone_id         = aws_route53_zone.system.zone_id
  name            = each.value.name
  type            = each.value.type
  records         = [each.value.record]
  ttl             = 60
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "ingest" {
  certificate_arn         = aws_acm_certificate.ingest.arn
  validation_record_fqdns = [for record in aws_route53_record.ingest_certificate_validation : record.fqdn]
}

resource "aws_apigatewayv2_domain_name" "ingest" {
  domain_name = local.ingest_domain

  domain_name_configuration {
    certificate_arn = aws_acm_certificate_validation.ingest.certificate_arn
    endpoint_type   = "REGIONAL"
    security_policy = "TLS_1_2"
  }
}

resource "aws_apigatewayv2_api_mapping" "ingest" {
  api_id      = aws_apigatewayv2_api.ingest.id
  domain_name = aws_apigatewayv2_domain_name.ingest.id
  stage       = aws_apigatewayv2_stage.default.id
}

# An alias record, not a CNAME: aliases resolve without an extra lookup and, unlike a CNAME, are
# legal at a zone apex should this ever move there.
resource "aws_route53_record" "ingest" {
  zone_id = aws_route53_zone.system.zone_id
  name    = local.ingest_domain
  type    = "A"

  alias {
    name                   = aws_apigatewayv2_domain_name.ingest.domain_name_configuration[0].target_domain_name
    zone_id                = aws_apigatewayv2_domain_name.ingest.domain_name_configuration[0].hosted_zone_id
    evaluate_target_health = false
  }
}
