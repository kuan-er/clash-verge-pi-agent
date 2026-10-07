import { once } from 'node:events'
import { mkdir } from 'node:fs/promises'
import { createServer } from 'node:http'
import { isIP } from 'node:net'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Quota } from './quota.mjs'

const MAX_BODY_BYTES = 256 * 1024
const defaults = {
  dailyTokens: 1000000,
  ipDailyTokens: 100000,
  requestsPerMinute: 120,
  ipRequestsPerMinute: 24,
  concurrent: 4,
  ipConcurrent: 1,
  timeoutMs: 60000,
}

function errorResponse(response, status, message, retryAfter) {
  if (response.destroyed) return
  if (response.headersSent) {
    response.destroy()
    return
  }
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...(retryAfter ? { 'Retry-After': String(retryAfter) } : {}),
  })
  response.end(
    JSON.stringify({ error: { message, type: 'pash_service_error' } }),
  )
}

async function readPayload(request) {
  const chunks = []
  let bytes = 0
  for await (const chunk of request) {
    bytes += chunk.length
    if (bytes > MAX_BODY_BYTES)
      throw Object.assign(
        new Error('AI 请求内容过大，请创建新对话或缩短输入。'),
        { status: 413 },
      )
    chunks.push(chunk)
  }
  let input
  try {
    input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw Object.assign(new Error('AI 请求格式无效。'), { status: 400 })
  }
  const validContent = (content) =>
    typeof content === 'string' ||
    content === null ||
    (Array.isArray(content) &&
      content.every(
        (part) => part?.type === 'text' && typeof part.text === 'string',
      ))
  if (
    input?.model !== 'deepseek-flash' ||
    input.stream !== true ||
    !Array.isArray(input.messages) ||
    !input.messages.length ||
    input.messages.length > 128 ||
    input.messages.some(
      (message) =>
        !['system', 'user', 'assistant', 'tool'].includes(message?.role) ||
        !validContent(message.content),
    ) ||
    (input.tools !== undefined &&
      (!Array.isArray(input.tools) ||
        input.tools.length > 32 ||
        input.tools.some((tool) => tool?.type !== 'function'))) ||
    (input.max_tokens !== undefined &&
      (!Number.isSafeInteger(input.max_tokens) || input.max_tokens < 1))
  ) {
    throw Object.assign(new Error('AI 请求不受此服务支持。'), { status: 400 })
  }
  const payload = {
    model: 'deepseek-flash',
    messages: input.messages,
    tools: input.tools,
    tool_choice: input.tool_choice,
    temperature: input.temperature,
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: Math.min(input.max_tokens || 3072, 3072),
    thinking: { type: 'disabled' },
  }
  return {
    body: JSON.stringify(payload),
    reserved: bytes + input.messages.length * 64 + 1024 + payload.max_tokens,
  }
}

