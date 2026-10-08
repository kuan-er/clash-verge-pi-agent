import type { ProxyViewV1 } from '@/types/proxy-view'

export type ChainConfig = {
  proxies?: { name?: string; 'dialer-proxy'?: string }[]
  'proxy-groups'?: { name?: string; type?: string; url?: string }[]
  'proxy-providers'?: Record<string, { override?: { 'dialer-proxy'?: string } }>
}

export type TransitProbe = {
  exit: string
  group: string
  url: string
  candidates: string[]
}

/**
 * Accepts the standard `/204` endpoint on any host, plus Google's
 * `/generate_204` fallback used until the exit service exists.
 */
function probeUrl(raw: string | undefined): string | null {
  if (!raw) return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    return null
  const isExit204 = url.pathname === '/204'
  const isGoogleGenerate204 =
    ['www.google.com', 'www.gstatic.com'].includes(url.hostname) &&
    url.pathname === '/generate_204'
  return isExit204 || isGoogleGenerate204 ? url.href : null
}

/**
 * Finds the chain whose transit selector is safe to reorder: an exit node whose
 * `dialer-proxy` names a selector group that declares a probe URL. The exit is
 * taken from the YAML link rather than guessed from the live view, because this
 * project fixes the exit and only optimizes the transit hop.
 */
export function findTransitProbe(
  config: ChainConfig | null,
  view: ProxyViewV1,
): TransitProbe | null {
  if (!config) return null

  const exits = [...(config.proxies || [])]
  for (const node of Object.values(view.records || {})) {
    if (node.source.kind === 'provider') {
      const dialer =
        config['proxy-providers']?.[node.source.providerName]?.override?.[
          'dialer-proxy'
        ]
      if (dialer) exits.push({ name: node.name, 'dialer-proxy': dialer })
    }
  }

  for (const proxy of exits) {
    const exit = proxy.name
    const dialer = proxy['dialer-proxy']
    if (!exit || !dialer) continue

    const declared = config['proxy-groups']?.find(
      (item) => item.name === dialer,
    )
    if (!declared) continue
    if (declared.type && declared.type.toLowerCase() !== 'select') continue

    const url = probeUrl(declared.url)
    if (!url) continue

    const group = view.groups.find((item) => item.name === dialer)
    if (!group || group.type.toLowerCase() !== 'selector') continue

    const candidates = group.members
      .filter((member) => member.kind === 'node')
      .map((member) => member.name)
      .filter((name) => name !== exit)
    if (candidates.length === 0) continue

    return { exit, group: dialer, url, candidates }
  }
  return null
}

export function transitProbeIssue(config: ChainConfig | null): {
  code: 'missing_url' | 'no_chain'
  group?: string
} {
  for (const proxy of config?.proxies || []) {
    const group = config?.['proxy-groups']?.find(
      (item) => item.name === proxy['dialer-proxy'] && item.type === 'select',
    )
    if (group && !probeUrl(group.url))
      return { code: 'missing_url', group: group.name }
  }
  return { code: 'no_chain' }
}

export function fastestTransit(
  candidates: string[],
  delays: Map<string, number>,
): string | null {
  let winner: string | null = null
  let best = Infinity
  for (const name of candidates) {
    const delay = delays.get(name)
    if (delay != null && Number.isFinite(delay) && delay > 0 && delay < best) {
      best = delay
      winner = name
    }
  }
  return winner
}
