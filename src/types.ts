export type ElementKind = 'rectangle' | 'rounded_rectangle' | 'ellipse' | 'diamond' | 'triangle' | 'hexagon' | 'database' | 'cloud' | 'actor' | 'frame' | 'text' | 'note' | 'image'
export type StrokeStyle = 'solid' | 'dashed' | 'dotted'
export type ArrowStyle = 'none' | 'arrow' | 'triangle' | 'circle' | 'diamond'
export type EdgeRouting = 'curve' | 'straight' | 'elbow' | 'polyline'
export type DrawingCursorStyle = 'tugo' | 'classic' | 'pixel' | 'rgb' | 'plane' | 'rocket' | 'cat' | 'mascot' | 'tank' | 'voxel_sword' | 'pixel_star' | 'neon_leek'
/** A stable point on an element's bounding edge, stored as 0–1 local coordinates. */
export type EdgeAnchor = { x: number; y: number }
export type TextAlign = 'left' | 'center' | 'right'
export type VerticalAlign = 'top' | 'middle' | 'bottom'

export type BoardElement = {
  id: string
  kind: ElementKind
  x: number
  y: number
  width: number
  height: number
  text: string
  fill: string
  stroke: string
  strokeWidth: number
  strokeStyle?: StrokeStyle
  fillOpacity?: number
  opacity?: number
  textColor?: string
  fontSize: number
  fontFamily?: string
  fontWeight?: 'normal' | 'bold'
  fontStyle?: 'normal' | 'italic'
  textDecoration?: 'none' | 'underline'
  textAlign?: TextAlign
  verticalAlign?: VerticalAlign
  rotation?: number
  borderRadius?: number
  zIndex?: number
  groupId?: string
  locked?: boolean
  metadata?: Record<string, unknown>
}

export type BoardEdge = {
  id: string
  from: string
  to: string
  label?: string
  stroke: string
  strokeWidth: number
  strokeStyle?: StrokeStyle
  dashed?: boolean
  arrowStart?: boolean
  arrowEnd?: boolean
  startArrow?: ArrowStyle
  endArrow?: ArrowStyle
  routing?: EdgeRouting
  opacity?: number
  zIndex?: number
  controlPoints?: Array<{ x: number; y: number }>
  /** Canvas coordinates for a loose endpoint when this edge is not attached to a card. */
  freeStart?: { x: number; y: number }
  freeEnd?: { x: number; y: number }
  /** Optional user-selected attachment points. Legacy edges fall back to smart auto anchors. */
  fromAnchor?: EdgeAnchor
  toAnchor?: EdgeAnchor
  metadata?: Record<string, unknown>
}

export type DslKind = 'mermaid' | 'plantuml' | 'drawio'

export type DslSource = {
  kind: DslKind
  source: string
  updatedAt: string
}

export type BoardDocument = {
  version: 1 | 2 | 3
  elements: BoardElement[]
  edges: BoardEdge[]
  paletteId?: string
  dsl?: DslSource
  viewport: { x: number; y: number; zoom: number }
}

export type ProjectFolder = {
  id: string
  name: string
  createdAt: string
  updatedAt: string
}

export type BoardProject = {
  id: string
  folderId: string | null
  name: string
  document: BoardDocument
  createdAt: string
  updatedAt: string
}

