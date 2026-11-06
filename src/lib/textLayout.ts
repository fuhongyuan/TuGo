import type { BoardElement } from '../types'

let context: CanvasRenderingContext2D | null | undefined
function width(text: string, fontSize: number, item: BoardElement) {
  if (context === undefined) {
    try { context = typeof document === 'undefined' || /jsdom/i.test(navigator.userAgent) ? null : document.createElement('canvas').getContext('2d') } catch { context = null }
  }
  if (context) {
    context.font = `${item.fontStyle || 'normal'} ${item.fontWeight || 'normal'} ${fontSize}px "${item.fontFamily || 'Inter'}", sans-serif`
    return context.measureText(text).width
  }
  return Array.from(text).reduce((sum, char) => sum + (/[^\x00-\x7f]/.test(char) ? 1 : /[ilI.,: ]/.test(char) ? .3 : .61) * fontSize, 0)
}

/** Tight ink bounds keep routes out of headings without blocking a whole lane. */
export function textObstacle(item: BoardElement) {
  const { lines, fontSize, lineHeight } = layoutNodeText(item)
  const w = Math.min(item.width, Math.max(0, ...lines.map(line => width(line, fontSize, item))))
  const h = Math.min(item.height, lines.length * lineHeight)
  const x = item.textAlign === 'left' ? item.x + 12 : item.textAlign === 'right' ? item.x + item.width - 12 - w : item.x + (item.width - w) / 2
  const y = item.verticalAlign === 'top' ? item.y + 4 : item.verticalAlign === 'bottom' ? item.y + item.height - h - 4 : item.y + (item.height - h) / 2
  return { x, y, width: w, height: h }
}

/** One measured layout for editable canvas text and vector exports. */
export function layoutNodeText(item: BoardElement) {
  const availableWidth = Math.max(1, item.width - 24), availableHeight = Math.max(1, item.height - 8)
  const wrap = (size: number) => String(item.text || '').split(/\r?\n/).flatMap(paragraph => {
    const lines: string[] = []; let line = ''
    for (const token of paragraph.match(/\s+|[a-zA-Z0-9_-]+|[^\s]/gu) || []) {
      if (line && width(line + token, size, item) > availableWidth) { lines.push(line.trimEnd()); line = '' }
      for (const char of token) {
        if (line && width(line + char, size, item) > availableWidth) { lines.push(line.trimEnd()); line = '' }
        if (line || char.trim()) line += char
      }
    }
    lines.push(line); return lines
  })
  let fontSize = item.fontSize || 16, lines = wrap(fontSize)
  // Captions and headings need the same fit policy: otherwise HTML wraps a
  // heading that the SVG exporter leaves on one line, silently clipping it.
  while (fontSize > 8 && lines.length * fontSize * 1.25 > availableHeight) { fontSize = Math.max(8, fontSize - .5); lines = wrap(fontSize) }
  return { lines, fontSize, lineHeight: fontSize * 1.25, overflow: lines.length * fontSize * 1.25 > availableHeight }
}
