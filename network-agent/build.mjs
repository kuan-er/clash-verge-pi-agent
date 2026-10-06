import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

import { loadSettings } from './config.mjs'

const privateKeyFile = process.env.PASH_EMBEDDED_API_KEY_FILE
const embeddedKey = privateKeyFile
  ? (await loadSettings(privateKeyFile)).apiKey
  : ''

await build({
  entryPoints: [fileURLToPath(new URL('stdio.mjs', import.meta.url))],
  outfile: fileURLToPath(
    new URL('../src-tauri/resources/network-agent.mjs', import.meta.url),
  ),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  define: {
    'globalThis.__pashEmbeddedApiKey': JSON.stringify(embeddedKey),
  },
  banner: {
    js: "import { createRequire as __networkAgentCreateRequire } from 'node:module'; const require = __networkAgentCreateRequire(import.meta.url);",
  },
})
