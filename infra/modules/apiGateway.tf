resource "aws_api_gateway_rest_api" "api_gateway_rest_api" {
  name        = "${var.env}-${var.project_name}_api"
  description = "${var.env} Api ${var.project_name}"
}

resource "aws_api_gateway_resource" "api_gateway" {
  rest_api_id = aws_api_gateway_rest_api.api_gateway_rest_api.id
  parent_id   = aws_api_gateway_rest_api.api_gateway_rest_api.root_resource_id
  path_part   = "{proxy+}"
}

resource "aws_api_gateway_method" "api_gateway_method" {
  rest_api_id   = aws_api_gateway_rest_api.api_gateway_rest_api.id
  resource_id   = aws_api_gateway_resource.api_gateway.id
  http_method   = "ANY"
  authorization = "NONE"
}

resource "aws_api_gateway_stage" "api_gateway_stage" {
  rest_api_id = aws_api_gateway_rest_api.api_gateway_rest_api.id
  stage_name  = "${var.env}-auto"
  deployment_id = aws_api_gateway_deployment.api_gateway_deployment.id
}

resource "aws_api_gateway_integration" "api_gateway_integration" {
  rest_api_id = aws_api_gateway_rest_api.api_gateway_rest_api.id
  resource_id = aws_api_gateway_method.api_gateway_method.resource_id
  http_method = aws_api_gateway_method.api_gateway_method.http_method

  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = aws_lambda_function.lambda.invoke_arn
}

resource "aws_api_gateway_method" "api_gateway_root_method" {
  rest_api_id   = aws_api_gateway_rest_api.api_gateway_rest_api.id
  resource_id   = aws_api_gateway_rest_api.api_gateway_rest_api.root_resource_id
  http_method   = "ANY"
  authorization = "NONE"
}

resource "aws_api_gateway_integration" "api_gateway_root_integration" {
  rest_api_id = aws_api_gateway_rest_api.api_gateway_rest_api.id
  resource_id = aws_api_gateway_method.api_gateway_root_method.resource_id
  http_method = aws_api_gateway_method.api_gateway_root_method.http_method

  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = aws_lambda_function.lambda.invoke_arn
}

resource "aws_api_gateway_deployment" "api_gateway_deployment" {
  depends_on = [
    aws_api_gateway_integration.api_gateway_integration,
    aws_api_gateway_integration.api_gateway_root_integration,
  ]

  rest_api_id = aws_api_gateway_rest_api.api_gateway_rest_api.id
}


data "aws_route53_zone" "project-zone" {
  name = var.parent_domain
  private_zone = false
}

resource "aws_route53_record" "api_gateway_dns_record" {
  zone_id = data.aws_route53_zone.project-zone.zone_id
  name    = "${var.project_name}.${var.env}"
  type    = "CNAME"
  ttl     = "300"
  records = ["${aws_api_gateway_rest_api.api_gateway_rest_api.id}.execute-api.${var.aws_region}.amazonaws.com"]

  allow_overwrite = true
}

resource "aws_api_gateway_domain_name" "custom_domain" {
  domain_name              = "${var.project_name}.${var.env}.${var.parent_domain}"
  certificate_arn          = aws_acm_certificate.cert-global.arn
  security_policy          = "TLS_1_2"
}

resource "aws_api_gateway_base_path_mapping" "base_path_mapping" {
  api_id   = aws_api_gateway_rest_api.api_gateway_rest_api.id
  stage_name    = aws_api_gateway_stage.api_gateway_stage.stage_name
  domain_name   = aws_api_gateway_domain_name.custom_domain.domain_name
}
