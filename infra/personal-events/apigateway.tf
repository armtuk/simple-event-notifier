# The public ingest endpoint: an API Gateway **HTTP API**, not a REST API. HTTP APIs are roughly a
# third of the cost, have a simpler resource model, and support everything a webhook receiver needs.
# The REST API's extra surface (request validators, usage plans, WAF association) buys nothing here:
# the real gate is the per-integration HMAC signature check inside the function.

resource "aws_apigatewayv2_api" "ingest" {
  name          = local.ingest_function_name
  description   = "Generic third-party webhook ingest for the personal-events system"
  protocol_type = "HTTP"
}

resource "aws_apigatewayv2_integration" "ingest" {
  api_id                 = aws_apigatewayv2_api.ingest.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.webhook_ingest.invoke_arn
  payload_format_version = "2.0"
  timeout_milliseconds   = 10000
}

# One wildcard route for every integration, present and future. Adding GitHub (AWE-156) or Claude
# Code later is a registry entry in the function, not an infrastructure change -- which is the whole
# reason this ingest is generic rather than GitHub-shaped.
resource "aws_apigatewayv2_route" "ingest" {
  api_id    = aws_apigatewayv2_api.ingest.id
  route_key = "POST /{integration}"
  target    = "integrations/${aws_apigatewayv2_integration.ingest.id}"
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.ingest.id
  name        = "$default"
  auto_deploy = true

  # The endpoint is internet-facing and unauthenticated up to the signature check, so an attacker
  # can make us do HMAC work for free. `.agents/guidance/aws.md` prescribes WAF for API servers;
  # for a serverless webhook receiver that is disproportionate for v1, and stage throttling is the
  # proportionate abuse guard -- it caps spend and concurrency well above any real delivery rate.
  default_route_settings {
    throttling_burst_limit = var.ingest_throttle_burst
    throttling_rate_limit  = var.ingest_throttle_rate
  }

  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.ingest_access.arn
    format = jsonencode({
      requestId      = "$context.requestId"
      httpMethod     = "$context.httpMethod"
      routeKey       = "$context.routeKey"
      status         = "$context.status"
      responseLength = "$context.responseLength"
      requestTime    = "$context.requestTime"
      sourceIp       = "$context.identity.sourceIp"
      integrationErr = "$context.integrationErrorMessage"
    })
  }
}

resource "aws_cloudwatch_log_group" "ingest_access" {
  name              = "/aws/apigateway/${local.ingest_function_name}"
  retention_in_days = var.lambda_log_retention_days
}

# Scoped to this API rather than to `*`: without a source_arn any API in any account could invoke
# the function.
resource "aws_lambda_permission" "ingest" {
  statement_id  = "AllowExecutionFromApiGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.webhook_ingest.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.ingest.execution_arn}/*/*/{integration}"
}
