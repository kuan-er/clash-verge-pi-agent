# pash user portal

The HTTPS portal provides administrator-created accounts, authenticated macOS
downloads, personal subscriptions and activation links. pash 0.1.3 can also
sign in directly and activate its personal profile. Updates retain app data.
The subscription page also supports AnyTLS-capable Clash/Mihomo clients through
a personal subscription URL, `clash://install-config` import and YAML download.
Each method uses the same account credentials and traffic counters. The remote
subscription advertises a 24-hour refresh interval and the portal homepage.

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

Source-IP counters are stored per account and survive reconnects and restarts.
The dashboard retains offline sources and shows their country, region, city,
ISP, ASN, current connections, upload/download rates and last proxy activity.
Public IPs are deduplicated, so several devices behind one router count as one
source. IP totals start when this feature is enabled; older account totals are
retained without assigning them to an IP. Legacy-proxy, portal and SSH connections
show their services but are not included in managed source-IP payload totals.

Geolocation is fetched asynchronously over HTTPS from ipwho.is and cached in
SQLite for seven days. Failed lookups show an unavailable location and retry
later. Only public source addresses are sent to the provider. No credentials,
account names or usage counters are sent. Locations are approximate.

For an upgrade, `PASH_NODE_SOCKET` can point at a successor node's private Unix
socket. An optional private `node-history.json` in the portal state directory
holds frozen earlier account and IP counters; these are added to the successor
counters exactly once on each snapshot. Its shape matches `users` and
`ipTrackingStarted` in the node metrics. The node's private `PUT /listen` control
can move its listener without closing accepted connections, supporting a
drained handover instead of terminating active proxy sessions.
Start the portal after the replacement node unit and alias are ready, and verify
`/portal-health` before recording a handover as complete. The portal has a weak
dependency on the node so stopping the node does not stop the website. If the
node is unavailable at startup, the website stays accessible and synchronization
resumes when the node returns.

The download page includes a selectable macOS quarantine-removal command and
a copy button. Clicking either Mac download also opens an installation reminder,
with instructions to install into Applications before running the command.

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
{"version":"0.1.4","assets":{"aarch64":"pash_0.1.4_aarch64.dmg","x86_64":"pash_0.1.4_x86_64.dmg","windows-x86_64":"pash_0.1.4_windows_x86_64-setup.exe"}}
```

The client currently embeds the verified public portal origin. A future origin
change requires updating `cmd/portal.rs` and the account page, then publishing
an update. Keep the existing updater signing key. Public GitHub release files
remain publicly downloadable; authentication controls personal proxy access.

Back up the state directory and master key together. Traffic, users, sessions
and node credentials survive service restarts. Keep these backups private.
