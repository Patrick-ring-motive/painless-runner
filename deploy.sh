#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

if [[ ! -f .dev.vars ]]; then
  echo "Copy .dev.vars.example to .dev.vars and fill in its values"
  exit 1
fi

set -a
# shellcheck disable=SC1091
source .dev.vars
set +a

required_vars=(
  ACCESS_CLIENT_ID
  ACCESS_CLIENT_SECRET
  GITHUB_TOKEN
  CALLBACK_TOKEN
  CLOUDFLARE_TUNNEL_TOKEN
  WORKER_CALLBACK_URL
)
for name in "${required_vars[@]}"; do
  if [[ -z "${!name:-}" || "${!name}" == "replace-me" ]]; then
    echo "$name must be set in .dev.vars"
    exit 1
  fi
done

if [[ ! -d node_modules ]]; then
  npm install
fi

if ! npx wrangler whoami >/dev/null 2>&1; then
  npx wrangler login
fi

for name in ACCESS_CLIENT_ID ACCESS_CLIENT_SECRET GITHUB_TOKEN CALLBACK_TOKEN CLOUDFLARE_TUNNEL_TOKEN; do
  printf '%s' "${!name}" | npx wrangler secret put "$name"
done

npx wrangler types
npm run check
npx wrangler deploy
