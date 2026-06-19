#!/usr/bin/env bash
# One-command deploy on the Oracle Always Free VM (Ubuntu/arm64).
# Usage (from the repo root on the VM):  bash deploy/deploy.sh
set -e

cd "$(dirname "$0")/.."

# 1. Docker (install once)
if ! command -v docker >/dev/null 2>&1; then
  echo "==> installing Docker ..."
  curl -fsSL https://get.docker.com | sh
  sudo usermod -aG docker "$USER" || true
fi

# 2. .env must exist (keys + domain) — never commit it
if [ ! -f .env ]; then
  cat <<'MSG'
!! .env is missing. Create it next to this repo with:

   OPENROUTER_API_KEY=sk-or-...        # or ANTHROPIC_API_KEY=...
   DOMAIN=help-me-learn.duckdns.org    # your free DuckDNS domain -> this VM's IP

Then re-run: bash deploy/deploy.sh
MSG
  exit 1
fi

# 3. Build + run (Caddy gets HTTPS automatically for $DOMAIN)
echo "==> building and starting ..."
docker compose -f deploy/docker-compose.yml up -d --build

echo
echo "Done. First boot downloads the voices (a few minutes)."
echo "Watch logs:   docker compose -f deploy/docker-compose.yml logs -f app"
echo "Your app:     https://$(grep -E '^DOMAIN=' .env | cut -d= -f2)"
