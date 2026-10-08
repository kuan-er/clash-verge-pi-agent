import { delayProxyByName, selectNodeForGroup } from 'tauri-plugin-mihomo-api'

import {
  getProfiles,
  getProxyView,
  getRuntimeConfig,
  recordSelectedNode,
  syncTrayProxySelection,
} from '@/services/cmds'

import {
  fastestTransit,
  findTransitProbe,
  transitProbeIssue,
  type ChainConfig,
} from './transit-probe'

type TransitResult = {
  code:
    | 'missing_url'
    | 'no_chain'
    | 'unreachable'
    | 'changed'
    | 'already'
    | 'selected'
  group?: string
  node?: string
}
let running: Promise<TransitResult> | null = null

async function run(): Promise<TransitResult> {
  const [config, view, profiles] = await Promise.all([
    getRuntimeConfig(),
    getProxyView(),
    getProfiles(),
  ])
  const probe = findTransitProbe(config as ChainConfig | null, view)
  if (!probe) return transitProbeIssue(config as ChainConfig | null)

  const delays = new Map<string, number>()
  for (const name of probe.candidates) {
    try {
      const result = await delayProxyByName(name, probe.url, 5000)
      delays.set(name, result.delay)
    } catch {
      // Unreachable candidates must not displace a working selection.
    }
  }
  const winner = fastestTransit(probe.candidates, delays)
  if (!winner) return { code: 'unreachable' }

  const [nextConfig, nextView, nextProfiles] = await Promise.all([
    getRuntimeConfig(),
    getProxyView(),
    getProfiles(),
  ])
  const current = findTransitProbe(nextConfig as ChainConfig | null, nextView)
  if (
    profiles.current !== nextProfiles.current ||
    !current ||
    current.exit !== probe.exit ||
    current.group !== probe.group ||
    current.url !== probe.url ||
    !current.candidates.includes(winner)
  ) {
    return { code: 'changed' }
  }
  if (
    nextView.groups.find((group) => group.name === probe.group)?.now === winner
  )
    return { code: 'already', node: winner }

  await selectNodeForGroup(probe.group, winner)
  await recordSelectedNode(probe.group, winner)
  await syncTrayProxySelection()
  return { code: 'selected', node: winner }
}

export function updateFastestTransit(): Promise<TransitResult> {
  if (!running) running = run().finally(() => (running = null))
  return running
}
