# Deployment

Two containers behind host nginx on a single EC2 box. Containers bind to
loopback; nginx terminates TLS and is the only thing listening publicly.

```
internet ──443──> nginx (host) ──> 127.0.0.1:8080  csq-landing
                                └─> 127.0.0.1:4000  csq-api
```

## Prerequisites on the box

```sh
sudo dnf install -y docker nginx     # or apt, depending on the AMI
sudo systemctl enable --now docker nginx
sudo usermod -aG docker ec2-user     # log out and back in
```

DNS: point `dev.csq.aero` and `api.dev.csq.aero` A records at the elastic IP
before requesting certificates, or the ACME challenge cannot complete.

## Certificates

```sh
sudo dnf install -y certbot python3-certbot-nginx
sudo mkdir -p /var/www/certbot
sudo certbot certonly --webroot -w /var/www/certbot \
  -d dev.csq.aero -d api.dev.csq.aero --agree-tos -m ops@csq.aero
sudo systemctl enable --now certbot-renew.timer
```

## nginx

```sh
sudo cp deploy/nginx/csq.conf /etc/nginx/conf.d/csq.conf
sudo nginx -t && sudo systemctl reload nginx
```

## Landing site

```sh
cd landing                      # in the td-csq-frontend repo
docker build -t csq-landing:$(git rev-parse --short HEAD) .
docker rm -f csq-landing 2>/dev/null
docker run -d --name csq-landing --restart unless-stopped \
  -p 127.0.0.1:8080:8080 csq-landing:$(git rev-parse --short HEAD)
```

Tag by commit rather than `latest`, so a rollback is `docker run` against the
previous tag instead of a rebuild from a moving target.

## Configuration and secrets

Nothing secret is ever baked into an image. An image layer is permanent and
readable by anyone who can pull it, so a secret COPYed in at build time is
still recoverable even if a later step deletes the file.

Runtime configuration comes from the environment, sourced from AWS Secrets
Manager or SSM Parameter Store:

```sh
aws ssm get-parameters-by-path --path /csq/dev --with-decryption \
  --query 'Parameters[].[Name,Value]' --output text > /run/csq.env
docker run -d --env-file /run/csq.env ...
```

`/run` is tmpfs, so the file does not survive a reboot on disk.

## Verifying a deploy

```sh
curl -sI https://dev.csq.aero | head -1
curl -s  https://dev.csq.aero/healthz
curl -sI https://dev.csq.aero/assets/nose-1440.avif | grep -i cache-control
```

The last one must report `immutable`. If it does not, the asset location block
is not matching and every visitor is re-downloading the imagery on each page view.
