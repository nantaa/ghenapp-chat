# 1. Pull latest

cd /opt/ghenapp/repo

git pull origin main

# 2. Rebuild frontend

cd /opt/ghenapp/repo/ghenapp-web

npm run build

# 3. Deploy frontend

sudo cp -r /opt/ghenapp/repo/ghenapp-web/dist/. /var/www/ghenapp/

# 4. Rebuild backend

cd /opt/ghenapp/repo/ghenapp

go build -o /opt/ghenapp/bin/ghenapp ./cmd/server && echo "BUILD OK"

# 5. Run migrations (MISSING from your script)

migrate -path db/migrations -database "postgres://ghen:Ghenapp123%23@localhost:5432/ghenapp?sslmode=disable" up

# 6. Restart backend

sudo systemctl restart ghenapp

sudo systemctl status ghenapp --no-pager