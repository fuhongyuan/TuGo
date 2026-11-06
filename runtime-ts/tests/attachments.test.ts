import { describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { compressImageForModel } from '../src/attachments.js'

const noisyPng = (width: number, height: number) => {
  const canvas = createCanvas(width, height)
  const context = canvas.getContext('2d')
  const imageData = context.createImageData(width, height)
  imageData.data.set(randomBytes(imageData.data.length))
  context.putImageData(imageData, 0, 0)
  return new Uint8Array(canvas.toBuffer('image/png'))
}

describe('compressImageForModel', () => {
  it('downscales an oversized image into the model request budget', async () => {
    const oversized = noisyPng(3000, 2000)
    expect(oversized.byteLength).toBeGreaterThan(512 * 1024)
    const compressed = await compressImageForModel(oversized, 'image/png')
    expect(compressed.mimeType).toBe('image/jpeg')
    expect(compressed.data.byteLength).toBeLessThanOrEqual(768 * 1024)
    const image = await loadImage(compressed.data)
    expect(Math.max(image.width, image.height)).toBeLessThanOrEqual(2048)
  })

  it('does not upscale a small-dimension image and keeps smaller re-encodes', async () => {
    const compressed = await compressImageForModel(noisyPng(800, 600), 'image/png')
    const image = await loadImage(compressed.data)
    expect(image.width).toBe(800); expect(image.height).toBe(600)
  })

  it('passes a small image through untouched', async () => {
    const tiny = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0])
    const result = await compressImageForModel(tiny, 'image/png')
    expect(result.mimeType).toBe('image/png')
    expect(result.data).toBe(tiny)
  })

  it('passes a broken image through instead of failing the run', async () => {
    const broken = new Uint8Array(600 * 1024).fill(1)
    const result = await compressImageForModel(broken, 'image/png')
    expect(result.mimeType).toBe('image/png')
    expect(result.data).toBe(broken)
  })
})
