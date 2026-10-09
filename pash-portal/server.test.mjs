import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer as createHTTPServer } from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { setTimeout } from 'node:timers/promises'

test('portal serves the login page and authenticates while the node is unavailable', {
  timeout: 15000,
}, async (t) => {
  const state = await mkdtemp(join(tmpdir(), 'pash-portal-recovery-'))
  const reserve = createServer()
  reserve.listen(0, '127.0.0.1')
  await once(reserve, 'listening')
  const port = reserve.address().port
  await new Promise((resolve) => reserve.close(resolve))
  const password = randomBytes(24).toString('hex')
  const child = spawn(
    process.execPath,
    [new URL('./server.mjs', import.meta.url).pathname],
    {
      env: {
        ...process.env,
        PASH_STATE_DIR: state,
        PASH_PUBLIC_URL: 'https://example.test',
        PASH_PORTAL_PORT: String(port),
        PASH_NODE_SOCKET: join(state, 'node.sock'),
        PASH_MASTER_KEY: randomBytes(32).toString('hex'),
        PASH_CERT_FINGERPRINT: '0'.repeat(64),
        PASH_ADMIN_USERNAME: 'recovery-test',
        PASH_ADMIN_PASSWORD: password,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  let logs = ''
  child.stdout.on('data', (chunk) => {
    logs += chunk
  })
  child.stderr.on('data', (chunk) => {
    logs += chunk
  })
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit')
      child.kill()
      await exited
    }
    await rm(state, { recursive: true, force: true })
  })
  const base = `http://127.0.0.1:${port}`
  let response
  for (let attempt = 0; attempt < 100; attempt++) {
    assert.equal(child.exitCode, null, logs)
    try {
      response = await fetch(base)
      break
    } catch {
      await setTimeout(50)
    }
  }
  assert.equal(response?.status, 200, logs)
  assert.match(await response.text(), /pash/)
  assert.equal((await fetch(base + '/app.js')).status, 200)
  const health = await fetch(base + '/portal-health')
  assert.equal(health.status, 503)
  assert.deepEqual(await health.json(), { ok: false, synced: false })
  const login = await fetch(base + '/api/client/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'recovery-test', password }),
  })
  assert.equal(login.status, 200)
  const { sessionToken, subscriptionUrl } = await login.json()
  const me = await fetch(base + '/api/me', {
    headers: { Authorization: 'Bearer ' + sessionToken },
  })
  assert.equal(me.status, 200)
  assert.equal((await me.json()).nodeHealthy, false)
  await t.test(
    'subscription routes domestic destinations before the US fallback',
    async (t) => {
      const node = createHTTPServer((request, response) => {
        request.resume()
        response.setHeader('Content-Type', 'application/json')
        response.end(
          JSON.stringify({
            users: {},
            serverNetwork: { received: 0, sent: 0 },
          }),
        )
      })
      node.listen(join(state, 'node.sock'))
      await once(node, 'listening')
      t.after(() => new Promise((resolve) => node.close(resolve)))
      for (let attempt = 0; attempt < 50; attempt++) {
        if ((await fetch(`${base}/portal-health`)).status === 200) break
        await setTimeout(50)
      }
      const url = new URL(subscriptionUrl)
      const subscription = await fetch(`${base}${url.pathname}${url.search}`)
      assert.equal(subscription.status, 200)
      const yaml = await subscription.text()
      const rules = yaml
        .split('rules:\n')[1]
        .trim()
        .split('\n')
        .map((line) => line.trim().slice(2))
      assert.equal(rules.at(-1), 'MATCH,pash 美国')
      for (const direct of [
        'PROCESS-NAME,WeChat,DIRECT',
        'DOMAIN-SUFFIX,qq.com,DIRECT',
        'GEOSITE,cn,DIRECT',
        'GEOIP,CN,DIRECT',
      ]) {
        assert.ok(
          rules.slice(0, -1).includes(direct),
          `Missing domestic route: ${direct}`,
        )
      }
      assert.match(yaml, /skip-cert-verify":false/)
    },
  )
})
