import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import AdmZip from 'adm-zip'

const target = process.argv[2]
const architectures = {
  'aarch64-apple-darwin': { platform: 'darwin', arch: 'arm64' },
  'x86_64-apple-darwin': { platform: 'darwin', arch: 'x64' },
  'x86_64-pc-windows-msvc': { platform: 'win', arch: 'x64' },
}
const architecture = architectures[target]
if (!architecture) throw new Error('Provide a supported desktop target triple.')
const { platform, arch } = architecture
const windows = platform === 'win'

const version = 'v24.21.0'
const name = `node-${version}-${platform}-${arch}`
const archiveName = `${name}.${windows ? 'zip' : 'tar.gz'}`
const baseUrl = `https://nodejs.org/dist/${version}`
const download = async (url) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(120000) })
  if (!response.ok)
    throw new Error(`Download failed: ${response.status} ${url}`)
  return Buffer.from(await response.arrayBuffer())
}
const checksums = (await download(`${baseUrl}/SHASUMS256.txt`)).toString()
const expected = checksums
  .split('\n')
  .find((line) => line.trim().endsWith(` ${archiveName}`))
  ?.split(/\s+/)[0]
if (!expected)
  throw new Error('Node archive is missing from its checksum manifest.')

const cache = path.resolve('node_modules/.verge', archiveName)
let archive
try {
  archive = await readFile(cache)
} catch (error) {
  if (error.code !== 'ENOENT') throw error
}
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
if (!archive || hash(archive) !== expected) {
  archive = await download(`${baseUrl}/${archiveName}`)
  if (hash(archive) !== expected)
    throw new Error('Node archive checksum does not match.')
  await mkdir(path.dirname(cache), { recursive: true })
  await writeFile(cache, archive)
}

const temporary = await mkdtemp(path.join(tmpdir(), 'pi-node-runtime-'))
try {
  if (windows) {
    new AdmZip(cache).extractAllTo(temporary)
  } else {
    execFileSync('tar', [
      '-xzf',
      cache,
      '-C',
      temporary,
      `${name}/bin/node`,
      `${name}/LICENSE`,
    ])
  }
  await mkdir('src-tauri/sidecar', { recursive: true })
  await mkdir('src-tauri/resources', { recursive: true })
  const output = `src-tauri/sidecar/network-agent-node-${target}${windows ? '.exe' : ''}`
  await copyFile(
    path.join(temporary, name, windows ? 'node.exe' : 'bin/node'),
    output,
  )
  await chmod(output, 0o755)
  await copyFile(
    path.join(temporary, name, 'LICENSE'),
    'src-tauri/resources/network-agent-node-LICENSE.txt',
  )
  console.log(`Prepared verified Node ${version} for ${target}.`)
} finally {
  await rm(temporary, { recursive: true, force: true })
}
