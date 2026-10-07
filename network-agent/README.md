# Pi network assistant

This prototype adds an AI Network Assistant page to Clash Verge Rev. It uses the
official Pi agent runtime (`@earendil-works/pi-agent-core` 1.0.4), Pi Coding Agent's
native terminal tool (`@earendil-works/pi-coding-agent` 1.0.4), and Pi's DeepSeek
adapter. The default model is `deepseek-flash`, with thinking disabled.

React sends requests through Tauri IPC. Rust supplies a small settings snapshot
and launches the bundled Node.js worker over stdin/stdout. Pi calls bounded
diagnostic tools, streams its progress back to the page, and produces a summary.
Public builds with a configured service URL use the hosted pash AI relay without
a user-supplied key. Only the VPS holds the provider key. Existing local keys can
still be read inside the worker for direct DeepSeek access; they are never
supplied to the webview.

The diagnostic tools inspect OS proxy settings, DNS, default routes, proxy environment
variables and the local proxy listener, and compare direct and proxy HTTPS HEAD
requests. Controller secrets, subscription URLs and node passwords are excluded
from the settings snapshot. Diagnostic evidence, including network addresses, is
sent through the pash VPS to DeepSeek when the hosted assistant is used (directly
to DeepSeek with a local key). The terminal also supports broader
commands and user-requested configuration changes; it is not restricted to the
four app setting previews.

## Run

Use Rust 1.99, pnpm 12.9.1 and a supported Node release (22.23+ or 24.18+).
Configure and verify the [hosted relay](./relay/README.md) to enable the default
service. For development, `PASH_AI_BASE_URL=https://YOUR_DOMAIN/v1` overrides
that URL; alternatively, use a local key as described below.

```sh
pnpm install --frozen-lockfile
pnpm agent:setup
pnpm prebuild
# Use the configured hosted service, or provide a local key as described below.
bash scripts/run-network-assistant.sh
```

Open **AI Network Assistant** in the sidebar. Choose **Diagnose network**, or
describe the failing application/hostname in the composer. Expand **Diagnostic
evidence** on a reply to inspect its commands and results. **Stop** cancels the
worker and its active terminal process tree.

The launcher limits debug-build disk usage. Exit any other Clash Verge client
before starting this prototype if you want to apply settings: upstream refuses
a second Mihomo core while another core is running. The initial native IPC run
verified chat, previews, cancellation, stale/invalid input rejection and recovery
after that refusal. Successful live setting changes still need a run with only
this client active.

The launcher reads `.env` in this checkout, falling back to `.env` in its parent
directory. Without the launcher, the development worker defaults to the parent
directory. A file containing just a `sk-...` key is supported, as is standard
dotenv format:

```dotenv
DEEPSEEK_API_KEY=your-key
DEEPSEEK_MODEL=deepseek-flash
DEEPSEEK_BASE_URL=https://api.deepseek.com
```

To use another location, set `NETWORK_AGENT_ENV_FILE`. Packaged apps default to
`network-agent.env` in the app data directory. macOS pash packages require macOS 13.5+ and bundle Node.js;
other platforms require Node. Use `NETWORK_AGENT_NODE` with an absolute
executable path to override the bundled runtime or the GUI's PATH lookup.
See [macOS releases and updates](./RELEASING.md).

```sh
NETWORK_AGENT_ENV_FILE=/path/to/.env pnpm dev:sidecar
```

The worker also runs independently against the installed app's saved settings:

```sh
npm start --prefix network-agent -- 'Check why Chrome cannot access Google.'
```

Set `NETWORK_AGENT_CONFIG_DIR` to inspect a different saved app configuration.
Saved settings are not proof of the live core state; the listener and OS tools
provide additional evidence. CLI app-setting changes are previews; terminal
commands also execute in the CLI.

## Setting changes

Pi's `propose_change` tool generates previews for proxy mode, system proxy, TUN
and IPv6. The app applies
each preview only when **Apply this change** is clicked, using the existing Clash
Verge configuration commands. A stale preview is rejected. The inverse is saved
before applying the change, and **Undo latest Clash setting** restores the most recent
setting when a newer change has not superseded it.

## Terminal and conversations

The assistant uses Pi's `bash` tool on macOS/Linux and `powershell` on Windows.
Commands run with the current user's permissions, in the home directory unless
`NETWORK_AGENT_WORK_DIR` is set. The default command timeout is 30 seconds, with
a maximum of 60 seconds. The whole request is limited to 150 seconds and eight
agent turns. Commands stream their output to the reply's evidence panel.

For example, ask it to inspect `launchctl` proxy variables and shell startup files,
or to fix a confirmed proxy-port mismatch. A diagnosis uses read-only commands;
a requested fix may execute commands that change configuration. The prompt tells
the agent to back up existing files, explain rollback and verify the result.
Native requests supply `NETWORK_AGENT_BACKUP_DIR` for those backups. Terminal
commands are not sandboxed, and backup creation is an agent instruction rather
than an enforced transaction. The dedicated **Undo latest Clash setting** control
only covers the four app previews; terminal changes need their own rollback
commands. Known DeepSeek keys and common credential formats are redacted from
terminal results, and the prompt excludes credential-file reads.

The page has a fixed input area and a separate scrolling conversation. Enter
sends, Shift+Enter inserts a new line, and IME composition does not submit a
message. Old replies are memoized and streamed text updates are coalesced.
Scrolling upward pauses automatic following until the view returns near the end.

Each conversation keeps its latest 80 messages, previews and draft in local
IndexedDB storage. Existing single-conversation history is migrated on first
load. Saved evidence is limited to 8 KiB per tool result. New conversations start
with independent context, and switching conversations keeps an active task
running in its original conversation. Only one terminal-backed task runs at a
time. Reloading or restarting restores conversations and marks incomplete replies
as interrupted; it does not resume commands. The current conversation's latest
24 messages, up to 8,000 characters each, are supplied as context. **Clear
conversation** clears only the selected conversation. Messages can be selected
or copied with their clipboard buttons; the composer has copy and paste buttons.

The assistant runs on request rather than as a scheduled background monitor.
Dedicated previews do not yet cover subscriptions, rules, DNS resolver editing,
browser extensions, VPN settings or node selections. Terminal access enables
additional operations but does not provide dedicated integrations for them.

The sidecar is generated with `pnpm agent:build`, and the Tauri development/build
hooks rebuild it. `npm test --prefix network-agent` covers credential exclusion,
preview-only behavior, unsafe diagnostic arguments, real terminal execution and
process-tree cancellation.

Upstream references: [Pi agent runtime](https://github.com/earendil-works/pi/tree/main/packages/agent),
[DeepSeek Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/).
