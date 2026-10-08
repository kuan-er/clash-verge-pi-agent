import assert from 'node:assert/strict'
import { test } from 'node:test'
import { safeSnapshot } from './config.mjs'
import { connectivity, createTools, validateChange } from './tools.mjs'

test('diagnostic snapshots exclude controller and subscription credentials', () => {
  const snapshot = safeSnapshot(
    {
      mode: 'rule',
      secret: 'controller-secret',
      proxies: [{ password: 'node-password' }],
      'proxy-providers': {
        subscription: { url: 'https://example.com/private-token' },
      },
      dns: { enable: true, 'enhanced-mode': 'fake-ip' },
    },
    { webdav_password: 'webdav-secret', enable_system_proxy: true },
  )
  const text = JSON.stringify(snapshot)
  for (const value of [
    'controller-secret',
    'node-password',
    'private-token',
    'webdav-secret',
  ]) {
    assert.ok(!text.includes(value))
  }
  assert.equal(snapshot.dns.enhancedMode, 'fake-ip')
})

test('configuration tools only produce validated previews', async () => {
  const snapshot = safeSnapshot({ ipv6: true })
  const before = JSON.stringify(snapshot)
  const proposals = []
  const tools = createTools(snapshot, proposals)
  assert.deepEqual(
    tools.map((tool) => tool.name),
    [
      'network_status',
      'system_diagnostics',
      'check_connectivity',
      'propose_change',
      'propose_proxy_chain',
    ],
  )
  const tool = tools.find((entry) => entry.name === 'propose_change')
  const result = await tool.execute('preview', {
    field: 'ipv6',
    value: false,
    reason: 'Explicit user request.',
  })
  assert.equal(result.details.status, 'pending_user_approval')
  assert.equal(proposals[0].before, true)
  assert.equal(proposals[0].after, false)
  assert.equal(JSON.stringify(snapshot), before)
  assert.throws(() => validateChange({ field: 'secret', after: 'new-secret' }))
  assert.throws(() => validateChange({ field: 'tun', after: 'true' }))
  assert.throws(() => validateChange({ field: 'mode', after: 'invalid' }))
})

test('chain previews use existing names without mutating the profile', async () => {
  const snapshot = {
    chain: {
      version: { profileId: 'profile', fingerprint: 'version', plan: null },
      nodes: [{ name: 'exit' }],
      groups: [
        { name: 'transit', type: 'select', members: ['hk'] },
        { name: 'traffic', type: 'select', members: ['hk'] },
      ],
    },
  }
  const before = JSON.stringify(snapshot)
  const proposals = []
  const tool = createTools(snapshot, proposals).find(
    (entry) => entry.name === 'propose_proxy_chain',
  )
  const args = {
    exitNode: 'exit',
    transitGroup: 'transit',
    trafficGroup: 'traffic',
    probeUrl: 'https://exit.example/204',
    reason: 'Requested chain.',
  }
  await tool.execute('chain', args)
  assert.equal(proposals[0].field, 'chain')
  assert.deepEqual(proposals[0].before, snapshot.chain.version)
  assert.equal(JSON.stringify(snapshot), before)
  await assert.rejects(
    tool.execute('bad', { ...args, exitNode: 'invented' }),
    /existing exit/,
  )
  await assert.rejects(
    tool.execute('bad', {
      ...args,
      probeUrl: 'https://user:secret@exit.example/204',
    }),
    /credential-free/,
  )
  await assert.rejects(
    tool.execute('bad', { ...args, trafficGroup: 'transit' }),
    /separate/,
  )
})

test('connectivity checks reject shell fragments and arbitrary URL paths', async () => {
  for (const host of [
    'example.com; touch /tmp/unexpected',
    'https://example.com/path',
    '-o/tmp/unexpected',
  ]) {
    await assert.rejects(connectivity(host, 'direct', 7890), /hostname or IP/)
  }
})
