# macOS releases and in-app updates

pash releases use their own app identity, updater public key and GitHub release
feed. The upstream updater cannot replace this fork. Production app data lives
under `io.github.kuan-er.pash`; development keeps its existing
development data directory. Normal updates replace the app bundle and preserve
app data and conversations.

The app checks on launch, hourly while visible, and on focus after a 15-minute
deduplication window. A new version opens the update dialog once per app session.
Users can dismiss it and reopen it from the sidebar badge or Settings. Clicking
**Update and Restart** downloads the matching architecture, verifies its
signature and signed version, installs it, and restarts the app. Failed downloads
or signatures show an error and permit another attempt.

## Signing

Keep the updater private key outside this repository and back it up. Existing
clients trust the public key in `src-tauri/tauri.conf.json`; replacing that key
without a migration breaks their update path. Configure the repository secret
`TAURI_SIGNING_PRIVATE_KEY` and, for an encrypted key,
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. These keys are unrelated to DeepSeek.

The local build script defaults to the sibling file
`.release-signing/clash-verge-pi-agent.key`. Set `TAURI_SIGNING_PRIVATE_KEY` to use
another location. Do not put either updater or DeepSeek secrets in source files.
The release workflow does not include a DeepSeek API key. Public packages use
the HTTPS URL in `network-agent/hosted-service.json` and need no user-supplied
key. Deploy and verify the [VPS relay](./relay/README.md) before setting that URL
and publishing; tag builds refuse to publish without it. Existing local
`network-agent.env` keys in the production app-data directory take precedence
and continue to call DeepSeek directly. Provider key rotation only requires
updating the private VPS environment and restarting the relay.

For a personal package only, set `PASH_EMBEDDED_API_KEY_FILE` to an existing local
key file when building. This embeds its key in the worker; it is recoverable from
the package. Never upload that package to a public release. On first use, when
the app-data key file is missing, the personal package saves the key there with
owner-only permissions so subsequent key-free updates continue to work. Existing
local and environment keys take precedence.

Updater signing does not provide Apple notarization. Without Apple credentials,
the build uses ad-hoc signing and macOS can require explicit approval to open a
downloaded app. To distribute a notarized build, configure `APPLE_CERTIFICATE`,
`APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`,
`APPLE_PASSWORD` (an app-specific password), and `APPLE_TEAM_ID` as repository
secrets. Never regenerate the updater key when adding Apple signing.

## Publish a version

1. Merge the intended changes, including any upstream fixes, into `pi-agent`.
2. Run `npm run release-version -- 0.1.1` (use the new version), and add its
   user-visible changes at the top of `network-agent/CHANGELOG.md`.
3. Commit and push the version changes, then tag that commit:

   ```sh
   git tag pash-v0.1.1
   git push origin pi-agent
   git push origin pash-v0.1.1
   ```

The **pash macOS Release** workflow builds Apple Silicon and Intel packages, bundles
Node.js, signs update archives, and publishes the release only after both builds
succeed and all assets are uploaded. Its `latest.json` points to immutable
versioned archives and carries each complete signature. Publishing the release
makes the update visible to clients; a Git commit alone does not.

Use a new, higher version to ship a fix or revert a broken release. Do not replace
assets of a published version. Manual workflow dispatch produces build artifacts
without publishing a release, so it can validate the pipeline first.

## Local build

The macOS packages require macOS 13.5 or newer, matching the bundled Node 24
[platform requirements](https://github.com/nodejs/node/blob/v24.21.0/BUILDING.md#platform-list).

```sh
bash scripts/build-pi-macos.sh
```

The target defaults to the host architecture. Install the appropriate Rust target
before passing `x86_64-apple-darwin` or `aarch64-apple-darwin` explicitly. Outputs
are under `target/<target>/release/bundle`: a `.dmg` for installation and an
`.app.tar.gz` plus `.sig` for updates. The bundled runtime is fetched from Node's
official distribution and checked against its SHA-256 manifest. End users do not
need Node installed.
