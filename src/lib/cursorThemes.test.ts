import { describe, expect, it } from 'vitest'
import { drawingCursorColors, drawingCursorThemes } from './cursorThemes'

describe('drawing cursor themes', () => {
  it('keeps identifiers unique and metadata complete', () => {
    const ids = drawingCursorThemes.map(theme => theme.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const theme of drawingCursorThemes) {
      expect(theme.name.trim()).not.toBe('')
      expect(theme.description.trim()).not.toBe('')
      expect(theme.nameEn.trim()).not.toBe('')
      expect(theme.descriptionEn.trim()).not.toBe('')
    }
    expect(drawingCursorThemes[0].id).toBe('tugo')
  })

  it('uses valid six-digit hex colors without duplicates', () => {
    expect(new Set(drawingCursorColors).size).toBe(drawingCursorColors.length)
    for (const color of drawingCursorColors) expect(color).toMatch(/^#[0-9A-F]{6}$/)
  })
})
