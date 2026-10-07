import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRelay } from './server.mjs'

const key = 'sk-relay-test-only'
const payload = {
  model: 'deepseek-flash',
  stream: true,
  messages: [{ role: 'user', content: 'hello' }],
  max_tokens: 10,
}
const events = (tokens = 5) =>
  [
    'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"bash","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}\n\n',
    `data: {"choices":[],"usage":{"total_tokens":${tokens}}}\n\n`,
    'data: [DONE]\n\n',
  ].join('')

async function listen(server) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return `http://127.0.0.1:${server.address().port}`
}

async function fixture(t, handler, options = {}) {
  const provider = createServer(handler)
  const upstream = await listen(provider)
  const relay = createRelay({ apiKey: key, upstream, ...options })
  const base = await listen(relay.server)
  let stopped
  const stop = () =>
    (stopped ||= (async () => {
      await relay.close()
      provider.closeAllConnections()
      await new Promise((resolve) => provider.close(resolve))
    })())
  t.after(stop)
  const send = (body = payload, headers = {}) =>
    fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    })
  return { send, relay, base, stop }
}

test('the HTTP relay replaces caller credentials and preserves streamed tool calls', async (t) => {
  let calls = 0
  const { send, base } = await fixture(t, async (request, response) => {
    calls++
    assert.equal(request.headers.authorization, `Bearer ${key}`)
    assert.equal(request.headers['x-client-secret'], undefined)
    let text = ''
    for await (const chunk of request) text += chunk
    const body = JSON.parse(text)
    assert.deepEqual(body.thinking, { type: 'disabled' })
    assert.deepEqual(body.stream_options, { include_usage: true })
    assert.equal(body.max_tokens, 3072)
    assert.equal(body.base_url, undefined)
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    // Split a usage event across network chunks.
    response.write(events().slice(0, 200))
    setImmediate(() => response.end(events().slice(200)))
  })
  const health = await fetch(`${base}/healthz`)
  assert.deepEqual(await health.json(), { status: 'ok' })
  const response = await send(
    {
      ...payload,
      max_tokens: 1000000,
      thinking: { type: 'enabled' },
      base_url: 'https://invalid.example',
    },
    {
      Authorization: 'Bearer caller-secret',
      'X-Client-Secret': 'caller-secret',
    },
  )
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('x-accel-buffering'), 'no')
  assert.equal(await response.text(), events())
  assert.equal(calls, 1)
})

test('invalid models, oversized requests and provider errors never expose the server key', async (t) => {
  let calls = 0
  const { send } = await fixture(t, (_request, response) => {
    calls++
    response.writeHead(401, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ error: `private ${key}` }))
  })
  assert.equal(
    (await send({ ...payload, model: 'expensive-model' })).status,
    400,
  )
  assert.equal(
    (
      await send({
        ...payload,
        messages: [{ role: 'user', content: 'x'.repeat(270000) }],
      })
    ).status,
    413,
  )
  const response = await send()
  assert.equal(response.status, 502)
  assert.ok(!(await response.text()).includes(key))
  assert.equal(calls, 1)
})

test('per-client limits prevent provider calls and global quota survives a restart', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'pash-quota-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const database = join(directory, 'quota.sqlite')
  let calls = 0
  const handler = (_request, response) => {
    calls++
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    response.end(events(100))
  }
  const first = await fixture(t, handler, {
    database,
    limits: { dailyTokens: 1400, ipDailyTokens: 1400, ipRequestsPerMinute: 1 },
  })
  assert.equal(await (await first.send()).text(), events(100))
  const limited = await first.send()
  assert.equal(limited.status, 429)
  assert.equal(limited.headers.get('retry-after'), '60')
  await first.stop()
  const second = await fixture(t, handler, {
    database,
    limits: { dailyTokens: 1200, ipDailyTokens: 10000 },
  })
  const exhausted = await second.send(payload, {
    'X-Forwarded-For': '192.0.2.1',
  })
  assert.equal(exhausted.status, 429)
  assert.match((await exhausted.json()).error.message, /今日 AI 服务额度/)
  assert.equal(calls, 1)
})

test('disconnects abort the provider, release concurrency and retain unreported usage', async (t) => {
  let disconnected
  const closed = new Promise((resolve) => {
    disconnected = resolve
  })
  const { send } = await fixture(
    t,
    (_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.write('data: {"choices":[]}\n\n')
      response.once('close', disconnected)
    },
    { limits: { dailyTokens: 2000, ipDailyTokens: 2000 } },
  )
  const first = await send()
  assert.equal((await send()).status, 429)
  await first.body.cancel()
  await closed
  const second = await send()
  assert.equal(second.status, 429)
  assert.match((await second.json()).error.message, /今日 AI 服务额度/)
})
