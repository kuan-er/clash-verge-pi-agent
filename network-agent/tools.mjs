import { execFile } from 'node:child_process'
import { lookup } from 'node:dns/promises'
import { connect } from 'node:net'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import { Type } from 'typebox'

const exec = promisify(execFile)
const HOST =
  /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9.-]{0,251}[a-zA-Z0-9])?|\[[0-9a-fA-F:]+\])$/
const changeFields = ['mode', 'systemProxy', 'tun', 'ipv6']

export function validateChange(change) {
  if (!changeFields.includes(change.field))
    throw new Error('Unsupported setting.')
  if (change.field === 'mode') {
    if (!['rule', 'global', 'direct'].includes(change.after))
      throw new Error('Invalid proxy mode.')
  } else if (typeof change.after !== 'boolean')
    throw new Error('Expected a boolean setting.')
  return change
}

async function command(file, args, signal) {
  try {
    const { stdout, stderr } = await exec(file, args, {
      timeout: 10000,
      maxBuffer: 64 * 1024,
      signal,
      windowsHide: true,
    })
    return {
      ok: true,
      output: stdout.trim().slice(0, 12000),
      error: stderr.trim().slice(0, 2000),
    }
  } catch (error) {
    return {
      ok: false,
      code: error.code ?? error.name,
      output: String(error.stdout || '')
        .trim()
        .slice(0, 12000),
      error: String(error.stderr || error.message)
        .trim()
        .slice(0, 2000),
    }
  }
}

function proxyEnvironment() {
  return Object.fromEntries(
    [
      'HTTP_PROXY',
      'HTTPS_PROXY',
      'ALL_PROXY',
      'http_proxy',
      'https_proxy',
      'all_proxy',
    ]
      .filter((key) => process.env[key])
      .map((key) => {
        try {
          const url = new URL(process.env[key])
          return [key, `${url.protocol}//${url.hostname}:${url.port}`]
        } catch {
          return [key, 'unparseable proxy URL']
        }
      }),
  )
}

export async function systemDiagnostics(signal) {
  const commands =
    process.platform === 'darwin'
      ? [
          ['scutil', ['--proxy']],
          ['scutil', ['--dns']],
          ['route', ['-n', 'get', 'default']],
        ]
      : process.platform === 'win32'
        ? [
            ['netsh', ['winhttp', 'show', 'proxy']],
            ['ipconfig', ['/all']],
            ['route', ['print', '-4']],
          ]
        : [
            ['ip', ['route']],
            ['resolvectl', ['status']],
          ]
  const results = await Promise.all(
    commands.map(async ([file, args]) => ({
      command: `${file} ${args.join(' ')}`,
      ...(await command(file, args, signal)),
    })),
  )
  return {
    platform: process.platform,
    proxyEnvironment: proxyEnvironment(),
    results,
  }
}

export async function connectivity(host, route, port, signal) {
  if (!HOST.test(host))
    throw new Error('Use a hostname or IP address, without a URL path.')
  const started = Date.now()
  let dns
  try {
    dns = await Promise.race([
      lookup(host, { all: true }),
      new Promise((_, reject) => {
        const timer = setTimeout(
          () => reject(new Error('DNS lookup timed out')),
          5000,
        )
        timer.unref()
      }),
    ])
  } catch (error) {
    dns = { error: error.message }
  }
  if (
    route === 'proxy' &&
    (!Number.isInteger(port) || port < 1 || port > 65535)
  ) {
    throw new Error('The configured local proxy port is unavailable.')
  }
  const proxyArgs =
    route === 'proxy'
      ? ['--proxy', `http://127.0.0.1:${port}`, '--noproxy', '']
      : ['--noproxy', '*']
  const http = await command(
    'curl',
    [
      ...proxyArgs,
      '--head',
      '--silent',
      '--show-error',
      '--output',
      process.platform === 'win32' ? 'NUL' : '/dev/null',
      '--connect-timeout',
      '5',
      '--max-time',
      '8',
      '--write-out',
      '{"status":%{http_code},"remoteIp":"%{remote_ip}","dnsSeconds":%{time_namelookup},"connectSeconds":%{time_connect},"tlsSeconds":%{time_appconnect},"totalSeconds":%{time_total}}',
      `https://${host}/`,
    ],
    signal,
  )
  if (http.output) {
    try {
      http.metrics = JSON.parse(http.output)
      delete http.output
    } catch {
      /* Older curl versions may not support JSON metrics. */
    }
  }
  return { host, route, dns, http, elapsedMs: Date.now() - started }
}

export async function probeProxyPort(port, signal) {
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    return { port, open: false, error: 'No local proxy port configured.' }
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port, signal })
    const finish = (result) => {
      socket.destroy()
      resolve({ port, ...result })
    }
    socket.setTimeout(2000)
    socket.once('connect', () => finish({ open: true }))
    socket.once('error', (error) =>
      finish({ open: false, error: error.code || error.message }),
    )
    socket.once('timeout', () => finish({ open: false, error: 'Timed out' }))
  })
}

