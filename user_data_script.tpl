#!/bin/bash
dnf update -y
dnf install nginx -y
systemctl start nginx
systemctl enable nginx

TOKEN=$(curl -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 21600")

INSTANCE_ID=$(curl -H "X-aws-ec2-metadata-token: $TOKEN" -s http://169.254.169.254/latest/meta-data/instance-id)
INSTANCE_TYPE=$(curl -H "X-aws-ec2-metadata-token: $TOKEN" -s http://169.254.169.254/latest/meta-data/instance-type)
AVAILABILITY_ZONE=$(curl -H "X-aws-ec2-metadata-token: $TOKEN" -s http://169.254.169.254/latest/meta-data/placement/availability-zone)
PUBLIC_IPV4=$(curl -H "X-aws-ec2-metadata-token: $TOKEN" -s http://169.254.169.254/latest/meta-data/public-ipv4)
PRIVATE_IPV4=$(curl -H "X-aws-ec2-metadata-token: $TOKEN" -s http://169.254.169.254/latest/meta-data/local-ipv4)

cat <<EOT > /usr/share/nginx/html/index.html
<!DOCTYPE html>
<html lang="fr">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Infos Instance EC2 (NGINX) - ${environment_name_tpl}</title>
    <style>
      body { font-family: Arial, sans-serif; margin: 20px; background-color: #f0f8ff; color: #333; }
      h1 { color: #2072a9; }
      table { border-collapse: collapse; width: 60%; margin-top: 20px; box-shadow: 0 2px 5px rgba(0,0,0,0.15); }
      th, td { text-align: left; padding: 14px; border-bottom: 1px solid #cce5ff; }
      th { background-color: #2072a9; color: white; }
      tr:nth-child(even) { background-color: #e7f3fe; }
      tr:hover { background-color: #d1e7fd; }
    </style>
  </head>
  <body>
    <h1>Informations sur cette Instance EC2 (Servi par NGINX) - Environnement: ${environment_name_tpl}</h1>
    <table>
      <tr><th>Attribut</th><th>Valeur</th></tr>
      <tr><td>ID de l'Instance</td><td>$INSTANCE_ID</td></tr>
      <tr><td>Type d'Instance</td><td>$INSTANCE_TYPE</td></tr>
      <tr><td>Zone de Disponibilité</td><td>$AVAILABILITY_ZONE</td></tr>
      <tr><td>IP Publique IPv4</td><td>$PUBLIC_IPV4</td></tr>
      <tr><td>IP Privée IPv4</td><td>$PRIVATE_IPV4</td></tr>
      <tr><td>Nom du Projet</td><td>${project_name_tpl}</td></tr>
    </table>
  </body>
</html>
EOT