# painless-runner

Runs Elasticsearch in an on-demand GitHub Actions job, exposes port `9200` through Cloudflare Tunnel, and proxies a restricted API through Cloudflare Worker. A Durable Object starts or joins one workflow startup and waits up to five minutes for the tunnel. Job stops after 15 minutes without tunnel requests.

## Cloudflare setup

1. Revoke exposed tunnel token and create a replacement.
2. Configure tunnel hostname, such as `painless-origin.example.com`, with service `http://localhost:9200`.
3. Protect origin hostname with a Cloudflare Access service-token policy. Never expose Elasticsearch directly.
4. Set `ORIGIN_URL` and GitHub repository values in `wrangler.jsonc`.
5. Copy `.dev.vars.example` to `.dev.vars` and fill in every value. Quote values containing shell-special characters.
6. Authenticate Wrangler once if needed.
7. Run `./deploy.sh`. It uploads Worker secrets, validates the Worker, and deploys it. `.dev.vars` is ignored by Git.

`GITHUB_TOKEN` needs Actions read/write access. For this POC, callback and tunnel values are sent directly as encrypted HTTPS workflow-dispatch inputs. `CALLBACK_TOKEN` can be any random shared value. `WORKER_CALLBACK_URL` is configured in `wrangler.jsonc`.

## Run

Call Worker. It probes origin, joins any queued or running workflow, or dispatches **Elasticsearch Painless POC** when needed:

```sh
curl -X POST 'https://painless-runner.<account>.workers.dev/execute' \
  -H 'Content-Type: application/json' \
  -d '{
    "script": {
      "source": "int x = params.a; int y = params.b; return x + y;",
      "params": { "a": 5, "b": 7 }
    }
  }'
```

Worker allows only `POST /execute`, validates JSON size, then calls Elasticsearch `/_scripts/painless/_execute`. Each origin request resets workflow idle timer. Public POC endpoint has no client authentication.
