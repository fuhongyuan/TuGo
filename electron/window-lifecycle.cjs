const { basename, join, parse, resolve } = require('path')
const { existsSync } = require('fs')

let downloadHandlerInstalled = false

const restoreExistingWindow = (BrowserWindow, current) => {
  const win = current && !current.isDestroyed() ? current : BrowserWindow.getAllWindows().find(candidate => !candidate.isDestroyed())
  if (!win) return null
  if (win.isMinimized()) win.restore()
  win.show(); win.focus()
  return win
}

const attachWindowLifecycle = (win, deps) => {
  const { BrowserWindow, app, dialog, isDev, log, openExternal, onRendererLoss, getMainWindow, setMainWindow } = deps
  win.on('unresponsive', () => { void win.webContents.getProcessMemoryInfo().then(info => log(`renderer unresponsive pid=${win.webContents.getOSProcessId()} memory_kb=${info.private}`)).catch(error => log(`renderer unresponsive diagnostics failed: ${String(error?.message || error)}`)) })
  win.on('responsive', () => { void log('renderer responsive again') })
  win.webContents.on('render-process-gone', (_, details) => {
    void log(`renderer process gone reason=${details.reason} exit_code=${details.exitCode}`); onRendererLoss(`Renderer 异常退出（${details.reason}），本次画板工具未完成`)
    if (win.isDestroyed() || String(details.reason) === 'clean-exit') return
    const recent = (deps.getRecoveryAttempts() || []).filter(value => Date.now() - value < 60_000)
    if (recent.length >= 3) { void dialog.showMessageBox({ type: 'error', title: 'TuGo 无法恢复窗口', message: '窗口连续异常退出。画板数据已经保存，请退出并重新打开 TuGo。' }); return }
    deps.setRecoveryAttempts([...recent, Date.now()]); setTimeout(() => { if (!win.isDestroyed()) win.reload() }, 500)
  })
  win.on('closed', () => { if (getMainWindow() !== win) return; setMainWindow(null); onRendererLoss('Renderer closed') })
  win.webContents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: 'deny' } })
  win.webContents.on('will-navigate', (event, url) => { const current = win.webContents.getURL(); const sameOrigin = (() => { try { const next = new URL(url); const active = new URL(current); return next.protocol === active.protocol && next.origin === active.origin && (next.protocol !== 'file:' || next.pathname.startsWith(resolve(deps.distPath))) } catch { return false } })(); if (!sameOrigin) { event.preventDefault(); openExternal(url) } })
  win.webContents.on('will-attach-webview', event => event.preventDefault())
  win.webContents.on('before-input-event', (event, input) => { if (isDev) return; const key = String(input.key || '').toLowerCase(); if (key === 'f12' || ((input.meta || input.control) && input.shift && ['i', 'j', 'c'].includes(key)) || (input.meta && input.alt && key === 'i')) event.preventDefault() })
  win.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false)); win.webContents.session.setPermissionCheckHandler(() => false)
  if (!downloadHandlerInstalled) { downloadHandlerInstalled = true; win.webContents.session.on('will-download', (event, item) => { const source = String(item.getURL() || ''); if (!source.startsWith('blob:') && !source.startsWith('data:')) { event.preventDefault(); return }; const original = basename(item.getFilename()).replace(/[\u0000-\u001f]/g, '').slice(0, 180) || `tugo-export-${Date.now()}`; const parsed = parse(original); let target = join(app.getPath('downloads'), original); let suffix = 1; while (existsSync(target)) target = join(app.getPath('downloads'), `${parsed.name}-${suffix++}${parsed.ext}`); item.setSavePath(target); const notify = (status, extra = {}) => getMainWindow()?.webContents.send('tugo:download-state', { id: target, fileName: basename(target), path: target, status, received: item.getReceivedBytes(), total: item.getTotalBytes(), ...extra }); notify('downloading'); item.on('updated', (_event, state) => notify(state === 'interrupted' ? 'interrupted' : 'downloading')); item.once('done', (_event, state) => notify(state === 'completed' ? 'completed' : state)) }) }
}
module.exports = { restoreExistingWindow, attachWindowLifecycle }
