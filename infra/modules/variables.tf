variable "aws_region" {
  type    = string
  default = "us-west-2"
}

variable "aws_profile" {
  type    = string
  default = "default"
}

variable "env" {
    type = string
    default = "development"
}

variable "project_name" {
  type = string
}

variable "parent_domain" {
    type = string
}
