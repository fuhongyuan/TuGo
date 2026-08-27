import { createHash } from 'node:crypto'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = resolve(import.meta.dirname, '..')
const releaseDir = resolve(root, process.env.TUGO_RELEASE_DIR || 'release')
const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const releaseFiles = (await readdir(releaseDir)).filter(name => name.includes(`-${packageJson.version}`) && /\.(dmg|zip|exe)$/i.test(name)).sort()
if (!releaseFiles.length) throw new Error(`No DMG, ZIP or EXE found in ${releaseDir}. Build a release package first.`)

const checksums = []
for (const name of releaseFiles) {
  const bytes = await readFile(join(releaseDir, name))
  checksums.push(`${createHash('sha256').update(bytes).digest('hex')}  ${name}`)
}
await writeFile(join(releaseDir, `TuGo-${packageJson.version}-SHA256SUMS.txt`), `${checksums.join('\n')}\n`, 'utf8')

const command = process.platform === 'win32' ? 'npm.cmd' : 'npm'
// Frontend libraries are build-time npm dependencies but their code is bundled
// into dist-web. A release SBOM must therefore include both prod and dev trees.
const sbom = spawnSync(command, ['sbom', '--sbom-format', 'cyclonedx'], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
if (sbom.status !== 0 || !sbom.stdout.trim()) throw new Error(`SBOM generation failed: ${sbom.stderr || `exit ${sbom.status}`}`)
await writeFile(join(releaseDir, `TuGo-${packageJson.version}-sbom.cdx.json`), sbom.stdout, 'utf8')

const dependencies = spawnSync(command, ['ls', '--all', '--json'], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
if (!dependencies.stdout.trim()) throw new Error(`Dependency manifest generation failed: ${dependencies.stderr || `exit ${dependencies.status}`}`)
await writeFile(join(releaseDir, `TuGo-${packageJson.version}-dependencies.json`), dependencies.stdout, 'utf8')

process.stdout.write(`${JSON.stringify({ version: packageJson.version, packages: releaseFiles, checksums: checksums.length, sbom: true, dependencies: true }, null, 2)}\n`)
