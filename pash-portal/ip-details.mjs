import { isIP } from 'node:net'

const timestamp = () => Math.floor(Date.now() / 1000)
const emptyRates = { upload: 0, download: 0 }

export function mergeHistory(snapshot, history) {
  if (!history) return snapshot
  snapshot.ipTrackingStarted =
    history.ipTrackingStarted || snapshot.ipTrackingStarted
  for (const [id, stored] of Object.entries(history.users || {})) {
    const live = (snapshot.users[id] ||= {
      upload: 0,
      download: 0,
      ips: {},
      connections: 0,
      ipTraffic: {},
    })
    live.upload += stored.upload
    live.download += stored.download
    live.ipTraffic ||= {}
    for (const [ip, entry] of Object.entries(stored.ipTraffic || {})) {
      const current = live.ipTraffic[ip]
      live.ipTraffic[ip] = current
        ? {
            upload: current.upload + entry.upload,
            download: current.download + entry.download,
            firstSeen: Math.min(current.firstSeen, entry.firstSeen),
            lastSeen: Math.max(current.lastSeen, entry.lastSeen),
          }
        : entry
    }
  }
  return snapshot
}

export class IpDetails {
  constructor(db) {
    this.db = db
    this.previous = new Map()
    this.rates = new Map()
    this.locations = new Map()
    this.queue = new Set()
    this.busy = false
    db.exec(`CREATE TABLE IF NOT EXISTS user_ip_traffic (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, ip TEXT NOT NULL,
      upload INTEGER NOT NULL DEFAULT 0, download INTEGER NOT NULL DEFAULT 0,
      first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL,
      PRIMARY KEY(user_id,ip));
      CREATE TABLE IF NOT EXISTS ip_locations (ip TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER NOT NULL);`)
    this.timer = setInterval(() => this.lookup(), 1100)
    this.timer.unref()
  }

  record(snapshot, userIDs) {
    const previous = new Map()
    const rates = new Map()
    const insert =
      this.db.prepare(`INSERT INTO user_ip_traffic VALUES(?,?,?,?,?,?)
      ON CONFLICT(user_id,ip) DO UPDATE SET upload=MAX(upload,excluded.upload),
      download=MAX(download,excluded.download),first_seen=MIN(first_seen,excluded.first_seen),last_seen=MAX(last_seen,excluded.last_seen)`)
    for (const [id, user] of Object.entries(snapshot.users)) {
      if (!userIDs.has(id)) continue
      for (const [ip, entry] of Object.entries(user.ipTraffic || {})) {
        if (!isIP(ip)) continue
        insert.run(
          id,
          ip,
          entry.upload,
          entry.download,
          entry.firstSeen,
          entry.lastSeen,
        )
        const key = id + ':' + ip
        const last = this.previous.get(key)
        const seconds = last
          ? Math.max((snapshot.timestamp - last.at) / 1000, 0.1)
          : 1
        rates.set(
          key,
          last
            ? {
                upload: Math.max(0, entry.upload - last.upload) / seconds,
                download: Math.max(0, entry.download - last.download) / seconds,
              }
            : emptyRates,
        )
        previous.set(key, { ...entry, at: snapshot.timestamp })
      }
    }
    this.previous = previous
    this.rates = rates
  }

