import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'

const packageJson = JSON.parse(await readFile('package.json', 'utf8'))
const version = packageJson.version
if (!/^\d+\.\d+\.\d+$/.test(version))
  throw new Error('Pi releases require a stable semver version.')

const [mode, input, output, arch] = process.argv.slice(2)
if (mode === 'collect') {
  if (!['aarch64', 'x86_64'].includes(arch))
    throw new Error('Unsupported macOS architecture.')
  await mkdir(output, { recursive: true })
  const files = (await readdir(input, { recursive: true })).map((name) =>
    path.join(input, name),
  )
  for (const extension of ['.dmg', '.app.tar.gz', '.app.tar.gz.sig']) {
    const matches = files.filter((name) => name.endsWith(extension))
    if (matches.length !== 1)
      throw new Error(
        `Expected one ${extension} artifact, found ${matches.length}.`,
      )
    await copyFile(
      matches[0],
      path.join(output, `pash_${version}_${arch}${extension}`),
    )
  }
} else if (mode === 'manifest') {
  const repository =
    process.env.GITHUB_REPOSITORY || 'kuan-er/clash-verge-pi-agent'
  const platforms = {}
  for (const architecture of ['aarch64', 'x86_64']) {
    const name = `pash_${version}_${architecture}.app.tar.gz`
    if (!(await stat(path.join(input, name))).size)
      throw new Error(`The ${architecture} archive is empty.`)
    const signature = (
      await readFile(path.join(input, `${name}.sig`), 'utf8')
    ).trim()
    const trustedComment = Buffer.from(signature, 'base64')
      .toString()
      .split('\n')
      .find((line) => line.startsWith('trusted comment:'))
    if (!trustedComment?.split(/\s+/).includes(`version:${version}`))
      throw new Error(
        `The ${architecture} signature must include version ${version}.`,
      )
    platforms[`darwin-${architecture}`] = {
      url: `https://github.com/${repository}/releases/download/pash-v${version}/${name}`,
      signature,
    }
    platforms[`darwin-${architecture}-app`] =
      platforms[`darwin-${architecture}`]
  }
  const changelog = await readFile('network-agent/CHANGELOG.md', 'utf8')
  const notes = changelog.split(/\n## /)[0].trim()
  if (!notes.startsWith(`## ${version}\n`))
    throw new Error('The changelog must start with the release version.')
  await writeFile(path.join(input, 'notes.md'), `${notes}\n`)
  await writeFile(
    path.join(input, 'latest.json'),
    `${JSON.stringify({ version, notes, pub_date: new Date().toISOString(), platforms }, null, 2)}\n`,
  )
  console.log(`Prepared signed update manifest for Pi ${version}.`)
} else {
  throw new Error(
    'Use collect <bundle directory> <output directory> <arch> or manifest <artifact directory>.',
  )
}
