import type { BoardDocument, BoardProject, TuGoConfig, ProjectFolder, ConversationIndex, ProjectConversation } from './types'

declare global {
  interface Window {
    tugo?: {
      config: { read(): Promise<TuGoConfig>; write(value: Partial<TuGoConfig>): Promise<TuGoConfig> }
      folders: { list(): Promise<ProjectFolder[]>; create(name: string): Promise<ProjectFolder>; rename(id: string, name: string): Promise<ProjectFolder>; remove(id: string): Promise<boolean> }
      projects: { list(): Promise<BoardProject[]>; get(id: string): Promise<BoardProject | null>; create(payload: Partial<BoardProject>): Promise<BoardProject>; update(payload: Partial<BoardProject> & { id: string }): Promise<BoardProject>; remove(id: string): Promise<boolean>; snapshots: { create(payload: { projectId: string; name: string; source: 'user' | 'agent'; reason?: string; summary?: string; notes?: string; document: BoardDocument }): Promise<{ id: string; createdAt: string; name: string; source: 'user' | 'agent'; reason: string; summary: string; notes: string }>; list(projectId: string, page?: number, pageSize?: number, source?: 'user' | 'agent'): Promise<{ projectId: string; source: 'user' | 'agent'; items: Array<{ id: string; name: string; source: 'user' | 'agent'; reason: string; summary: string; notes: string; createdAt: string }>; total: number; page: number; pageSize: number; hasMore: boolean; message: string }>; get(projectId: string, snapshotId: string): Promise<{ id: string; projectId: string; name: string; source: 'user' | 'agent'; reason: string; summary: string; notes: string; createdAt: string; document: BoardDocument }>; export(projectId: string, snapshotId: string): Promise<{ ok?: boolean; cancelled?: boolean; path?: string }>; import(projectId: string, file?: File): Promise<{ ok?: boolean; cancelled?: boolean; name?: string; fileName?: string; document?: BoardDocument; imageSources?: Record<string, string> }>; latest(projectId: string): Promise<{ id: string; name: string; source: 'user' | 'agent'; createdAt: string } | null>; remove(projectId: string, snapshotId: string): Promise<boolean> }; skillScope(projectId: string): Promise<{ configured: boolean; skillIds: string[] }>; setSkillIds(projectId: string, skillIds: string[]): Promise<string[]> }
      conversations: { list(): Promise<ConversationIndex>; create(projectId: string): Promise<ProjectConversation>; save(value: ProjectConversation): Promise<ProjectConversation>; activate(projectId: string, conversationId: string): Promise<boolean>; removeForProject(projectId: string): Promise<boolean> }
      board: {
        onToolCall(callback: (payload: { id: string; name: string; args: Record<string, unknown>; context: Record<string, unknown> }) => void): () => void
        respondToolCall(id: string, result?: unknown, error?: string): void
      }
      runtime: {
        request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>
        onEvent(callback: (payload: { subscriptionId: string; event: Record<string, unknown> }) => void): () => void
        onStreamEnd(callback: (payload: { subscriptionId: string; runId: string }) => void): () => void
      }
      system: {
        appName(): Promise<string>; backendLog(): Promise<string>; chooseAttachments(): Promise<string[]>; chooseSkill(): Promise<{ name: string; content: string; resources: Array<{ path: string; content: string }> } | null>; getPathForFile(file: File): string; openDataDirectory(): Promise<string>; openBackendLog(): Promise<string>; openDownloadedFile(path: string): Promise<string>
        onDownloadState(callback: (state: { id: string; fileName: string; path: string; status: string; received: number; total: number }) => void): () => void
      }
      data: {
        status(): Promise<{ dataDir: string; logPath: string; app: { integrity: string; backups: Array<{ name: string; size: number; createdAt: string }> }; runtime: { integrity?: { ok?: boolean }; backups: Array<{ name: string; size: number; created_at: string }> } }>
        backup(): Promise<{ ok: boolean }>
        exportPackage(kind: 'backup' | 'diagnostic'): Promise<{ ok?: boolean; cancelled?: boolean; path?: string }>
        restore(scope: 'app' | 'runtime', name: string): Promise<{ scheduled: boolean }>
      }
    }
  }
}

export {}