function clientIp(request) {
  const remote = request.socket.remoteAddress || 'unknown'
  if (['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) {
    const forwarded = request.headers['x-forwarded-for']
    if (typeof forwarded === 'string' && isIP(forwarded)) return forwarded
  }
  return remote
}

export function createRelay({
  apiKey,
  database = ':memory:',
  limits = {},
  server = createServer(),
  upstream = 'https://api.deepseek.com/chat/completions',
}) {
  if (!apiKey || !/^sk-\S+$/.test(apiKey))
    throw new Error('Set a valid server-side DEEPSEEK_API_KEY.')
  limits = { ...defaults, ...limits }
  const quota = new Quota(database, limits)
  let active = 0
  const clients = new Map()
  const controllers = new Set()
  const tasks = new Set()

  server.requestTimeout = 15000
  server.headersTimeout = 10000
  const handle = async (request, response) => {
    if (request.method === 'GET' && request.url === '/healthz') {
      response.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      })
      response.end('{"status":"ok"}')
      return
    }
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      errorResponse(response, 404, '接口不存在。')
      return
    }
    const ip = clientIp(request)
    if (
      active >= limits.concurrent ||
      (clients.get(ip) || 0) >= limits.ipConcurrent
    ) {
      errorResponse(response, 429, 'AI 服务繁忙，请稍后再试。', 10)
      return
    }
    active++
    clients.set(ip, (clients.get(ip) || 0) + 1)
    const controller = new AbortController()
    controllers.add(controller)
    const cancel = () => controller.abort()
    response.once('close', cancel)
    const timeout = setTimeout(cancel, limits.timeoutMs)
    let settle
    let usage
    try {
      const { body, reserved } = await readPayload(request)
      if (controller.signal.aborted) return
      settle = quota.reserve(ip, reserved)
      const provider = await fetch(upstream, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body,
        signal: controller.signal,
        redirect: 'error',
      })
      if (!provider.ok) {
        await provider.body?.cancel()
        usage = 0
        const rateLimited = provider.status === 429
        errorResponse(
          response,
          rateLimited ? 429 : 502,
          rateLimited
            ? '模型服务繁忙，请稍后再试。'
            : '模型服务暂时不可用，请稍后再试。',
          rateLimited ? 30 : undefined,
        )
        return
      }
      if (
        !provider.body ||
        !provider.headers.get('content-type')?.includes('text/event-stream')
      ) {
        await provider.body?.cancel()
        throw new Error('Invalid provider stream')
      }
      response.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no',
      })
      response.flushHeaders()
      const decoder = new TextDecoder()
      let pending = ''
      for await (const chunk of provider.body) {
        pending += decoder.decode(chunk, { stream: true })
        const lines = pending.split('\n')
        pending = lines.pop()
        if (pending.length > MAX_BODY_BYTES)
          throw new Error('Provider event too large')
        for (const line of lines) {
          if (!line.startsWith('data:')) continue
          try {
            const event = JSON.parse(line.slice(5))
            if (
              Number.isSafeInteger(event.usage?.total_tokens) &&
              event.usage.total_tokens >= 0
            )
              usage = event.usage.total_tokens
          } catch {}
        }
        if (!response.write(chunk))
          await once(response, 'drain', { signal: controller.signal })
      }
      response.end()
    } catch (error) {
      errorResponse(
        response,
        error.status || 502,
        error.status ? error.message : 'AI 服务连接中断，请稍后再试。',
        error.retryAfter,
      )
    } finally {
      clearTimeout(timeout)
      response.removeListener('close', cancel)
      controllers.delete(controller)
      active--
      if ((clients.get(ip) || 0) <= 1) clients.delete(ip)
      else clients.set(ip, clients.get(ip) - 1)
      settle?.(usage)
    }
  }
  server.on('request', (request, response) => {
    const task = handle(request, response).catch(() => {
      errorResponse(response, 503, 'AI 服务暂时不可用，请稍后再试。')
    })
    tasks.add(task)
    void task.finally(() => tasks.delete(task))
  })

  return {
    server,
    async close() {
      for (const controller of controllers) controller.abort()
      const closed = new Promise((resolveClose, reject) =>
        server.close((error) => (error ? reject(error) : resolveClose())),
      )
      server.closeAllConnections()
      await closed
      await Promise.all(tasks)
      quota.close()
    },
  }
}

async function start() {
  const state = process.env.STATE_DIRECTORY || '/var/lib/pash-ai'
  const database = resolve(state, 'quota.sqlite')
  await mkdir(dirname(database), { recursive: true, mode: 0o700 })
  const limits = {}
  for (const [name, value] of Object.entries(defaults)) {
    const variable = `PASH_AI_${name.replace(/[A-Z]/g, (letter) => `_${letter}`).toUpperCase()}`
    limits[name] = Number(process.env[variable] || value)
    if (!Number.isSafeInteger(limits[name]) || limits[name] < 1)
      throw new Error(`Invalid ${variable}`)
  }
  const relay = createRelay({
    apiKey: process.env.DEEPSEEK_API_KEY,
    database,
    limits,
  })
  relay.server.listen(Number(process.env.PORT || 8787), '127.0.0.1', () =>
    console.log('pash AI relay ready on loopback'),
  )
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.once(signal, () => relay.close().then(() => process.exit(0)))
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  start().catch(() => {
    console.error(
      'pash AI relay failed to start; check the private server configuration and state directory.',
    )
    process.exitCode = 1
  })
}
