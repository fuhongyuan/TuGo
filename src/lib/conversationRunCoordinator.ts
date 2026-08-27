export type ActiveConversationRun = { threadId: string; runId: string }

type ActiveEntry = { controller: AbortController; run?: ActiveConversationRun }

/**
 * Owns only ephemeral renderer-side run handles. Durable truth remains in the
 * Runtime/App databases; this object prevents a renderer lifecycle branch
 * from forgetting to abort or clear one of its in-memory maps.
 */
export class ConversationRunCoordinator {
  private activeEntries = new Map<string, ActiveEntry>()

  begin(conversationId: string) {
    if (this.activeEntries.has(conversationId)) throw new Error('当前会话仍有运行中的任务')
    const controller = new AbortController()
    this.activeEntries.set(conversationId, { controller })
    return controller
  }

  bindRuntimeRun(conversationId: string, run: ActiveConversationRun) {
    const entry = this.activeEntries.get(conversationId)
    if (!entry) return false
    entry.run = run
    return true
  }

  active(conversationId: string) { return this.activeEntries.get(conversationId)?.run }
  signal(conversationId: string) { return this.activeEntries.get(conversationId)?.controller.signal }

  cancel(conversationId: string, reason: unknown = 'user') {
    const entry = this.activeEntries.get(conversationId)
    entry?.controller.abort(reason)
    return entry?.run
  }

  finish(conversationId: string) {
    const entry = this.activeEntries.get(conversationId)
    this.activeEntries.delete(conversationId)
    return entry?.run
  }

  has(conversationId: string) { return this.activeEntries.has(conversationId) }
}