  location(ip) {
    if (!isIP(ip)) return { status: 'unknown' }
    if (
      /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.|::1$|::$|f[cd]|fe[89ab])/i.test(
        ip,
      )
    )
      return { status: 'local', country: '本地网络' }
    let saved = this.locations.get(ip)
    if (!saved) {
      const row = this.db
        .prepare('SELECT value,expires_at FROM ip_locations WHERE ip=?')
        .get(ip)
      if (row) {
        saved = { value: JSON.parse(row.value), expiresAt: row.expires_at }
        this.locations.set(ip, saved)
      }
    }
    if (!saved || saved.expiresAt <= timestamp()) this.queue.add(ip)
    return saved?.value || { status: 'pending' }
  }

  async lookup() {
    if (this.busy || !this.queue.size) return
    const day = String(Math.floor(timestamp() / 86400))
    const savedDay = this.db
      .prepare("SELECT value FROM settings WHERE key='geoip_day'")
      .get()?.value
    const count =
      savedDay === day
        ? Number(
            this.db
              .prepare("SELECT value FROM settings WHERE key='geoip_requests'")
              .get()?.value || 0,
          )
        : 0
    if (count >= 900) return
    this.busy = true
    const ip = this.queue.values().next().value
    this.queue.delete(ip)
    const putSetting = this.db.prepare(
      'INSERT OR REPLACE INTO settings VALUES(?,?)',
    )
    putSetting.run('geoip_day', day)
    putSetting.run('geoip_requests', String(count + 1))
    let value = { status: 'unknown' }
    try {
      const response = await fetch(
        `https://ipwho.is/${encodeURIComponent(ip)}?lang=zh-CN&fields=ip,success,country,country_code,region,city,connection`,
        { signal: AbortSignal.timeout(5000) },
      )
      if (!response.ok) throw new Error('Geolocation unavailable')
      const result = await response.json()
      if (!result.success || result.ip !== ip)
        throw new Error('Geolocation unavailable')
      value = {
        status: 'ready',
        country: result.country,
        countryCode: result.country_code,
        region: result.region,
        city: result.city,
        isp: result.connection?.isp,
        org: result.connection?.org,
        asn: result.connection?.asn,
      }
    } catch {}
    const expiresAt =
      timestamp() + (value.status === 'ready' ? 7 * 86400 : 3600)
    this.db
      .prepare('INSERT OR REPLACE INTO ip_locations VALUES(?,?,?)')
      .run(ip, JSON.stringify(value), expiresAt)
    this.locations.set(ip, { value, expiresAt })
    this.busy = false
  }

  forUser(user, snapshot) {
    const live = snapshot.users[user.id] || { ips: {} }
    const rows = new Map(
      this.db
        .prepare('SELECT * FROM user_ip_traffic WHERE user_id=?')
        .all(user.id)
        .map((row) => [row.ip, row]),
    )
    for (const ip of Object.keys(live.ips))
      if (!rows.has(ip)) rows.set(ip, { ip })
    return Array.from(rows.values(), (row) => ({
      ip: row.ip,
      location: this.location(row.ip),
      metered: row.upload !== undefined,
      upload: row.upload ?? null,
      download: row.download ?? null,
      total: row.upload === undefined ? null : row.upload + row.download,
      connections: live.ips[row.ip] || 0,
      rates: this.rates.get(user.id + ':' + row.ip) || emptyRates,
      firstSeen: row.first_seen ?? null,
      lastSeen: row.last_seen ?? null,
    })).sort(
      (a, b) =>
        b.connections - a.connections || (b.lastSeen || 0) - (a.lastSeen || 0),
    )
  }

  overview(users, snapshot) {
    const entries = new Map()
    const row = (ip) => {
      if (!entries.has(ip))
        entries.set(ip, {
          ip,
          location: this.location(ip),
          accounts: [],
          upload: 0,
          download: 0,
          metered: false,
          connections: snapshot.inboundIPs.all[ip] || 0,
          services: snapshot.inboundIPs.services?.[ip] || {},
          rates: { upload: 0, download: 0 },
          firstSeen: null,
          lastSeen: null,
        })
      return entries.get(ip)
    }
    for (const ip of Object.keys(snapshot.inboundIPs.all)) row(ip)
    for (const user of users)
      for (const entry of user.ipTraffic) {
        const target = row(entry.ip)
        target.accounts.push(user.username)
        target.metered ||= entry.metered
        target.upload += entry.upload || 0
        target.download += entry.download || 0
        target.rates.upload += entry.rates.upload
        target.rates.download += entry.rates.download
        target.connections = Math.max(target.connections, entry.connections)
        if (entry.firstSeen)
          target.firstSeen = Math.min(
            target.firstSeen || Infinity,
            entry.firstSeen,
          )
        target.lastSeen =
          Math.max(target.lastSeen || 0, entry.lastSeen || 0) || null
      }
    return Array.from(entries.values(), (entry) => ({
      ...entry,
      total: entry.metered ? entry.upload + entry.download : null,
    })).sort(
      (a, b) =>
        b.connections - a.connections || (b.lastSeen || 0) - (a.lastSeen || 0),
    )
  }
}