export function createTools(snapshot, proposals) {
  const result = (value) => ({
    content: [{ type: 'text', text: JSON.stringify(value) }],
    details: value,
  })
  return [
    {
      name: 'network_status',
      label: 'Network status',
      description:
        'Read the current Clash settings and probe its local proxy port. Contains no subscription credentials.',
      parameters: Type.Object({}),
      execute: async (_, __, signal) =>
        result({
          ...snapshot,
          listener: await probeProxyPort(snapshot.mixedPort, signal),
        }),
    },
    {
      name: 'system_diagnostics',
      label: 'System diagnostics',
      description:
        'Read OS proxy, DNS, default route and proxy environment settings. Does not change the system.',
      parameters: Type.Object({}),
      execute: async (_, __, signal) => result(await systemDiagnostics(signal)),
    },
    {
      name: 'check_connectivity',
      label: 'Connectivity check',
      description:
        'Check DNS and HTTPS HEAD connectivity directly or through the configured local Clash HTTP proxy. DNS lookup uses the OS resolver; proxy DNS may differ.',
      parameters: Type.Object({
        host: Type.String({ maxLength: 253 }),
        route: Type.Union([Type.Literal('direct'), Type.Literal('proxy')]),
      }),
      execute: async (_, args, signal) =>
        result(
          await connectivity(args.host, args.route, snapshot.mixedPort, signal),
        ),
    },
    {
      name: 'propose_change',
      label: 'Propose setting change',
      description:
        'Create a preview for changing mode, systemProxy, tun or ipv6. This tool NEVER applies changes. The user applies previews in the app.',
      parameters: Type.Object({
        field: Type.Union(changeFields.map((field) => Type.Literal(field))),
        value: Type.Union([
          Type.Boolean(),
          Type.Literal('rule'),
          Type.Literal('global'),
          Type.Literal('direct'),
        ]),
        reason: Type.String({ maxLength: 1000 }),
      }),
      execute: async (_, args) => {
        const proposal = validateChange({
          id: randomUUID(),
          field: args.field,
          before: snapshot[args.field],
          after: args.value,
          reason: args.reason,
        })
        if (proposal.before === proposal.after)
          throw new Error('The requested setting already has this value.')
        proposals.push(proposal)
        return result({ ...proposal, status: 'pending_user_approval' })
      },
    },
    {
      name: 'propose_proxy_chain',
      label: 'Proxy chain preview',
      description:
        'Create a persistent chain preview using an existing exit node and transit select group from network_status.chain. Sets dialer-proxy on the exit and a /204 URL on the transit selector. Optionally adds and selects the exit in a separate traffic group. Never applies changes. Node credentials stay in the native app.',
      parameters: Type.Object({
        exitNode: Type.String({ maxLength: 256 }),
        transitGroup: Type.String({ maxLength: 256 }),
        probeUrl: Type.String({ maxLength: 2048 }),
        trafficGroup: Type.Optional(Type.String({ maxLength: 256 })),
        reason: Type.String({ maxLength: 1000 }),
      }),
      execute: async (_, args) => {
        const chain = snapshot.chain
        if (!chain?.version?.profileId)
          throw new Error('Open a profile in pash before configuring a chain.')
        if (!chain.nodes.some((node) => node.name === args.exitNode))
          throw new Error(
            'Choose an existing exit node from network_status.chain.nodes.',
          )
        const transit = chain.groups.find(
          (group) => group.name === args.transitGroup,
        )
        if (
          transit?.type !== 'select' ||
          transit.members?.includes(args.exitNode)
        )
          throw new Error(
            'Choose a transit select group that excludes the exit node.',
          )
        if (
          args.trafficGroup &&
          (args.trafficGroup === args.transitGroup ||
            !chain.groups.some(
              (group) =>
                group.name === args.trafficGroup && group.type === 'select',
            ))
        )
          throw new Error('Choose a separate select group for traffic.')
        const url = new URL(args.probeUrl)
        if (
          !['http:', 'https:'].includes(url.protocol) ||
          url.username ||
          url.password ||
          url.search ||
          url.hash ||
          !(
            url.pathname === '/204' ||
            (['www.google.com', 'www.gstatic.com'].includes(url.hostname) &&
              url.pathname === '/generate_204')
          )
        )
          throw new Error('Use a credential-free /204 URL on the exit server.')
        const proposal = {
          id: randomUUID(),
          field: 'chain',
          before: chain.version,
          after: {
            exitNode: args.exitNode,
            transitGroup: args.transitGroup,
            probeUrl: url.href,
            trafficGroup: args.trafficGroup || null,
          },
          reason: args.reason,
        }
        proposals.push(proposal)
        return result({ ...proposal, status: 'pending_user_approval' })
      },
    },
  ]
}
