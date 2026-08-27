import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import { createRequire } from 'node:module'
import JSZip from 'jszip'

export const MAX_ATTACHMENT_BYTES = 32 * 1024 * 1024
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024
export const MAX_IMAGE_PIXELS = 40_000_000
export const MAX_TEXT_BYTES = 8 * 1024 * 1024
export const MAX_EXTRACTED_TEXT = 2_000_000

const MIME_BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown', '.markdown': 'text/markdown',
  '.json': 'application/json', '.csv': 'text/csv', '.xml': 'application/xml', '.svg': 'image/svg+xml',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.mmd': 'text/vnd.mermaid', '.mermaid': 'text/vnd.mermaid', '.puml': 'text/vnd.plantuml', '.plantuml': 'text/vnd.plantuml',
}

export const mimeForName = (name: string) => MIME_BY_EXTENSION[extname(name).toLowerCase()] || 'application/octet-stream'
export const isRasterImage = (mimeType: string) => ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mimeType)
export const isTextAttachment = (mimeType: string) => mimeType.startsWith('text/') || ['application/json', 'application/xml', 'image/svg+xml'].includes(mimeType)

export const digest = (data: Uint8Array) => createHash('sha256').update(data).digest('hex')

export const decodeText = (data: Uint8Array) => {
  if (data.byteLength > MAX_TEXT_BYTES) throw new Error('文本附件超过 8 MB 限制')
  let encoding = 'utf-8'; let offset = 0
  if (data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) offset = 3
  else if (data[0] === 0xff && data[1] === 0xfe) { encoding = 'utf-16le'; offset = 2 }
  else if (data[0] === 0xfe && data[1] === 0xff) { encoding = 'utf-16be'; offset = 2 }
  else if (data.subarray(0, Math.min(data.length, 4096)).includes(0)) throw new Error('附件看起来是二进制文件，不能作为文本读取')
  try { return new TextDecoder(encoding, { fatal: true }).decode(data.subarray(offset)).slice(0, MAX_EXTRACTED_TEXT) }
  catch { throw new Error('文本附件编码不受支持，请转换为 UTF-8 或 UTF-16') }
}

let pdfJsPromise: Promise<typeof import('pdfjs-dist/legacy/build/pdf.mjs')> | undefined
const loadPdfJs = () => {
  if (!pdfJsPromise) {
    // PDF.js imports the native @napi-rs/canvas package at module startup to
    // install DOMMatrix. A package cross-built on macOS does not contain the
    // Windows native binary, even though text extraction itself does not need
    // a native canvas. Use the package's platform-neutral geometry polyfill
    // before lazily importing PDF.js so unrelated Runtime routes (for example
    // saving a model) never depend on PDF initialization.
    if (typeof globalThis.DOMMatrix === 'undefined') {
      const require = createRequire(import.meta.url)
      const geometry = require('@napi-rs/canvas/geometry.js') as { DOMMatrix: typeof globalThis.DOMMatrix }
      Object.defineProperty(globalThis, 'DOMMatrix', { configurable: true, writable: true, value: geometry.DOMMatrix })
    }
    pdfJsPromise = import('pdfjs-dist/legacy/build/pdf.mjs')
  }
  return pdfJsPromise
}

export const extractPdfText = async (data: Uint8Array) => {
  const { getDocument } = await loadPdfJs()
  const document = await getDocument({ data: new Uint8Array(data), useWorkerFetch: false, isEvalSupported: false, useSystemFonts: true }).promise
  const pages: string[] = []
  try {
    for (let pageNumber = 1; pageNumber <= Math.min(document.numPages, 500); pageNumber += 1) {
      const page = await document.getPage(pageNumber)
      const content = await page.getTextContent()
      const text = content.items.map(item => 'str' in item ? item.str : '').join(' ').replace(/\s+/g, ' ').trim()
      pages.push(`[第 ${pageNumber} 页]\n${text}`)
      if (pages.join('\n\n').length >= MAX_EXTRACTED_TEXT) break
    }
  } finally { await document.destroy() }
  const text = pages.join('\n\n').slice(0, MAX_EXTRACTED_TEXT).trim()
  if (!text) throw new Error('PDF 中没有可提取的文本（可能是扫描图片）')
  return text
}

