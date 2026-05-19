# GhenApp Deploy Checklist

## Step 1 — Pull latest code
```bash
cd /opt/ghenapp/repo
git stash
git pull origin main
git log -1 --oneline    # confirm the commit hash matches GitHub
```

## Step 2 — Rebuild backend binary  ← THIS IS THE CRITICAL STEP
```bash
cd /opt/ghenapp/repo/ghenapp
go build -o /opt/ghenapp/bin/ghenapp-server ./cmd/server
echo "Backend build exit code: $?"   # MUST print 0
```

## Step 3 — Restart backend (must be AFTER step 2)
```bash
sudo systemctl restart ghenapp
sleep 2
sudo systemctl status ghenapp --no-pager   # must say "active (running)"
```

## Step 4 — Verify the history-blob route exists in the running server
```bash
# Should return 401 (unauthorized), NOT 404
curl -s -o /dev/null -w "%{http_code}" -X PUT \
  https://ghen-app.my.id/api/v1/conversations/test/messages/1/history-blob
# Expected output: 401
```

## Step 5 — Rebuild and deploy frontend
```bash
cd /opt/ghenapp/repo/ghenapp-web
npm run build
echo "Frontend build exit code: $?"   # MUST print 0
sudo cp -r dist/. /var/www/ghenapp/
echo "Frontend deployed"
```

## Step 6 — Run DB migrations (only needed when new migrations were added)
```bash
cd /opt/ghenapp/repo/ghenapp
migrate -path db/migrations -database "postgres://ghen:Ghenapp123%23@localhost:5432/ghenapp?sslmode=disable" up
```

---
**After deploying**: open the chat, load the conversation. 
- The first load will upload history blobs for all IDB-cached messages (background).
- After that, clearing IDB and reloading will restore messages from server blobs.