import { readdir, readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = resolve(import.meta.dirname, '..')
const releaseDir = resolve(root, process.env.TUGO_RELEASE_DIR || 'release')
const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const appDir = process.env.TUGO_APP_DIR
  ? resolve(root, process.env.TUGO_APP_DIR)
  : join(releaseDir, 'mac-arm64', `${packageJson.build?.productName || 'TuGo'}.app`)
const asarPath = join(appDir, 'Contents', 'Resources', 'app.asar')
await stat(asarPath)

const asarCli = join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'asar.cmd' : 'asar')
const listed = spawnSync(asarCli, ['list', asarPath], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
if (listed.status !== 0) throw new Error(`Unable to inspect app.asar: ${listed.stderr || `exit ${listed.status}`}`)
const entries = listed.stdout.split(/\r?\n/).filter(Boolean)

const forbidden = [
  { label: 'Python bytecode/source', pattern: /(?:^|\/)(?:[^/]+\.py[co]?|__pycache__)(?:$|\/)/i },
  { label: 'DeerFlow', pattern: /deer[-_]?flow/i },
  { label: 'LangChain', pattern: /langchain/i },
  { label: 'LangGraph', pattern: /langgraph/i },
  { label: 'MCP CommonJS duplicate', pattern: /^\/node_modules\/@modelcontextprotocol\/sdk\/dist\/cjs(?:\/|$)/ },
  { label: 'MCP server implementation', pattern: /^\/node_modules\/@modelcontextprotocol\/sdk\/dist\/esm\/server\/auth\/(?!errors\.js$)|^\/node_modules\/@modelcontextprotocol\/sdk\/dist\/esm\/server\/middleware(?:\/|$)|^\/node_modules\/@modelcontextprotocol\/sdk\/dist\/esm\/server\/(?:completable|express|index|mcp|sse|sseKeepAlive|stdio|streamableHttp|webStandardStreamableHttp)\.js$/ },
  { label: 'MCP experimental server implementation', pattern: /^\/node_modules\/@modelcontextprotocol\/sdk\/dist\/esm\/experimental\/tasks\/(?:mcp-server|server)\.js$|^\/node_modules\/@modelcontextprotocol\/sdk\/dist\/esm\/experimental\/tasks\/stores(?:\/|$)/ },
  { label: 'source map', pattern: /\.map$/i },
  { label: 'test/example source', pattern: /(?:^|\/)(?:test|tests|__tests__|examples)(?:\/|$)/i },
]

const violations = forbidden.flatMap(rule => entries.filter(entry => rule.pattern.test(entry)).map(entry => `${rule.label}: ${entry}`))
if (violations.length) throw new Error(`Release package contains forbidden files:\n${violations.slice(0, 100).join('\n')}`)

if (process.platform === 'darwin') {
  const signature = spawnSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', appDir], { encoding: 'utf8' })
  if (signature.status !== 0) throw new Error(`Invalid macOS application signature: ${signature.stderr || signature.stdout}`)
}

const fuseCli = join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'electron-fuses.cmd' : 'electron-fuses')
const fuses = spawnSync(fuseCli, ['read', '--app', appDir], { cwd: root, encoding: 'utf8' })
if (fuses.status !== 0) throw new Error(`Unable to verify Electron fuses: ${fuses.stderr || fuses.stdout}`)
for (const expected of [
  'RunAsNode is Disabled',
  'EnableNodeOptionsEnvironmentVariable is Disabled',
  'EnableNodeCliInspectArguments is Disabled',
  'EnableEmbeddedAsarIntegrityValidation is Enabled',
  'OnlyLoadAppFromAsar is Enabled',
]) {
  if (!fuses.stdout.includes(expected)) throw new Error(`Unsafe Electron fuse configuration: expected "${expected}"`)
}

const imageSize = entries.filter(entry => /\/node_modules\/image-size(?:\/|$)/.test(entry))
const nativeCanvas = entries.filter(entry => /\/node_modules\/@napi-rs\/canvas(?:-|\/|$)/.test(entry))
const packages = (await readdir(releaseDir)).filter(name => /\.(?:dmg|zip|exe)$/i.test(name)).sort()
process.stdout.write(`${JSON.stringify({ appDir, asarEntries: entries.length, packages, fuses: 'verified', exceptions: {
  imageSize: imageSize.length ? 'bundled by PptxGenJS; browser bundle does not execute the Node-only module' : 'not packaged',
  nativeCanvas: nativeCanvas.length ? 'required by pdfjs-dist for local PDF text extraction' : 'not packaged',
} }, null, 2)}\n`)
