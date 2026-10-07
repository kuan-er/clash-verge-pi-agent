import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

import { loadSettings, validateApiEndpoint } from './config.mjs'
import hostedService from './hosted-service.json' with { type: 'json' }

const privateKeyFile = process.env.PASH_EMBEDDED_API_KEY_FILE
const embeddedKey = privateKeyFile
  ? (await loadSettings(privateKeyFile)).apiKey
  : ''
if (privateKeyFile && embeddedKey === 'pash-public')
  throw new Error('The personal build requires a DeepSeek key file.')
const hostedBaseUrl = process.env.PASH_AI_BASE_URL || hostedService.baseUrl
if (hostedBaseUrl) validateApiEndpoint(hostedBaseUrl)

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
    'globalThis.__pashHostedBaseUrl': JSON.stringify(hostedBaseUrl),
  },
  banner: {
    js: "import { createRequire as __networkAgentCreateRequire } from 'node:module'; const require = __networkAgentCreateRequire(import.meta.url);",
  },
})