export type BoardOperation =
  | { op: 'add_element'; element: BoardElement }
  | { op: 'patch_element'; id: string; patch: Partial<BoardElement> }
  | { op: 'delete_element'; id: string }
  | { op: 'add_edge'; edge: BoardEdge }
  | { op: 'patch_edge'; id: string; patch: Partial<BoardEdge> }
  | { op: 'delete_edge'; id: string }
  | { op: 'group_elements'; ids: string[]; groupId?: string }
  | { op: 'ungroup_elements'; ids: string[] }
  | { op: 'align_elements'; ids: string[]; alignment: 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom' }
  | { op: 'distribute_elements'; ids: string[]; axis: 'horizontal' | 'vertical' }
  | { op: 'set_palette'; paletteId: string }
  | { op: 'replace_document'; document: BoardDocument }
  | { op: 'patch_dsl'; kind: DslKind; source: string }

export type ChatMessage = {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  createdAt: string
  pending?: boolean
  /** Compact user-facing execution state. Raw process events remain available
   * in Run Debug and are intentionally not rendered as chat progress. */
  runStatus?: ChatRunStatus
  runSummary?: ChatRunSummary
  process?: ChatProcessItem[]
  attachments?: ChatAttachment[]
  references?: CanvasReference[]
  skills?: ChatSkillMention[]
  runId?: string
  threadId?: string
}

export type BoardChangeStats = {
  addedElements: number
  updatedElements: number
  removedElements: number
  addedEdges: number
  updatedEdges: number
  removedEdges: number
}

export type ChatPlan = {
  id: string
  title: string
  status: string
  currentStepId?: string
  steps: Array<{
    id: string
    title: string
    instruction?: string
    resultSummary?: string
    blocker?: string
    status: string
  }>
}

export type ChatRunStatus = {
  phase: 'analyzing' | 'reading' | 'editing' | 'reviewing' | 'researching' | 'waiting' | 'finalizing'
  headline: string
  detail?: string
  /** Latest complete, user-facing sentence emitted by the Agent. It remains
   * visible while tools run instead of being overwritten by the next event. */
  narration?: string
  /** Human-visible rolling window of the current answer, including an
   * unfinished sentence. It is replaced by concrete tool activity. */
  liveNarration?: string
  /** Rolling reasoning activity. This is used as liveness/context while the
   * model is thinking and is never included in the final assistant answer. */
  reasoningPreview?: string
  /** Readable description extracted from the currently streaming tool
   * arguments. It is shown in chat but intentionally does not drive the cursor. */
  toolPreview?: string
  /** Most recent concrete plan/tool action. Completed actions remain visible
   * while the model decides its next step, so fast tools never just flash. */
  activity?: {
    id: string
    label: string
    status: 'running' | 'completed' | 'recovering' | 'failed'
    toolName?: string
    category?: 'planning' | 'reading' | 'researching' | 'editing' | 'reviewing' | 'saving' | 'preparing' | 'external' | 'working'
  }
  startedAt: string
  lastActivityAt: string
  lastCanvasActivityAt?: string
  narrationBuffer?: string
  reasoningBuffer?: string
  changes: BoardChangeStats
  artifacts: {
    snapshotsCreated: number
    /** Durable snapshot ids created by this run. Older persisted runs may not have them. */
    snapshotIds?: string[]
    imagesCaptured: number
  }
  usage?: {
    inputTokens: number
    outputTokens: number
    totalTokens: number
    cachedInputTokens: number
  }
  durationMs?: number
  milestones: string[]
  /** Latest durable plan snapshot from the structured event stream. */
  plan?: ChatPlan
  /** Tool mutations are only counted after their matching result succeeds. */
  pendingChanges?: Record<string, BoardChangeStats>
}

export type ChatRunSummary = {
  text: string
  changes: BoardChangeStats
  artifacts: ChatRunStatus['artifacts']
  usage?: ChatRunStatus['usage']
  durationMs?: number
  milestones: string[]
}

export type ChatSkillMention = {
  skillId: string
  name: string
  description?: string
}

export type CanvasReference = {
  kind: 'element' | 'edge' | 'region'
  id: string
  label: string
  text?: string
  x?: number
  y?: number
  width?: number
  height?: number
  from?: string
  to?: string
  elementIds?: string[]
}

export type ChatAttachment = {
  attachmentId: string
  name: string
  size: number
  mimeType: string
}

export type ChatProcessItem = {
  id: string
  kind: 'thinking' | 'tool' | 'plan' | 'status'
  label: string
  detail?: string
  status: 'running' | 'success' | 'error' | 'pending'
  sequence?: number
  plan?: ChatPlan
}

export type ProjectConversation = {
  id: string
  projectId: string
  threadId?: string
  modelId?: string
  title: string
  messages: ChatMessage[]
  createdAt: string
  updatedAt: string
}

export type ConversationIndex = {
  conversations: ProjectConversation[]
  activeConversationIds: Record<string, string>
}

export type TuGoConfig = {
  theme: 'system' | 'light' | 'dark'
  /** Appearance of the animated Agent cursor while it edits the canvas. */
  drawingCursor?: { style: DrawingCursorStyle; color: string }
  /** `system` follows the OS; unsupported OS languages resolve to English. */
  language?: 'system' | 'en' | 'zh-CN' | 'zh-TW' | 'ja' | 'ko' | 'es' | 'fr' | 'de' | 'pt-BR' | 'ru'
  /** User-positioned floating board controls, relative to the canvas stage. */
  boardVersionPosition?: { x: number; y: number }
  /** User-positioned execution-plan card, relative to the canvas stage. */
  planPosition?: { x: number; y: number }
  model?: {
    modelId?: string
    providerId: string
    model: string
    displayName: string
    apiKey?: string
    baseUrl?: string
    /** Optional provider-gateway path override, such as /chat/responses. */
    apiPath?: string
    contextWindow?: number
    maxOutputTokens?: number
    visionCapable?: boolean
  }
  /** Last model picked in the composer; credentials always remain in Runtime SQLite. */
  selectedModelId?: string
  bootstrap?: { ready?: boolean; agentId?: string; skillId?: string; mcpCredentialId?: string; toolPolicyVersion?: number }
}

export type BootstrapStatus = {
  l4: 'starting' | 'ready' | 'error'
  model: 'missing' | 'ready'
  mcp: 'missing' | 'ready'
  skill: 'missing' | 'ready'
  agent: 'missing' | 'ready'
  message?: string
}

export const emptyDocument = (): BoardDocument => ({
  version: 3,
  elements: [],
  edges: [],
  paletteId: 'macaron',
  viewport: { x: 0, y: 0, zoom: 1 },
})

export const newId = (prefix: string) => `${prefix}_${crypto.randomUUID()}`
