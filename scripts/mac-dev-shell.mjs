import { copyFile, cp, mkdir, readFile, readlink, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { execFile as execFileCallback } from 'node:child_process'

const execFile = promisify(execFileCallback)
const shellId = 'com.agentplatform.tugo.dev'

const iconPixels = (size = 1024) => {
  const pixels = Buffer.alloc(size * size * 3)
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const index = (y * size + x) * 3
    const mix = (x + y) / (size * 2)
    let red = Math.round(113 * (1 - mix) + 60 * mix)
    let green = Math.round(103 * (1 - mix) + 47 * mix)
    let blue = Math.round(232 * (1 - mix) + 155 * mix)
    // Three white "canvas lines" plus a mint check badge, matching the app's
    // visual mark while remaining legible in a 16px Dock icon.
    const line = (x > size * .23 && x < size * .77) && ([.31, .51, .71].some(row => Math.abs(y / size - row) < .045))
    const circle = (x - size * .69) ** 2 + (y - size * .55) ** 2 < (size * .09) ** 2
    const check = x > size * .64 && x < size * .76 && y > size * .49 && y < size * .62 && Math.abs((y - size * .52) - (x - size * .65) * .7) < size * .014
    if (line) [red, green, blue] = [255, 255, 255]
    if (circle) [red, green, blue] = [184, 243, 220]
    if (check) [red, green, blue] = [36, 93, 80]
    pixels[index] = red; pixels[index + 1] = green; pixels[index + 2] = blue
  }
  return Buffer.concat([Buffer.from(`P6\n${size} ${size}\n255\n`), pixels])
}

const plistString = (contents, key) => contents.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]+)</string>`))?.[1]

const hasPreparedShell = async (target, source, bundleId) => {
  try {
    const info = await readFile(join(target, 'Contents', 'Info.plist'), 'utf8')
    const sourceInfo = await readFile(join(source, 'Contents', 'Info.plist'), 'utf8')
    await stat(join(target, 'Contents', 'Resources', 'electron.icns'))
    // Framework symlinks must remain relative inside the copied .app. Without
    // this, Chromium child processes resolve their resources against the old
    // generic Electron bundle and fail to load icudtl.dat.
    const current = await readlink(join(target, 'Contents', 'Frameworks', 'Electron Framework.framework', 'Versions', 'Current'))
    return info.includes(bundleId) && info.includes('TuGo') && current === 'A'
      && plistString(info, 'CFBundleVersion') === plistString(sourceInfo, 'CFBundleVersion')
  } catch { return false }
}

export async function prepareMacDevShell(root, electronCli, { variant = '' } = {}) {
  if (process.platform !== 'darwin') return null
  const source = resolve(dirname(electronCli), 'dist', 'Electron.app')
  // Do not put an app bundle below node_modules or a dot-directory. macOS
  // Spotlight/LaunchServices intentionally skips those locations, which makes
  // `open` report kLSNoExecutableErr even though the binary is present.
  const container = join(root, 'dev-shell')
  const safeVariant = String(variant).replace(/[^a-z0-9.-]/gi, '').toLowerCase()
  const bundleId = safeVariant ? `${shellId}.${safeVariant}` : shellId
  const target = join(container, safeVariant ? `TuGo-${safeVariant}.app` : 'TuGo.app')
  if (await hasPreparedShell(target, source, bundleId)) return join(target, 'Contents', 'MacOS', 'Electron')

  await mkdir(container, { recursive: true })
  // A previous interrupted copy can contain relative Framework symlinks that
  // point into the source bundle. Rebuild this generated cache atomically on
  // the next launch rather than attempting to merge its directories.
  await rm(target, { recursive: true, force: true })
  await cp(source, target, { recursive: true, force: true, verbatimSymlinks: true })
  const resources = join(target, 'Contents', 'Resources')
  const ppm = join(container, 'tugo-icon.ppm')
  const png = join(container, 'tugo-icon.png')
  const convertedIconDir = join(container, 'tugo.iconset')
  await writeFile(ppm, iconPixels())
  await execFile('sips', ['-s', 'format', 'png', '-z', '1024', '1024', ppm, '--out', png])
  await rm(convertedIconDir, { recursive: true, force: true })
  await mkdir(convertedIconDir, { recursive: true })
  for (const size of [16, 32, 128, 256, 512]) {
    await execFile('sips', ['-z', String(size), String(size), png, '--out', join(convertedIconDir, `icon_${size}x${size}.png`)])
    await execFile('sips', ['-z', String(size * 2), String(size * 2), png, '--out', join(convertedIconDir, `icon_${size}x${size}@2x.png`)])
  }
  const icns = join(container, 'tugo-icon.icns')
  await execFile('iconutil', ['-c', 'icns', convertedIconDir, '-o', icns])
  await copyFile(icns, join(resources, 'electron.icns'))
  const info = join(target, 'Contents', 'Info.plist')
  for (const key of ['CFBundleDisplayName', 'CFBundleName']) await execFile('plutil', ['-replace', key, '-string', 'TuGo', info])
  await execFile('plutil', ['-replace', 'CFBundleIdentifier', '-string', bundleId, info])
  // Changing a macOS app's Info.plist or icon invalidates the outer bundle
  // signature. macOS 26 aborts during NSApplication registration for such a
  // bundle, before Electron can report a useful error. Keep Electron's signed
  // embedded frameworks intact and re-sign only this generated outer shell.
  await execFile('codesign', ['--force', '--sign', '-', '--preserve-metadata=identifier,entitlements,requirements,flags', target])
  return join(target, 'Contents', 'MacOS', 'Electron')
}
