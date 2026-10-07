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
  type ChainConfig,
} from './transit-probe'

let running: Promise<string> | null = null

async function run(): Promise<string> {
  const [config, view, profiles] = await Promise.all([
    getRuntimeConfig(),
    getProxyView(),
    getProfiles(),
  ])
  const probe = findTransitProbe(config as ChainConfig | null, view)
  if (!probe) return 'No active chain with a transit selector and /204 URL'

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
  if (!winner) return 'No reachable transit node'

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
    return 'Chain changed during measurement; no selection updated'
  }
  if (
    nextView.groups.find((group) => group.name === probe.group)?.now === winner
  )
    return `Fastest transit already selected: ${winner}`

  await selectNodeForGroup(probe.group, winner)
  await recordSelectedNode(probe.group, winner)
  await syncTrayProxySelection()
  return `Fastest transit selected: ${winner}`
}

export function updateFastestTransit(): Promise<string> {
  if (!running) running = run().finally(() => (running = null))
  return running
}
