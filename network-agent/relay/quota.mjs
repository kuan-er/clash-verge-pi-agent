import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

export class Quota {
  constructor(path, limits) {
    this.limits = limits
    this.db = new DatabaseSync(path)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS usage (
        day TEXT NOT NULL, client TEXT NOT NULL, tokens INTEGER NOT NULL,
        PRIMARY KEY (day, client)
      );
    `)
    this.get = this.db.prepare(
      'SELECT tokens FROM usage WHERE day = ? AND client = ?',
    )
    this.add = this.db.prepare(`INSERT INTO usage VALUES (?, ?, ?)
      ON CONFLICT(day, client) DO UPDATE SET tokens = MAX(0, tokens + excluded.tokens)`)
    this.prune = this.db.prepare('DELETE FROM usage WHERE day < ?')
    this.minute = -1
    this.requests = new Map()
  }

  reserve(ip, tokens, now = Date.now()) {
    const minute = Math.floor(now / 60000)
    const day = new Date(now).toISOString().slice(0, 10)
    const client = createHash('sha256').update(`${day}\0${ip}`).digest('hex')
    if (minute !== this.minute) {
      this.minute = minute
      this.requests.clear()
      this.prune.run(new Date(now - 2 * 86400000).toISOString().slice(0, 10))
    }
    const scopes = [
      ['global', this.limits.dailyTokens, this.limits.requestsPerMinute],
      [client, this.limits.ipDailyTokens, this.limits.ipRequestsPerMinute],
    ]
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const [scope, daily, rate] of scopes) {
        if ((this.requests.get(scope) || 0) >= rate) {
          throw Object.assign(new Error('AI 请求过于频繁，请稍后再试。'), {
            status: 429,
            retryAfter: 60,
          })
        }
        if ((this.get.get(day, scope)?.tokens || 0) + tokens > daily) {
          throw Object.assign(
            new Error(
              scope === 'global'
                ? '今日 AI 服务额度已用完，请明天再试。'
                : '当前网络今日 AI 额度已用完，请明天再试。',
            ),
            {
              status: 429,
              retryAfter: Math.ceil(
                (Date.parse(`${day}T00:00:00Z`) + 86400000 - now) / 1000,
              ),
            },
          )
        }
      }
      for (const [scope] of scopes) this.add.run(day, scope, tokens)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    for (const [scope] of scopes)
      this.requests.set(scope, (this.requests.get(scope) || 0) + 1)
    let settled = false
    return (actual) => {
      if (settled) return
      settled = true
      // Missing usage after a disconnect keeps the reservation charged across restarts.
      if (!Number.isSafeInteger(actual) || actual < 0) return
      this.db.exec('BEGIN IMMEDIATE')
      try {
        for (const [scope] of scopes) this.add.run(day, scope, actual - tokens)
        this.db.exec('COMMIT')
      } catch (error) {
        this.db.exec('ROLLBACK')
        throw error
      }
    }
  }

  close() {
    this.db.close()
  }
}
