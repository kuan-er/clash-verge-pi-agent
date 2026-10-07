import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { loadSettings } from './config.mjs'

test('hosted clients need no provider key and do not write one to disk', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'pash-settings-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const file = join(directory, 'network-agent.env')
  const settings = await loadSettings(file, {
    PASH_AI_BASE_URL: 'https://ai.example.com/v1',
  })
  assert.equal(settings.apiKey, 'pash-public')
  assert.equal(settings.baseUrl, 'https://ai.example.com/v1')
  await assert.rejects(stat(file), { code: 'ENOENT' })
  for (const url of [
    'http://ai.example.com/v1',
    'https://secret@ai.example.com/v1',
    'https://ai.example.com/v1?key=secret',
  ]) {
    await assert.rejects(
      loadSettings(file, { PASH_AI_BASE_URL: url }),
      /HTTPS endpoint/,
    )
  }
})

test('existing local keys retain direct DeepSeek access after hosted updates', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'pash-settings-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const file = join(directory, 'network-agent.env')
  await writeFile(file, 'DEEPSEEK_API_KEY=sk-local-test\n', { mode: 0o600 })
  const settings = await loadSettings(file, {
    PASH_AI_BASE_URL: 'https://ai.example.com/v1',
  })
  assert.equal(settings.apiKey, 'sk-local-test')
  assert.equal(settings.baseUrl, 'https://api.deepseek.com')
  assert.equal(await readFile(file, 'utf8'), 'DEEPSEEK_API_KEY=sk-local-test\n')
})
