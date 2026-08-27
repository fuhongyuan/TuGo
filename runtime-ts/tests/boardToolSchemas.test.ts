import Ajv from 'ajv'
import { describe, expect, it } from 'vitest'
import { BOARD_BATCH_SCHEMA } from '../src/boardToolSchemas.js'

describe('board tool schemas', () => {
  const validate = new Ajv({ strict: false, allErrors: true }).compile(BOARD_BATCH_SCHEMA)
  it('accepts canonical operations', () => expect(validate({ description: '绘制', operations: [{ op: 'add_element', element: { id: 'a', kind: 'rectangle', x: 0, y: 0, width: 120, height: 60, text: 'A' } }] })).toBe(true))
  it('rejects misspelled fields before renderer execution', () => expect(validate({ description: '绘制', operations: [{ op: 'add_element', element: { id: 'a', kind: 'rect', x: 0, y: 0, w: 120, h: 60 } }] })).toBe(false))
  it('requires operation-specific payloads', () => expect(validate({ description: '绘制', operations: [{ op: 'patch_edge', id: 'e' }] })).toBe(false))
})
