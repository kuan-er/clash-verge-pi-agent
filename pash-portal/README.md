# pash user portal

The HTTPS portal provides administrator-created accounts, authenticated macOS
downloads, personal subscriptions and activation links. pash 0.1.3 can also
sign in directly and activate its personal profile. Updates retain app data.

The managed AnyTLS node uses the upstream `sing-anytls` protocol implementation.
It listens separately from the existing owner proxy and swaps immutable user
services without restarting other users. Disabling or expiring a user closes
that user's authenticated sessions. Resetting their password also rotates their
proxy and subscription credentials.

Traffic is counted at the proxy payload layer for both TCP and UDP. Upload and
download counters are saved every second and mirrored into the portal SQLite
database. Unexpected shutdown can lose the final second. Historical usage from
the pre-existing proxy cannot be assigned retroactively. The dashboard labels
managed-account totals separately from system-boot network-interface counters.

The node exposes metrics and account synchronization only over an owner-only
Unix socket. The portal listens on loopback behind Caddy. Passwords use scrypt;
sessions use hashed random tokens and secure HttpOnly cookies. The initial
administrator credentials are written to the private state directory and are
never included in logs or installation packages.

## Deployment

Build `node/` with Go 1.23.1 or newer. Run the portal with Node 24.21.0 or newer;
it has no npm dependencies. Install the two systemd units with an unprivileged
`pash-portal` account. Configure the private environment file:

```
PASH_STATE_DIR=/var/lib/pash-portal
PASH_PUBLIC_URL=https://your-host:8443
PASH_PORTAL_PORT=8788
PASH_PROXY_PORT=4443
PASH_NODE_LISTEN=:4443
PASH_NODE_CERT=/etc/pash-portal/server.crt
PASH_NODE_KEY=/etc/pash-portal/server.key
PASH_CERT_FINGERPRINT=<SHA256 of the proxy certificate DER>
PASH_MASTER_KEY=<64 random hexadecimal characters>
```

Reverse-proxy the portal through the same HTTPS origin. Preserve the existing
AI API and `/204` handlers. Do not expose loopback or Unix-socket interfaces.
The example units use the existing bundled Node runtime.

Authenticated downloads are read from `downloads/release.json` in the state
directory. Deploy immutable signed release assets before replacing this file:

```json
{"version":"0.1.3","assets":{"aarch64":"pash_0.1.3_aarch64.dmg","x86_64":"pash_0.1.3_x86_64.dmg"}}
```

The client currently embeds the verified public portal origin. A future origin
change requires updating `cmd/portal.rs` and the account page, then publishing
an update. Keep the existing updater signing key. Public GitHub release files
remain publicly downloadable; authentication controls personal proxy access.

Back up the state directory and master key together. Traffic, users, sessions
and node credentials survive service restarts. Keep these backups private.
