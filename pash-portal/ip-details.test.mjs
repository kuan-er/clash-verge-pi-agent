import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { IpDetails, mergeHistory } from './ip-details.mjs'

function setup(t) {
  const db = new DatabaseSync(':memory:')
  db.exec(
    "PRAGMA foreign_keys=ON; CREATE TABLE users(id TEXT PRIMARY KEY); CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT); INSERT INTO users VALUES('alice'),('bob')",
  )
  const details = new IpDetails(db)
  t.after(() => {
    clearInterval(details.timer)
    db.close()
  })
  return { db, details }
}
const traffic = (upload, download) => ({
  upload,
  download,
  firstSeen: 100,
  lastSeen: 105,
})
const snapshot = (timestamp, users) => ({
  timestamp,
  users,
  inboundIPs: { all: { '8.8.8.8': 3 }, services: {} },
})

test('shared public IP aggregates accounts while personal rows remain isolated', (t) => {
  const { details } = setup(t)
  const live = snapshot(1000, {
    alice: {
      ips: { '8.8.8.8': 2 },
      ipTraffic: { '8.8.8.8': traffic(10, 100) },
    },
    bob: { ips: { '8.8.8.8': 1 }, ipTraffic: { '8.8.8.8': traffic(20, 200) } },
  })
  details.record(live, new Set(['alice', 'bob']))
  const users = ['alice', 'bob'].map((id) => ({
    id,
    username: id,
    ipTraffic: details.forUser({ id }, live),
  }))
  assert.equal(users[0].ipTraffic[0].total, 110)
  assert.equal(users[1].ipTraffic[0].total, 220)
  const rows = details.overview(users, live)
  assert.equal(rows.length, 1)
  assert.deepEqual(rows[0].accounts, ['alice', 'bob'])
  assert.equal(rows[0].total, 330)
  assert.equal(rows[0].connections, 3)
})

test('offline history survives counter recovery without negative rates or fabricated unmetered usage', (t) => {
  const { details } = setup(t)
  const first = snapshot(1000, {
    alice: {
      ips: { '8.8.8.8': 1 },
      ipTraffic: { '8.8.8.8': traffic(10, 100) },
    },
  })
  details.record(first, new Set(['alice']))
  const next = snapshot(3000, {
    alice: { ips: {}, ipTraffic: { '8.8.8.8': traffic(20, 300) } },
  })
  details.record(next, new Set(['alice']))
  assert.equal(details.forUser({ id: 'alice' }, next)[0].rates.download, 100)
  const restored = snapshot(5000, {
    alice: { ips: {}, ipTraffic: { '8.8.8.8': traffic(19, 299) } },
  })
  details.record(restored, new Set(['alice']))
  const row = details.forUser({ id: 'alice' }, restored)[0]
  assert.equal(row.connections, 0)
  assert.equal(row.total, 320)
  assert.equal(row.rates.download, 0)
  restored.inboundIPs.all['1.1.1.1'] = 1
  const unknown = details
    .overview([{ username: 'alice', ipTraffic: [row] }], restored)
    .find((entry) => entry.ip === '1.1.1.1')
  assert.equal(unknown.total, null)
})

test('upgrade preserves account history without assigning historical bytes to the new IP ledger', () => {
  const native = snapshot(1000, {
    alice: {
      upload: 2,
      download: 20,
      ips: {},
      connections: 0,
      ipTraffic: { '8.8.8.8': traffic(2, 20) },
    },
  })
  const result = mergeHistory(native, {
    ipTrackingStarted: 100,
    users: {
      alice: {
        upload: 1000,
        download: 10000,
        ipTraffic: { '8.8.8.8': traffic(3, 30) },
      },
    },
  })
  assert.equal(result.users.alice.download, 10020)
  assert.equal(result.users.alice.ipTraffic['8.8.8.8'].download, 50)
  assert.equal(result.ipTrackingStarted, 100)
})
