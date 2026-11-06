const { app, BrowserWindow } = require('electron')
const { writeFile, mkdtemp } = require('node:fs/promises')
const { join } = require('node:path')
const { tmpdir } = require('node:os')

// Render static InfiniteCanvas fixtures in desktop Chromium, without touching user data.
;(async () => {
  app.setPath('userData', await mkdtemp(join(tmpdir(), 'tugo-mermaid-render-')))
  await app.whenReady()
  const window = new BrowserWindow({ width: 1600, height: 1000, show: false, webPreferences: { nodeIntegration: false, contextIsolation: true } })
  for (const name of ['flow', 'state', 'entity']) {
    await window.loadFile(join(process.argv[2], `${name}.html`))
    await window.webContents.executeJavaScript('document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))')
    await window.webContents.executeJavaScript('Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => {})))')
    await writeFile(join(process.argv[2], `${name}-chromium.png`), (await window.webContents.capturePage()).toPNG())
  }
  app.quit()
})().catch(error => { console.error(error); app.exit(1) })
