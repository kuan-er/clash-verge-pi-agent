import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { parse } from 'yaml'
import hostedService from './hosted-service.json' with { type: 'json' }

export function validateApiEndpoint(baseUrl) {
  const endpoint = new URL(baseUrl)
  if (
    endpoint.protocol !== 'https:' ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  )
    throw new Error(
      'The AI service requires an HTTPS endpoint without URL credentials, query or fragment.',
    )
}

export async function loadSettings(envFile, env = process.env) {
  let values = {}
  let missingFile = false
  try {
    const text = (await readFile(envFile, 'utf8')).trim()
    if (/^sk-[^\s]+$/.test(text)) values.DEEPSEEK_API_KEY = text
    else {
      for (const line of text.split(/\r?\n/)) {
        const match = line.match(/^\s*(?:export\s+)?(\w+)\s*=\s*(.*?)\s*$/)
        if (!match) continue
        let value = match[2]
        if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1)
        else value = value.replace(/\s+#.*$/, '').trim()
        values[match[1]] = value
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    missingFile = true
  }
  const embeddedKey = globalThis.__pashEmbeddedApiKey || ''
  const explicitKey = env.DEEPSEEK_API_KEY || values.DEEPSEEK_API_KEY
  const apiKey = explicitKey || embeddedKey
  const hostedBaseUrl =
    env.PASH_AI_BASE_URL ||
    values.PASH_AI_BASE_URL ||
    globalThis.__pashHostedBaseUrl ||
    hostedService.baseUrl
  if (!apiKey && !hostedBaseUrl)
    throw new Error(
      'The pash AI service is not configured. Set PASH_AI_BASE_URL or DEEPSEEK_API_KEY.',
    )
  if (!explicitKey && embeddedKey && missingFile) {
    await mkdir(dirname(envFile), { recursive: true })
    try {
      await writeFile(envFile, `DEEPSEEK_API_KEY=${embeddedKey}\n`, {
        flag: 'wx',
        mode: 0o600,
      })
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
  }
  const baseUrl = apiKey
    ? env.DEEPSEEK_BASE_URL ||
      values.DEEPSEEK_BASE_URL ||
      'https://api.deepseek.com'
    : hostedBaseUrl
  validateApiEndpoint(baseUrl)
  return {
    // Pi's OpenAI-compatible client requires a nonempty API key even for an anonymous relay.
    apiKey: apiKey || 'pash-public',
    baseUrl,
    model: env.DEEPSEEK_MODEL || values.DEEPSEEK_MODEL || 'deepseek-flash',
  }
}

export function safeSnapshot(clash = {}, verge = {}) {
  return {
    mode: clash.mode ?? 'rule',
    ipv6: clash.ipv6 ?? true,
    mixedPort: clash['mixed-port'] ?? 7897,
    httpPort: clash.port ?? 0,
    socksPort: clash['socks-port'] ?? 0,
    systemProxy: verge.enable_system_proxy ?? false,
    tun: verge.enable_tun_mode ?? clash.tun?.enable ?? false,
    dns: {
      enable: clash.dns?.enable,
      enhancedMode: clash.dns?.['enhanced-mode'],
      ipv6: clash.dns?.ipv6,
    },
  }
}

export async function installedSnapshot() {
  const root =
    process.env.NETWORK_AGENT_CONFIG_DIR ||
    (process.platform === 'darwin'
      ? resolve(homedir(), 'Library/Application Support/io.github.kuan-er.pash')
      : process.platform === 'win32'
        ? resolve(process.env.APPDATA || homedir(), 'io.github.kuan-er.pash')
        : resolve(
            process.env.XDG_DATA_HOME || resolve(homedir(), '.local/share'),
            'io.github.kuan-er.pash',
          ))
  const read = async (name) => {
    try {
      return parse(await readFile(resolve(root, name), 'utf8')) || {}
    } catch (error) {
      if (error.code === 'ENOENT') return {}
      throw error
    }
  }
  const [clash, verge] = await Promise.all([
    read('config.yaml'),
    read('verge.yaml'),
  ])
  return safeSnapshot(clash, verge)
}
