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

const [mode, input, output, arch, platform = 'darwin'] = process.argv.slice(2)
if (mode === 'collect') {
  if (
    !['darwin', 'windows'].includes(platform) ||
    !['aarch64', 'x86_64'].includes(arch) ||
    (platform === 'windows' && arch !== 'x86_64')
  )
    throw new Error('Unsupported desktop target.')
  await mkdir(output, { recursive: true })
  const files = (await readdir(input, { recursive: true })).map((name) =>
    path.join(input, name),
  )
  const extensions =
    platform === 'windows'
      ? ['-setup.exe', '-setup.exe.sig']
      : ['.dmg', '.app.tar.gz', '.app.tar.gz.sig']
  for (const extension of extensions) {
    const matches = files.filter((name) => name.endsWith(extension))
    if (matches.length !== 1)
      throw new Error(
        `Expected one ${extension} artifact, found ${matches.length}.`,
      )
    await copyFile(
      matches[0],
      path.join(
        output,
        `pash_${version}_${platform === 'windows' ? 'windows_' : ''}${arch}${extension}`,
      ),
    )
  }
} else if (mode === 'manifest') {
  const repository =
    process.env.GITHUB_REPOSITORY || 'kuan-er/clash-verge-pi-agent'
  const platforms = {}
  for (const [platform, architecture, name, bundle] of [
    ['darwin', 'aarch64', `pash_${version}_aarch64.app.tar.gz`, 'app'],
    ['darwin', 'x86_64', `pash_${version}_x86_64.app.tar.gz`, 'app'],
    ['windows', 'x86_64', `pash_${version}_windows_x86_64-setup.exe`, 'nsis'],
  ]) {
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
    platforms[`${platform}-${architecture}`] = {
      url: `https://github.com/${repository}/releases/download/pash-v${version}/${name}`,
      signature,
    }
    platforms[`${platform}-${architecture}-${bundle}`] =
      platforms[`${platform}-${architecture}`]
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
    'Use collect <bundle directory> <output directory> <arch> [darwin|windows] or manifest <artifact directory>.',
  )
}
