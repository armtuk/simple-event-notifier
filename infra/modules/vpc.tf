resource "aws_vpc" "main" {
  cidr_block           = "10.0.0.0/16"
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = {
    Name        = "${var.env}-${var.project_name}-main-vpc"
    Environment = "${var.env}"
  }
}

resource "aws_internet_gateway" "igw" {
  vpc_id = aws_vpc.main.id

  tags = {
    Name = "${var.env}-${var.project_name}-main-igw"
  }
}


# Public Subnets (For the NAT Gateway)
resource "aws_subnet" "subnet_public_1" {
  vpc_id            = aws_vpc.main.id
  cidr_block        = "10.0.101.0/24"
  availability_zone = "${var.aws_region}a"

  # Automatically assigns public IPs to instances launched here
  map_public_ip_on_launch = true

  tags = {
    Name = "${var.env}-${var.project_name}-subnet-public-2"
  }
}

resource "aws_subnet" "subnet_public_2" {
  vpc_id                  = aws_vpc.main.id
  cidr_block              = "10.0.102.0/24"
  availability_zone       = "${var.aws_region}b"
  map_public_ip_on_launch = true

  tags = {
    Name = "${var.env}-${var.project_name}-subnet-public-2"
  }
}

# Private Subnets (Where the Lambda Function will live)
resource "aws_subnet" "private_1" {
  vpc_id            = aws_vpc.main.id
  cidr_block        = "10.0.1.0/24"
  availability_zone = "${var.aws_region}a"

  tags = {
    Name = "${var.env}-${var.project_name}-subnet-private-1"
  }
}

resource "aws_subnet" "private_2" {
  vpc_id            = aws_vpc.main.id
  cidr_block        = "10.0.2.0/24"
  availability_zone = "us-east-1b"

  tags = {
    Name = "lambda-vpc-private-2-us-east-1b"
  }
}

# ==============================================================================
# 3. NAT GATEWAY CONFIGURATION
# ==============================================================================

# NAT Gateway requires a static public IP address (Elastic IP)
resource "aws_eip" "nat" {
  domain     = "vpc"
  depends_on = [aws_internet_gateway.igw] # Best practice to prevent allocation race conditions

  tags = {
    Name = "lambda-vpc-nat-eip"
  }
}

# NAT Gateway must be deployed into a PUBLIC subnet to reach the Internet Gateway
resource "aws_nat_gateway" "nat" {
  allocation_id = aws_eip.nat.id
  subnet_id     = aws_subnet.subnet_public_1.id

  tags = {
    Name = "${var.env}-${var.project_name}-main-vpc-nat-gateway"
  }

  # To ensure proper ordering, it is recommended to add an explicit dependency
  # on the Internet Gateway for the VPC.
  depends_on = [aws_internet_gateway.igw]
}

# ==============================================================================
# 4. ROUTE TABLES & ASSOCIATIONS
# ==============================================================================

# Public Route Table: Routes 0.0.0.0/0 to the Internet Gateway
resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.igw.id
  }

  tags = {
    Name = "${var.env}-${var.project_name}-main-vpc-public-rt"
  }
}

resource "aws_route_table_association" "public_1" {
  subnet_id      = aws_subnet.subnet_public_1.id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table_association" "public_2" {
  subnet_id      = aws_subnet.subnet_public_2.id
  route_table_id = aws_route_table.public.id
}

# Private Route Table: Routes 0.0.0.0/0 to the NAT Gateway
resource "aws_route_table" "private" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.nat.id
  }

  tags = {
    Name = "${var.env}-${var.project_name}-main-vpc-private-rt"
  }
}

resource "aws_route_table_association" "private_1" {
  subnet_id      = aws_subnet.private_1.id
  route_table_id = aws_route_table.private.id
}

resource "aws_route_table_association" "private_2" {
  subnet_id      = aws_subnet.private_2.id
  route_table_id = aws_route_table.private.id
}

# ==============================================================================
# 5. OUTPUTS (To reference in your Lambda configuration)
# ==============================================================================
output "vpc_id" {
  value       = aws_vpc.main.id
  description = "The ID of the VPC"
}

output "private_subnet_ids" {
  value       = [aws_subnet.private_1.id, aws_subnet.private_2.id]
  description = "List of IDs of private subnets for Lambda placement"
}