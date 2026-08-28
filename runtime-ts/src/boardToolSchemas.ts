import type { JsonObject } from './contracts.js'

const point: JsonObject = { type: 'object', required: ['x', 'y'], properties: { x: { type: 'number' }, y: { type: 'number' } }, additionalProperties: false }
const anchor: JsonObject = { type: 'object', required: ['x', 'y'], properties: { x: { type: 'number', minimum: 0, maximum: 1 }, y: { type: 'number', minimum: 0, maximum: 1 } }, additionalProperties: false }
const elementProperties: JsonObject = {
  id: { type: 'string', minLength: 1 }, kind: { enum: ['rectangle', 'rounded_rectangle', 'ellipse', 'diamond', 'triangle', 'hexagon', 'database', 'cloud', 'actor', 'frame', 'text', 'note', 'image'] },
  x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number', minimum: 20 }, height: { type: 'number', minimum: 20 }, text: { type: 'string' },
  fill: { type: 'string' }, stroke: { type: 'string' }, strokeWidth: { type: 'number', minimum: 0, maximum: 32 }, strokeStyle: { enum: ['solid', 'dashed', 'dotted'] },
  fillOpacity: { type: 'number', minimum: 0, maximum: 1 }, opacity: { type: 'number', minimum: 0, maximum: 1 }, textColor: { type: 'string' }, fontSize: { type: 'number', minimum: 8, maximum: 160 },
  fontFamily: { type: 'string' }, fontWeight: { enum: ['normal', 'bold'] }, fontStyle: { enum: ['normal', 'italic'] }, textDecoration: { enum: ['none', 'underline'] },
  textAlign: { enum: ['left', 'center', 'right'] }, verticalAlign: { enum: ['top', 'middle', 'bottom'] }, rotation: { type: 'number', minimum: -360, maximum: 360 }, borderRadius: { type: 'number', minimum: 0 },
  zIndex: { type: 'integer' }, groupId: { type: 'string' }, locked: { type: 'boolean' }, metadata: { type: 'object' },
}
const edgeProperties: JsonObject = {
  id: { type: 'string', minLength: 1 }, from: { type: 'string' }, to: { type: 'string' }, label: { type: 'string' }, stroke: { type: 'string' }, strokeWidth: { type: 'number', minimum: .5, maximum: 32 },
  strokeStyle: { enum: ['solid', 'dashed', 'dotted'] }, startArrow: { enum: ['none', 'arrow', 'triangle', 'circle', 'diamond'] }, endArrow: { enum: ['none', 'arrow', 'triangle', 'circle', 'diamond'] },
  routing: { enum: ['curve', 'straight', 'elbow', 'polyline'] }, opacity: { type: 'number', minimum: 0, maximum: 1 }, zIndex: { type: 'integer' }, controlPoints: { type: 'array', items: point },
  freeStart: point, freeEnd: point, fromAnchor: anchor, toAnchor: anchor, metadata: { type: 'object' },
}
const element: JsonObject = { type: 'object', required: ['id', 'kind', 'x', 'y', 'width', 'height', 'text'], properties: elementProperties, additionalProperties: false }
const elementPatch: JsonObject = { type: 'object', minProperties: 1, properties: elementProperties, additionalProperties: false }
const edge: JsonObject = { type: 'object', required: ['id', 'from', 'to'], properties: edgeProperties, additionalProperties: false }
const edgePatch: JsonObject = { type: 'object', minProperties: 1, properties: edgeProperties, additionalProperties: false }
const ids: JsonObject = { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', minLength: 1 } }
const operation = (op: string, required: string[], properties: JsonObject): JsonObject => ({ type: 'object', required: ['op', ...required], properties: { op: { const: op }, ...properties }, additionalProperties: false })

export const BOARD_BATCH_SCHEMA: JsonObject = {
  type: 'object', required: ['description', 'operations'], additionalProperties: false,
  properties: {
    description: { type: 'string', minLength: 1, maxLength: 160 },
    operations: { type: 'array', minItems: 1, maxItems: 12, items: { oneOf: [
      operation('add_element', ['element'], { element }),
      operation('patch_element', ['id', 'patch'], { id: { type: 'string', minLength: 1 }, patch: elementPatch }),
      operation('delete_element', ['id'], { id: { type: 'string', minLength: 1 } }),
      operation('add_edge', ['edge'], { edge }),
      operation('patch_edge', ['id', 'patch'], { id: { type: 'string', minLength: 1 }, patch: edgePatch }),
      operation('delete_edge', ['id'], { id: { type: 'string', minLength: 1 } }),
      operation('group_elements', ['ids'], { ids, groupId: { type: 'string' } }), operation('ungroup_elements', ['ids'], { ids }),
      operation('align_elements', ['ids', 'alignment'], { ids, alignment: { enum: ['left', 'center', 'right', 'top', 'middle', 'bottom'] } }),
      operation('distribute_elements', ['ids', 'axis'], { ids, axis: { enum: ['horizontal', 'vertical'] } }), operation('set_palette', ['paletteId'], { paletteId: { type: 'string', minLength: 1 } }),
    ] } },
  },
}

export const strictBuiltinToolSchema = (name: string, schema: JsonObject) => {
  const source = name === 'board_batch' ? BOARD_BATCH_SCHEMA : schema
  const required = Array.isArray(source.required) ? source.required.map(String).filter(field => field !== 'description') : undefined
  return { ...source, ...(required ? { required } : {}) }
}
