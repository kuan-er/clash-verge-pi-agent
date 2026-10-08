import { createServer, request as httpRequest } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import {
  randomBytes,
  randomUUID,
  createHmac,
  createHash,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto'
import {
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  chmodSync,
  existsSync,
  createReadStream,
  statSync,
} from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const scrypt = promisify(scryptCallback)
const directory = dirname(fileURLToPath(import.meta.url))
const state = process.env.PASH_STATE_DIR || join(directory, '.state')
const base = new URL(
  process.env.PASH_PUBLIC_URL || 'https://154.40.137.121:8443',
)
const proxyPort = Number(process.env.PASH_PROXY_PORT || 4443)
const certFingerprint = process.env.PASH_CERT_FINGERPRINT
const master = process.env.PASH_MASTER_KEY
if (!master || master.length < 48 || !certFingerprint)
  throw new Error(
    'Configure private master key and proxy certificate fingerprint.',
  )
mkdirSync(state, { recursive: true, mode: 0o700 })
const db = new DatabaseSync(join(state, 'portal.sqlite'))
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS users (
 id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
 role TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 1,
 upload INTEGER NOT NULL DEFAULT 0, download INTEGER NOT NULL DEFAULT 0,
 last_login INTEGER, last_ip TEXT
);
CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, actor TEXT, action TEXT NOT NULL, subject TEXT);
CREATE TABLE IF NOT EXISTS samples (at INTEGER PRIMARY KEY, upload INTEGER NOT NULL, download INTEGER NOT NULL, server_rx INTEGER NOT NULL, server_tx INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`)
chmodSync(join(state, 'portal.sqlite'), 0o600)

const now = () => Math.floor(Date.now() / 1000)
const hash = (value) => createHash('sha256').update(value).digest('hex')
const credential = (purpose, user) =>
  createHmac('sha256', master)
    .update(`${purpose}:${user.id}:${user.revision}`)
    .digest('base64url')
const active = (user) =>
  Boolean(user.enabled) && (!user.expires_at || user.expires_at > now())
const allUsers = () =>
  db.prepare('SELECT * FROM users ORDER BY created_at, username').all()
function audit(actor, action, subject = '') {
  db.prepare(
    'INSERT INTO events(at, actor, action, subject) VALUES(?,?,?,?)',
  ).run(now(), actor, action, subject)
}
async function passwordHash(password) {
  const salt = randomBytes(16).toString('hex')
  const derived = await scrypt(password, salt, 64, {
    N: 32768,
    maxmem: 64 * 1024 * 1024,
  })
  return `${salt}:${derived.toString('hex')}`
}
async function passwordMatches(password, encoded) {
  const [salt, digest] = encoded.split(':')
  const actual = await scrypt(password, salt, 64, {
    N: 32768,
    maxmem: 64 * 1024 * 1024,
  })
  const expected = Buffer.from(digest, 'hex')
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}
function atomicWrite(path, value) {
  writeFileSync(path + '.tmp', value, { mode: 0o600 })
  renameSync(path + '.tmp', path)
}
function nodeRequest(path, method = 'GET', value) {
  return new Promise((resolve, reject) => {
    const body = value === undefined ? undefined : JSON.stringify(value)
    const request = httpRequest(
      {
        socketPath: join(state, 'node.sock'),
        path,
        method,
        headers: { 'Content-Type': 'application/json' },
        timeout: 5000,
      },
      (response) => {
        let text = ''
        response.on('data', (data) => {
          text += data
          if (text.length > 8 * 1024 * 1024)
            request.destroy(new Error('Node response too large'))
        })
        response.on('end', () => {
          if (response.statusCode >= 300)
            return reject(new Error('Managed node rejected configuration'))
          try {
            resolve(text ? JSON.parse(text) : null)
          } catch (error) {
            reject(error)
          }
        })
      },
    )
    request.on('timeout', () =>
      request.destroy(new Error('Managed node timeout')),
    )
    request.on('error', reject)
    request.end(body)
  })
}
let synced = false
async function syncUsers() {
  const users = allUsers().map((user) => ({
    id: user.id,
    password: credential('proxy', user),
    enabled: Boolean(user.enabled),
    expiresAt: user.expires_at,
  }))
  atomicWrite(join(state, 'node-users.json'), JSON.stringify(users))
  await nodeRequest('/users', 'PUT', users)
  synced = true
}

if (!db.prepare('SELECT COUNT(*) AS count FROM users').get().count) {
  const password =
    process.env.PASH_ADMIN_PASSWORD || randomBytes(18).toString('base64url')
  const username = process.env.PASH_ADMIN_USERNAME || 'admin'
  db.prepare(
    'INSERT INTO users(id,username,password_hash,role,created_at) VALUES(?,?,?,?,?)',
  ).run(randomUUID(), username, await passwordHash(password), 'admin', now())
  atomicWrite(
    join(state, 'initial-admin.json'),
    JSON.stringify({ username, password, url: base.href }, null, 2),
  )
  audit('system', 'bootstrap', username)
}

let telemetry = {
  users: {},
  onlineIPs: 0,
  serverNetwork: { received: 0, sent: 0 },
  inboundIPs: { all: {}, proxy: {} },
  timestamp: 0,
}
let previous = null
let rates = { upload: 0, download: 0, received: 0, sent: 0 }
let nodeHealthy = false
let sampling = false
let lastSync = 0
let lastSample = 0
const monitorStarted = db
  .prepare("SELECT value FROM settings WHERE key='monitor_started'")
  .get()
if (!monitorStarted)
  db.prepare('INSERT INTO settings VALUES(?,?)').run(
    'monitor_started',
    String(now()),
  )
async function collect() {
  if (sampling) return
  sampling = true
  try {
    const snapshot = await nodeRequest('/metrics')
    let upload = 0,
      download = 0
    const persist = db.prepare(
      'UPDATE users SET upload=MAX(upload,?), download=MAX(download,?) WHERE id=?',
    )
    db.exec('BEGIN')
    try {
      for (const [id, data] of Object.entries(snapshot.users))
        persist.run(data.upload, data.download, id)
      const totals = db
        .prepare(
          'SELECT SUM(upload) AS upload,SUM(download) AS download FROM users',
        )
        .get()
      upload = totals.upload || 0
      download = totals.download || 0
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    const current = {
      at: Date.now(),
      upload,
      download,
      received: snapshot.serverNetwork.received,
      sent: snapshot.serverNetwork.sent,
    }
    if (previous) {
      const seconds = Math.max((current.at - previous.at) / 1000, 0.1)
      rates = Object.fromEntries(
        ['upload', 'download', 'received', 'sent'].map((key) => [
          key,
          Math.max(0, current[key] - previous[key]) / seconds,
        ]),
      )
    }
    previous = current
    telemetry = snapshot
    nodeHealthy = true
    if (current.at - lastSample > 10000) {
      db.prepare('INSERT OR REPLACE INTO samples VALUES(?,?,?,?,?)').run(
        now(),
        upload,
        download,
        current.received,
        current.sent,
      )
      db.prepare('DELETE FROM samples WHERE at<?').run(now() - 7 * 86400)
      lastSample = current.at
    }
    if (!synced || current.at - lastSync > 30000) {
      await syncUsers()
      lastSync = current.at
    }
  } catch {
    nodeHealthy = false
  } finally {
    sampling = false
  }
}
await syncUsers()
await collect()
const interval = setInterval(collect, 1000)
interval.unref()

const attempts = new Map()
function rateLimit(ip, username) {
  const key = `${ip}:${username}`
  const global = `${ip}:*`
  for (const [k, limit] of [
    [key, 8],
    [global, 30],
  ]) {
    let record = attempts.get(k)
    if (!record || record.until < Date.now()) {
      record = { count: 0, until: Date.now() + 60000 }
      attempts.set(k, record)
    }
    if (++record.count > limit)
      throw Object.assign(new Error('尝试次数较多，请稍后再试'), {
        status: 429,
      })
  }
  if (attempts.size > 10000)
    for (const [key, record] of attempts)
      if (record.until < Date.now()) attempts.delete(key)
}
function clientIP(request) {
  const forwarded = request.headers['x-forwarded-for']
  return typeof forwarded === 'string' && forwarded.length < 100
    ? forwarded.split(',')[0].trim()
    : request.socket.remoteAddress
}
function getSession(request) {
  const bearer = request.headers.authorization?.match(
    /^Bearer ([a-zA-Z0-9_-]{43})$/,
  )?.[1]
  const cookie = request.headers.cookie?.match(
    /(?:^|;\s*)pash_session=([a-zA-Z0-9_-]{43})(?:;|$)/,
  )?.[1]
  const token = bearer || cookie
  if (!token) return null
  const record = db
    .prepare(
      'SELECT users.*,sessions.hash AS session_hash FROM sessions JOIN users ON users.id=sessions.user_id WHERE sessions.hash=? AND sessions.expires_at>?',
    )
    .get(hash(token), now())
  return record && active(record) ? record : null
}
async function bodyJSON(request) {
  let body = ''
  for await (const chunk of request) {
    body += chunk
    if (body.length > 16384)
      throw Object.assign(new Error('请求过大'), { status: 413 })
  }
  try {
    return JSON.parse(body)
  } catch {
    throw Object.assign(new Error('请求格式有误'), { status: 400 })
  }
}
function send(response, status, value) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  response.end(JSON.stringify(value))
}
function expose(user) {
  const live = telemetry.users[user.id] || { ips: {}, connections: 0 }
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    enabled: Boolean(user.enabled),
    active: active(user),
    expiresAt: user.expires_at,
    createdAt: user.created_at,
    upload: user.upload,
    download: user.download,
    total: user.upload + user.download,
    onlineIPs: Object.keys(live.ips),
    connections: live.connections,
    lastLogin: user.last_login,
    lastIP: user.last_ip,
  }
}
function subscriptionURL(user) {
  const url = new URL('/subscription.yaml', base)
  url.searchParams.set('id', user.id)
  url.searchParams.set('token', credential('subscription', user))
  return url.href
}
function profileYAML(user) {
  const node = {
    name: '美国直连',
    type: 'anytls',
    server: base.hostname,
    port: proxyPort,
    password: credential('proxy', user),
    sni: base.hostname,
    'skip-cert-verify': false,
    fingerprint: certFingerprint,
    udp: true,
  }
  const lines = [
    '# pash managed profile',
    'mode: rule',
    'ipv6: false',
    'proxies:',
    '  - ' + JSON.stringify(node),
    'proxy-groups:',
    '  - ' +
      JSON.stringify({
        name: 'pash 美国',
        type: 'select',
        proxies: ['美国直连'],
        url: new URL('/204', base).href,
        'expected-status': 204,
      }),
    'rules:',
    '  - IP-CIDR,127.0.0.0/8,DIRECT,no-resolve',
    '  - IP-CIDR,10.0.0.0/8,DIRECT,no-resolve',
    '  - IP-CIDR,172.16.0.0/12,DIRECT,no-resolve',
    '  - IP-CIDR,192.168.0.0/16,DIRECT,no-resolve',
    '  - MATCH,pash 美国',
    '',
  ]
  return lines.join('\n')
}
const assetDir = process.env.PASH_DOWNLOAD_DIR || join(state, 'downloads')
let release = null
function getRelease() {
  try {
    release = JSON.parse(readFileSync(join(assetDir, 'release.json'), 'utf8'))
  } catch {
    /* Installation assets are deployed separately. */
  }
  return release
}

const server = createServer(async (request, response) => {
  response.setHeader('X-Content-Type-Options', 'nosniff')
  response.setHeader('Referrer-Policy', 'no-referrer')
  response.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
  )
  try {
    const url = new URL(request.url, base)
    if (!['GET', 'HEAD', 'POST', 'PATCH'].includes(request.method))
      return send(response, 405, { error: '不支持此请求' })
    if (
      request.method !== 'GET' &&
      request.method !== 'HEAD' &&
      request.headers.origin &&
      request.headers.origin !== base.origin
    )
      return send(response, 403, { error: '请求来源不符' })
    if (url.pathname === '/portal-health')
      return send(response, nodeHealthy ? 200 : 503, {
        ok: nodeHealthy,
        synced,
      })
    if (url.pathname === '/api/login' || url.pathname === '/api/client/login') {
      if (request.method !== 'POST')
        return send(response, 405, { error: '请使用登录表单' })
      const body = await bodyJSON(request)
      const username =
        typeof body.username === 'string' ? body.username.trim() : ''
      const password = typeof body.password === 'string' ? body.password : ''
      if (username.length > 64 || password.length > 256)
        return send(response, 400, { error: '用户名或密码格式有误' })
      rateLimit(clientIP(request), username)
      const user = db
        .prepare('SELECT * FROM users WHERE username=?')
        .get(username)
      const dummy = '00000000000000000000000000000000:' + '0'.repeat(128)
      const matches = await passwordMatches(
        password,
        user?.password_hash || dummy,
      )
      if (!user || !matches || !active(user))
        return send(response, 401, {
          error: '用户名或密码有误，或账户已停用、到期',
        })
      const token = randomBytes(32).toString('base64url')
      db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(
        hash(token),
        user.id,
        now() + 7 * 86400,
      )
      db.prepare('UPDATE users SET last_login=?,last_ip=? WHERE id=?').run(
        now(),
        clientIP(request),
        user.id,
      )
      response.setHeader(
        'Set-Cookie',
        `pash_session=${token}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=604800`,
      )
      audit(user.username, 'login')
      return send(response, 200, {
        user: expose(user),
        subscriptionUrl: subscriptionURL(user),
        ...(url.pathname === '/api/client/login'
          ? { sessionToken: token }
          : {}),
      })
    }
    if (url.pathname === '/subscription.yaml') {
      const user = db
        .prepare('SELECT * FROM users WHERE id=?')
        .get(url.searchParams.get('id') || '')
      const expected = user ? credential('subscription', user) : ''
      const supplied = url.searchParams.get('token') || ''
      if (
        !user ||
        !active(user) ||
        supplied.length !== expected.length ||
        !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
      )
        return send(response, 403, { error: '配置链接不可用' })
      if (!synced || !nodeHealthy)
        return send(response, 503, { error: '代理服务暂不可用' })
      response.writeHead(200, {
        'Content-Type': 'text/yaml; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Disposition': 'attachment; filename="pash-us.yaml"',
        'subscription-userinfo': `upload=${user.upload}; download=${user.download}; total=0; expire=${user.expires_at}`,
        'profile-update-interval': '24',
        'profile-title':
          'base64:' +
          Buffer.from('pash 美国 · ' + user.username).toString('base64'),
      })
      response.end(profileYAML(user))
      return
    }
    const user = getSession(request)
    if (
      url.pathname.startsWith('/api/') ||
      url.pathname.startsWith('/download/')
    ) {
      if (!user) return send(response, 401, { error: '请先登录' })
      if (url.pathname === '/api/me')
        return send(response, 200, {
          user: expose(user),
          subscriptionUrl: subscriptionURL(user),
          activationUrl:
            'pash://activate?url=' + encodeURIComponent(subscriptionURL(user)),
          release: getRelease(),
          nodeHealthy,
        })
      if (url.pathname === '/api/logout' && request.method === 'POST') {
        db.prepare('DELETE FROM sessions WHERE hash=?').run(user.session_hash)
        response.setHeader(
          'Set-Cookie',
          'pash_session=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0',
        )
        return send(response, 200, { ok: true })
      }
      if (url.pathname === '/api/password' && request.method === 'POST') {
        const body = await bodyJSON(request)
        if (
          typeof body.currentPassword !== 'string' ||
          !(await passwordMatches(body.currentPassword, user.password_hash))
        )
          return send(response, 400, { error: '当前密码有误' })
        if (
          typeof body.password !== 'string' ||
          body.password.length < 10 ||
          body.password.length > 256
        )
          return send(response, 400, { error: '新密码至少需要 10 个字符' })
        db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(
          await passwordHash(body.password),
          user.id,
        )
        db.prepare('DELETE FROM sessions WHERE user_id=? AND hash<>?').run(
          user.id,
          user.session_hash,
        )
        audit(user.username, 'password-change')
        return send(response, 200, { ok: true })
      }
      if (url.pathname.startsWith('/download/')) {
        const current = getRelease()
        const arch = url.pathname.slice('/download/'.length)
        const file = current?.assets?.[arch]
        if (
          !['aarch64', 'x86_64', 'windows-x86_64'].includes(arch) ||
          !file ||
          !(
            arch === 'windows-x86_64'
              ? /^[a-zA-Z0-9_.-]+-setup\.exe$/
              : /^[a-zA-Z0-9_.-]+\.dmg$/
          ).test(file)
        )
          return send(response, 404, { error: '安装包尚未就绪' })
        const path = join(assetDir, file)
        if (!existsSync(path))
          return send(response, 503, { error: '安装包暂不可用' })
        audit(user.username, 'download', arch)
        response.writeHead(200, {
          'Content-Type':
            arch === 'windows-x86_64'
              ? 'application/octet-stream'
              : 'application/x-apple-diskimage',
          'Content-Length': statSync(path).size,
          'Content-Disposition': `attachment; filename="${file}"`,
          'Cache-Control': 'private, no-store',
        })
        if (request.method === 'HEAD') return response.end()
        const stream = createReadStream(path)
        response.on('close', () => stream.destroy())
        stream.on('error', () => response.destroy())
        stream.pipe(response)
        return
      }
      if (url.pathname.startsWith('/api/admin/')) {
        if (user.role !== 'admin')
          return send(response, 403, { error: '需要管理员权限' })
        if (url.pathname === '/api/admin/overview') {
          const users = allUsers().map(expose)
          const uploads = users.reduce((a, u) => a + u.upload, 0),
            downloads = users.reduce((a, u) => a + u.download, 0)
          const samples = db
            .prepare('SELECT * FROM samples WHERE at>? ORDER BY at')
            .all(now() - 3600)
          return send(response, 200, {
            accounts: users.length,
            activeAccounts: users.filter((u) => u.active).length,
            onlineAccounts: users.filter((u) => u.onlineIPs.length).length,
            managedOnlineIPs: telemetry.onlineIPs,
            proxyOnlineIPs: Object.keys(telemetry.inboundIPs.proxy).length,
            inboundOnlineIPs: Object.keys(telemetry.inboundIPs.all).length,
            managedTraffic: {
              upload: uploads,
              download: downloads,
              total: uploads + downloads,
            },
            serverNetwork: telemetry.serverNetwork,
            rates,
            nodeHealthy,
            sampledAt: telemetry.timestamp,
            monitorStarted: Number(
              db
                .prepare(
                  "SELECT value FROM settings WHERE key='monitor_started'",
                )
                .get().value,
            ),
            users,
            samples,
            inboundIPs: telemetry.inboundIPs,
            events: db
              .prepare('SELECT * FROM events ORDER BY id DESC LIMIT 20')
              .all(),
          })
        }
        if (url.pathname === '/api/admin/users' && request.method === 'POST') {
          const body = await bodyJSON(request)
          const username =
            typeof body.username === 'string' ? body.username.trim() : ''
          if (!/^[a-zA-Z0-9_\-.]{3,40}$/.test(username))
            return send(response, 400, {
              error: '用户名使用 3–40 位字母、数字或 _.-',
            })
          if (db.prepare('SELECT id FROM users WHERE username=?').get(username))
            return send(response, 409, { error: '用户名已存在' })
          const password =
            body.password || randomBytes(15).toString('base64url')
          if (
            typeof password !== 'string' ||
            password.length < 10 ||
            password.length > 256
          )
            return send(response, 400, { error: '密码至少需要 10 个字符' })
          const expires = Number(body.expiresAt || 0)
          if (!Number.isSafeInteger(expires) || expires < 0)
            return send(response, 400, { error: '到期时间有误' })
          const id = randomUUID()
          db.prepare(
            'INSERT INTO users(id,username,password_hash,role,created_at,expires_at) VALUES(?,?,?,?,?,?)',
          ).run(
            id,
            username,
            await passwordHash(password),
            body.role === 'admin' ? 'admin' : 'user',
            now(),
            expires,
          )
          synced = false
          await syncUsers()
          audit(user.username, 'create-user', username)
          return send(response, 201, {
            user: expose(db.prepare('SELECT * FROM users WHERE id=?').get(id)),
            password,
          })
        }
        const match = url.pathname.match(
          /^\/api\/admin\/users\/([a-f0-9-]{36})$/,
        )
        if (match && request.method === 'PATCH') {
          const target = db
            .prepare('SELECT * FROM users WHERE id=?')
            .get(match[1])
          if (!target) return send(response, 404, { error: '账户不存在' })
          const body = await bodyJSON(request)
          if (target.id === user.id && body.enabled === false)
            return send(response, 400, { error: '不能停用当前管理员账户' })
          const enabled =
            typeof body.enabled === 'boolean'
              ? Number(body.enabled)
              : target.enabled
          const expires =
            body.expiresAt === undefined
              ? target.expires_at
              : Number(body.expiresAt)
          if (!Number.isSafeInteger(expires) || expires < 0)
            return send(response, 400, { error: '到期时间有误' })
          if (
            target.role === 'admin' &&
            !enabled &&
            allUsers().filter((u) => u.role === 'admin' && active(u)).length < 2
          )
            return send(response, 400, { error: '至少保留一个可用管理员' })
          let password = null
          if (body.resetPassword) {
            password = randomBytes(15).toString('base64url')
            db.prepare(
              'UPDATE users SET password_hash=?,revision=revision+1 WHERE id=?',
            ).run(await passwordHash(password), target.id)
          }
          db.prepare('UPDATE users SET enabled=?,expires_at=? WHERE id=?').run(
            enabled,
            expires,
            target.id,
          )
          if (!enabled || password)
            db.prepare('DELETE FROM sessions WHERE user_id=?').run(target.id)
          synced = false
          await syncUsers()
          audit(
            user.username,
            password ? 'reset-user' : 'update-user',
            target.username,
          )
          return send(response, 200, {
            user: expose(
              db.prepare('SELECT * FROM users WHERE id=?').get(target.id),
            ),
            ...(password ? { password } : {}),
          })
        }
      }
      return send(response, 404, { error: '页面不存在' })
    }
    const files = {
      '/': ['index.html', 'text/html'],
      '/app.js': ['app.js', 'text/javascript'],
      '/style.css': ['style.css', 'text/css'],
    }
    const file = files[url.pathname]
    if (!file) return send(response, 404, { error: '页面不存在' })
    response.writeHead(200, {
      'Content-Type': file[1] + '; charset=utf-8',
      'Cache-Control': 'no-cache',
    })
    if (request.method === 'HEAD') response.end()
    else response.end(readFileSync(join(directory, 'public', file[0])))
  } catch (error) {
    const status = error.status || 503
    send(response, status, {
      error: status === 503 ? '服务暂不可用，请稍后重试' : error.message,
    })
    if (status === 503)
      console.error('Portal request failed:', error.code || error.name)
  }
})
server.requestTimeout = 20000
server.headersTimeout = 10000
server.listen(Number(process.env.PASH_PORTAL_PORT || 8788), '127.0.0.1', () =>
  console.log('pash portal ready'),
)
for (const signal of ['SIGTERM', 'SIGINT'])
  process.on(signal, () => {
    clearInterval(interval)
    server.close(() => {
      db.close()
      process.exit(0)
    })
  })
