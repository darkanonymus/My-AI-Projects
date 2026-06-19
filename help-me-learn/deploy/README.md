# Deploy on a free, always-on server (Oracle Cloud Always Free)

Goal: run the backend 24/7 on a free server with a stable HTTPS address, so the
app (and the installed PWA on your phone) works from anywhere — no cloudflared
tunnel to restart, no PC kept on.

Oracle's **Always Free** ARM VM gives **4 CPU + 24 GB RAM + 200 GB disk, free
forever** — plenty for Piper (TTS) + Whisper (STT) + Argos (translation).

## 1. Create the VM
1. Sign up at <https://www.oracle.com/cloud/free/> (Always Free, no charge).
2. **Create instance** → image **Ubuntu 22.04**, shape **VM.Standard.A1.Flex**
   (Ampere/arm64). Give it **4 OCPU / 24 GB** (all within Always Free). Add your
   SSH key.
3. **Networking → open ports 80 and 443:**
   - VCN → Security List → add **Ingress** rules: source `0.0.0.0/0`, TCP ports
     **80** and **443**.
   - On the VM itself, allow them too:
     ```bash
     sudo iptables -I INPUT -p tcp --dport 80 -j ACCEPT
     sudo iptables -I INPUT -p tcp --dport 443 -j ACCEPT
     sudo netfilter-persistent save
     ```

## 2. Free domain (for HTTPS)
HTTPS needs a domain. Free option: **DuckDNS** (<https://www.duckdns.org>).
Create e.g. `help-me-learn.duckdns.org` and point it to your VM's **public IP**.

## 3. Deploy
SSH into the VM, then:
```bash
sudo apt update && sudo apt install -y git
git clone <your-repo-url> help-me-learn && cd help-me-learn

# create .env (NOT committed) with your key + domain
cat > .env <<'EOF'
OPENROUTER_API_KEY=sk-or-...your-key...
DEFAULT_PROVIDER=gemini
DOMAIN=help-me-learn.duckdns.org
EOF

bash deploy/deploy.sh
```
First boot downloads the voices (a few minutes). Watch progress:
```bash
docker compose -f deploy/docker-compose.yml logs -f app
```

## 4. Use it
Open `https://help-me-learn.duckdns.org` on any device. On the phone:
**browser menu → Add to Home Screen** → it installs as an app (iOS + Android),
now pointing at your always-on server.

## Notes
- **arm64 build**: the first `--build` compiles a few Python wheels — it can take
  several minutes. Subsequent deploys are fast.
- **Updating**: `git pull && bash deploy/deploy.sh`.
- **Data persists** in the `hml-data` Docker volume (DB, voices, model caches).
- Keep `.env` private — it holds your API key.
