import { describe, expect, test } from 'vitest'

import type { ProxyViewV1 } from '@/types/proxy-view'

import {
  fastestTransit,
  findTransitProbe,
  transitProbeIssue,
} from './transit-probe'

const view = {
  global: { name: 'GLOBAL', type: 'Selector', now: 'DIRECT', members: [] },
  groups: [
    {
      name: 'US出口',
      type: 'Selector',
      now: 'exit',
      members: [{ kind: 'node', name: 'exit', recordId: 'c:0' }],
    },
    {
      name: 'transit',
      type: 'Selector',
      now: 'a',
      members: [
        { kind: 'node', name: 'a', recordId: 'c:1' },
        { kind: 'node', name: 'b', recordId: 'c:2' },
      ],
    },
  ],
} as unknown as ProxyViewV1

const config = {
  proxies: [{ name: 'exit', 'dialer-proxy': 'transit' }],
  'proxy-groups': [
    { name: 'transit', type: 'select', url: 'https://exit.example/204' },
  ],
}

describe('transit probe', () => {
  test('reports the missing URL from the current Hkus profile', () => {
    expect(
      transitProbeIssue({
        proxies: [{ name: 'US-AnyTLS', 'dialer-proxy': '香港入口' }],
        'proxy-groups': [{ name: '香港入口', type: 'select' }],
      }),
    ).toEqual({ code: 'missing_url', group: '香港入口' })
  })

  test('finds provider-backed exits with a declared dialer override', () => {
    const providerView = {
      ...view,
      records: {
        exit: {
          name: 'exit',
          source: { kind: 'provider', providerName: 'provider' },
        },
      },
    } as unknown as ProxyViewV1
    expect(
      findTransitProbe(
        {
          ...config,
          proxies: [],
          'proxy-providers': {
            provider: { override: { 'dialer-proxy': 'transit' } },
          },
        },
        providerView,
      )?.exit,
    ).toBe('exit')
  })
  test('finds the chain from the declared dialer-proxy link', () => {
    expect(findTransitProbe(config, view)).toEqual({
      exit: 'exit',
      group: 'transit',
      url: 'https://exit.example/204',
      candidates: ['a', 'b'],
    })
  })

  test('accepts the Google generate_204 fallback', () => {
    expect(
      findTransitProbe(
        {
          ...config,
          'proxy-groups': [
            {
              name: 'transit',
              type: 'select',
              url: 'https://www.google.com/generate_204',
            },
          ],
        },
        view,
      )?.url,
    ).toBe('https://www.google.com/generate_204')
  })

  test('does not use an unrelated URL', () => {
    expect(
      findTransitProbe(
        {
          ...config,
          'proxy-groups': [
            {
              name: 'transit',
              type: 'select',
              url: 'https://other.example/generate_204',
            },
          ],
        },
        view,
      ),
    ).toBeNull()
  })

  test('does not treat a group without a dialer link as an exit', () => {
    expect(
      findTransitProbe({ ...config, proxies: [{ name: 'exit' }] }, view),
    ).toBeNull()
  })

  test('ignores failed and invalid delays', () => {
    expect(
      fastestTransit(
        ['a', 'b'],
        new Map([
          ['a', 0],
          ['b', 42],
        ]),
      ),
    ).toBe('b')
    expect(fastestTransit(['a'], new Map([['a', Infinity]]))).toBeNull()
    expect(fastestTransit(['a', 'b'], new Map())).toBeNull()
  })
})
