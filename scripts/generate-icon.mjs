import { copyFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'

const root = resolve(import.meta.dirname, '..')
const source = join(root, 'assets', 'tugo-logo.png')
const output = join(root, 'assets', 'tugo.png')

// Non-darwin builds ship the raw logo; only macOS needs the composed icon
// (electron-builder derives .icns from this 1024px PNG).
if (process.platform !== 'darwin') {
  await copyFile(source, output)
  process.exit(0)
}

// Compose a rounded-square background behind the dog logo so the dock/launchpad
// icon matches the squircle shape of neighbouring apps instead of a raw alpha
// blob. Pillow is ubiquitous on macOS (system Python ships it) and avoids
// shelling out to ImageMagick.
const script = `
from PIL import Image, ImageDraw

SIZE = 1024
RADIUS = 230
BG = (99, 102, 241, 255)        # #6366f1, the app accent indigo
LOGO_SCALE = 0.78               # logo occupies the inner ~78% with padding
PAD = int(SIZE * (1 - LOGO_SCALE) / 2)

canvas = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))

mask = Image.new('L', (SIZE, SIZE), 0)
ImageDraw.Draw(mask).rounded_rectangle((0, 0, SIZE - 1, SIZE - 1), radius=RADIUS, fill=255)
canvas.paste(Image.new('RGBA', (SIZE, SIZE), BG), (0, 0), mask)

logo = Image.open(${JSON.stringify(source)}).convert('RGBA')
logo = logo.resize((SIZE - 2 * PAD, SIZE - 2 * PAD), Image.LANCZOS)
canvas.paste(logo, (PAD, PAD), logo)

canvas.save(${JSON.stringify(output)}, 'PNG')
print('ok')
`

await new Promise((resolvePromise, rejectPromise) => {
  const child = spawn('python3', ['-c', script], { stdio: 'inherit' })
  child.once('error', rejectPromise)
  child.once('exit', code => code === 0 ? resolvePromise() : rejectPromise(new Error(`python3 exited with ${code}`)))
})

