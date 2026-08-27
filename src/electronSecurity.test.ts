import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const main = readFileSync(resolve(root, 'electron/main.cjs'), 'utf8')
const windowLifecycle = readFileSync(resolve(root, 'electron/window-lifecycle.cjs'), 'utf8')
const desktopMain = `${main}\n${windowLifecycle}`
const preload = readFileSync(resolve(root, 'electron/preload.cjs'), 'utf8')
const html = readFileSync(resolve(root, 'index.html'), 'utf8')
const releaseBuilder = readFileSync(resolve(root, 'electron-builder.release.cjs'), 'utf8')
const builder = JSON.parse(readFileSync(resolve(root, 'electron-builder.json'), 'utf8')) as { files: string[]; electronFuses?: Record<string, boolean>; mac: { hardenedRuntime?: boolean; entitlements?: string; entitlementsInherit?: string } }

describe('Electron release security policy', () => {
  it('isolates the renderer and disables production developer tools', () => {
    expect(main).toContain('contextIsolation: true')
    expect(main).toContain('nodeIntegration: false')
    expect(main).toContain('sandbox: true')
    expect(main).toContain('devTools: isDev')
    expect(desktopMain).toContain("key === 'f12'")
  })

  it('denies webviews, unexpected navigation and browser permissions', () => {
    expect(desktopMain).toContain('will-attach-webview')
    expect(desktopMain).toContain('event.preventDefault()')
    expect(desktopMain).toContain('setPermissionRequestHandler')
    expect(desktopMain).toContain('callback(false)')
    expect(desktopMain).toContain('setPermissionCheckHandler(() => false)')
    expect(desktopMain).toContain("['https:', 'http:'].includes")
  })

  it('exposes only the scoped preload bridge and applies a restrictive CSP', () => {
    expect(preload).toContain("contextBridge.exposeInMainWorld('tugo'")
    expect(preload).not.toMatch(/exposeInMainWorld\([^,]+,\s*(?:require|process|ipcRenderer)\b/)
    expect(html).toContain("object-src 'none'")
    expect(html).toContain("frame-src 'none'")
    expect(html).toContain("base-uri 'none'")
    expect(html).toContain("form-action 'none'")
  })

  it('ships only runtime JavaScript and Electron CommonJS entrypoints', () => {
    expect(builder.files).toContain('runtime-ts/dist/*.js')
    expect(builder.files).toContain('electron/*.cjs')
    expect(builder.files.filter(pattern => !pattern.startsWith('!')).some(pattern => /source.?map|examples|mcp-server|python|deerflow|langchain|langgraph/i.test(pattern))).toBe(false)
    expect(builder.files).toContain('!node_modules/**/*.map')
    expect(builder.files).toContain('!node_modules/**/examples/**')
    expect(builder.files).toContain('!node_modules/**/{test,tests,__tests__}/**')
  })

  it('uses isolated ad-hoc and Developer ID hardened-runtime entitlements', () => {
    expect(builder.mac.hardenedRuntime).toBe(true)
    expect(builder.mac.entitlements).toBe('build/entitlements.mac.dev.plist')
    const developmentEntitlements = readFileSync(resolve(root, builder.mac.entitlements || ''), 'utf8')
    expect(developmentEntitlements).toContain('com.apple.security.cs.disable-library-validation')
    expect(releaseBuilder).toContain("entitlements: 'build/entitlements.mac.plist'")
    expect(releaseBuilder).toContain("entitlementsInherit: 'build/entitlements.mac.plist'")
    expect(releaseBuilder).toContain('Developer ID Application')
    const releaseEntitlements = readFileSync(resolve(root, 'build/entitlements.mac.plist'), 'utf8')
    expect(releaseEntitlements).toContain('com.apple.security.cs.allow-jit')
    expect(releaseEntitlements).not.toContain('disable-library-validation')
  })

  it('locks production Electron to the signed ASAR and disables runtime injection switches', () => {
    expect(builder.electronFuses).toMatchObject({
      runAsNode: false,
      enableNodeOptionsEnvironmentVariable: false,
      enableNodeCliInspectArguments: false,
      enableEmbeddedAsarIntegrityValidation: true,
      onlyLoadAppFromAsar: true,
    })
  })

  it('does not create a second window when the Dock is clicked during startup', () => {
    expect(main).toContain('let startupReady = false')
    expect(main).toContain('if (!startupReady || shutdownStarted) return')
    expect(desktopMain).toContain('BrowserWindow.getAllWindows().find')
  })

  it('keeps the production window hidden until the packaged renderer is ready', () => {
    expect(main).toContain('show: false')
    expect(main).toContain("win.once('ready-to-show'")
    expect(html).toContain("!location.pathname.includes('/dist-web/')")
  })
})