const xmlUnescape = (value: string) => value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
const xmlText = (value: string) => xmlUnescape(value.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim()
const zipText = async (zip: JSZip, name: string) => (await zip.file(name)?.async('text')) || ''

export const extractDocxText = async (data: Uint8Array) => {
  const zip = await JSZip.loadAsync(data)
  const xml = await zipText(zip, 'word/document.xml')
  if (!xml) throw new Error('Word 文档格式无效或缺少正文')
  const paragraphs = [...xml.matchAll(/<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g)].map(match => {
    const text = [...match[1].matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map(part => xmlText(part[1])).join('')
    return text.trim()
  }).filter(Boolean)
  const text = paragraphs.join('\n').slice(0, MAX_EXTRACTED_TEXT).trim()
  if (!text) throw new Error('Word 文档中没有可提取的文本')
  return text
}

export const extractXlsxText = async (data: Uint8Array) => {
  const zip = await JSZip.loadAsync(data)
  const sharedXml = await zipText(zip, 'xl/sharedStrings.xml')
  const shared = [...sharedXml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map(match => [...match[1].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map(part => xmlText(part[1])).join(''))
  const names = Object.keys(zip.files).filter(name => /^xl\/worksheets\/sheet\d+\.xml$/.test(name)).sort()
  if (!names.length) throw new Error('Excel 文件中没有可读取的工作表')
  const sheets: string[] = []
  for (const name of names.slice(0, 50)) {
    const xml = await zipText(zip, name)
    const rows = [...xml.matchAll(/<row(?:\s[^>]*)?>([\s\S]*?)<\/row>/g)].map(row => [...row[1].matchAll(/<c([^>]*)>([\s\S]*?)<\/c>/g)].map(cell => {
      const type = cell[1].match(/\bt="([^"]+)"/)?.[1] || ''; const inner = cell[2]
      const raw = (inner.match(/<v>([\s\S]*?)<\/v>/)?.[1] || inner.match(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/)?.[1] || '')
      return type === 's' ? shared[Number(raw)] || '' : xmlText(raw)
    }).filter(Boolean).join(' | ')).filter(Boolean)
    if (rows.length) sheets.push(`[${name.split('/').at(-1)?.replace('.xml', '')}]\n${rows.join('\n')}`)
    if (sheets.join('\n\n').length >= MAX_EXTRACTED_TEXT) break
  }
  const text = sheets.join('\n\n').slice(0, MAX_EXTRACTED_TEXT).trim()
  if (!text) throw new Error('Excel 文件中没有可提取的单元格文本')
  return text
}

export const imageDimensions = (data: Uint8Array, mimeType: string) => {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  if (mimeType === 'image/png' && data.length >= 24) return { width: view.getUint32(16), height: view.getUint32(20) }
  if (mimeType === 'image/gif' && data.length >= 10) return { width: view.getUint16(6, true), height: view.getUint16(8, true) }
  if (mimeType === 'image/webp' && data.length >= 30) {
    const chunk = String.fromCharCode(...data.subarray(12, 16))
    if (chunk === 'VP8X') return { width: 1 + data[24] + (data[25] << 8) + (data[26] << 16), height: 1 + data[27] + (data[28] << 8) + (data[29] << 16) }
    if (chunk === 'VP8 ' && data[23] === 0x9d && data[24] === 0x01 && data[25] === 0x2a) return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff }
    if (chunk === 'VP8L' && data[20] === 0x2f) return { width: 1 + data[21] + ((data[22] & 0x3f) << 8), height: 1 + ((data[22] & 0xc0) >> 6) + (data[23] << 2) + ((data[24] & 0x0f) << 10) }
  }
  if (mimeType === 'image/jpeg') {
    let offset = 2
    while (offset + 9 < data.length) {
      if (data[offset] !== 0xff) { offset += 1; continue }
      const marker = data[offset + 1]; const length = view.getUint16(offset + 2)
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) return { width: view.getUint16(offset + 7), height: view.getUint16(offset + 5) }
      if (length < 2) break
      offset += 2 + length
    }
  }
  throw new Error('无法读取图片尺寸或文件已损坏')
}

export const inspectAttachment = async (path: string) => {
  const data = await readFile(path)
  const mimeType = mimeForName(path)
  if (data.byteLength > MAX_ATTACHMENT_BYTES) throw new Error('附件超过 32 MB 限制')
  let textContent: string | undefined
  let dimensions: { width: number; height: number } | undefined
  if (isTextAttachment(mimeType)) textContent = decodeText(data)
  else if (mimeType === 'application/pdf') textContent = await extractPdfText(data)
  else if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') textContent = await extractDocxText(data)
  else if (mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') textContent = await extractXlsxText(data)
  else if (isRasterImage(mimeType)) {
    if (data.byteLength > MAX_IMAGE_BYTES) throw new Error('图片超过 20 MB 限制')
    dimensions = imageDimensions(data, mimeType)
    if (dimensions.width * dimensions.height > MAX_IMAGE_PIXELS) throw new Error('图片像素超过 4000 万限制，请先缩小图片')
  } else throw new Error(`不支持的附件类型：${extname(path) || '未知格式'}`)
  return { data, mimeType, textContent, dimensions, sha256: digest(data) }
}
