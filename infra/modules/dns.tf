
data "aws_route53_zone" "project-zone" {
  name = "${var.env}.${var.project_name}.${var.parent_domain}."
  private_zone = false
}

output "name_servers" {
  value = data.aws_route53_zone.project-zone.name_servers
}