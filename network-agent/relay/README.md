# Hosted pash AI service

The public app sends OpenAI-compatible streaming requests to this relay. Only
the VPS holds `DEEPSEEK_API_KEY`; the relay inserts it when calling the fixed
DeepSeek endpoint. Pi, terminal execution, setting previews and conversations
remain on the user's computer. Messages and selected diagnostic evidence pass
through the VPS to DeepSeek. The relay does not log message bodies or keys.

This is an anonymous service. `Bearer pash-public` is a Pi SDK placeholder,
not an access secret. A public client cannot keep a shared access token secret.
The service limits concurrency, requests per minute and daily tokens globally
and by client IP. Global daily limits also apply when callers change IPs.
Shared networks share their IP allowance. New requests receive a Chinese error
when the service is busy or an allowance is exhausted.

Defaults allow four concurrent requests globally, one per IP, 120 requests per
minute globally and 24 per IP, 1,000,000 daily tokens globally and 100,000 per IP.
Only `deepseek-flash` with thinking disabled is supported; each completion is
capped at 3,072 tokens, each request at 256 KiB and 60 seconds. These are token
limits, not a currency spending guarantee. Provider prices and billable cache
categories determine actual cost. Daily token accounting uses UTC, survives
restarts in SQLite and stores daily hashes of IP addresses. Before dispatch, the
relay reserves a conservative input/output allowance and settles it from the
stream's reported usage. Interrupted streams without usage keep that allowance
charged. An unusually large request can exceed the remaining allowance even if
its eventual usage would have been smaller. Counts older than two days are
removed.

## VPS deployment

Use Node.js 24.21 or newer and an HTTPS reverse proxy. The relay itself binds
only to `127.0.0.1:8787`; do not expose that port or grant the service SSH access.
No npm install is needed. Preserve existing proxy services and choose a free
port if 8787 is in use.

On a systemd host, create a `pash-ai` system user. Install `server.mjs` and
`quota.mjs` in `/opt/pash-ai` as root-owned, read-only files, and copy
`pash-ai.service` to `/etc/systemd/system/`. Put the real key and optional limits
from `relay.env.example` in `/etc/pash-ai/relay.env`, owned by root with mode
`0600`. This is the only provider-key file required. Never commit or upload it
to GitHub. The service creates `/var/lib/pash-ai/quota.sqlite` privately.
If Node is installed privately at `/opt/pash-ai/runtime/node`, override the
service's `ExecStart` with that absolute path in a systemd drop-in.

Point an owned domain at the VPS and allow HTTPS certificate issuance. Add the
site from `Caddyfile.example` to the existing Caddy configuration, replacing
`ai.example.com` with that domain. Caddy must overwrite `X-Forwarded-For` with
the actual remote IP; otherwise callers could spoof the per-IP limits. If
another trusted proxy sits in front, configure its trusted IP ranges explicitly
and adapt client-IP handling before deploying. Streaming buffering must be off.
An existing web server may be used instead; do not replace it blindly.

```sh
systemctl daemon-reload
systemctl enable --now pash-ai
caddy validate --config /etc/caddy/Caddyfile
systemctl reload caddy
curl --fail https://YOUR_DOMAIN/healthz
```

If no domain is available, Let's Encrypt's `shortlived` profile supports public
IP certificates. With Caddy 2.11.7, use `Caddyfile.ip.example`, replacing the
documentation IP with the VPS's public IP. This serves HTTPS on 8443 and proves
IP control through HTTP on 80; both ports must be reachable. Port 443 remains
available for an existing proxy service. Caddy stores its ACME state privately
and renews the roughly six-day certificate automatically. Install the dedicated
`pash-ai-web.service` with a `pash-web` system user, a root-owned Caddy binary at
`/usr/local/bin/pash-caddy` and `/etc/pash-ai/Caddyfile` readable by that user.
Keep `/etc/pash-ai/relay.env` readable only by root. Validate and reload through
that dedicated service, rather than another Caddy instance.

On an OpenRC/container host, use its native service manager with the same private
environment, non-root user, persistent state and loopback listener. A trusted
certificate for a domain or public IP is required; an AnyTLS self-signed certificate and
port mapping are not an HTTPS service endpoint.

After a real streamed tool-call test succeeds over public HTTPS, set
`baseUrl` in `../hosted-service.json` to `https://YOUR_DOMAIN/v1`, or
`https://YOUR_IP:8443/v1` for an IP endpoint. Public app builds then require no
user setup. `PASH_AI_BASE_URL` can override that public
URL for development/builds, and `network-agent.env` may contain the same setting.
The URL contains no credential. Existing local DeepSeek keys take precedence
and continue to call DeepSeek directly.

## Updates and key rotation

To update the relay, replace its two code files and restart `pash-ai`. Keep the
private environment, SQLite state and domain. Clients need no update while the
API remains compatible. Rotate the provider key in the root-only environment
file and restart the service; no app rebuild is required. Review aggregate
provider usage before raising quotas.

Client updates keep the existing signed GitHub release flow described in
[RELEASING.md](../RELEASING.md). A domain change requires a new app release;
keep the old endpoint working during migration. Public tag builds refuse to
release without an HTTPS service URL.

For a local server, supply a private environment file with Node's `--env-file`
option and set `STATE_DIRECTORY` to a writable private folder. The file must use
`DEEPSEEK_API_KEY=...` syntax, rather than a bare key. The server requires HTTPS
termination for app clients; HTTP loopback is used by its regression tests only.

```sh
node --env-file=/private/relay.env network-agent/relay/server.mjs
npm test --prefix network-agent
```
