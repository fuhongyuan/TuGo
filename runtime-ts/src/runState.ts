export const RUN_STATUSES = ['queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted'] as const
export type RunStatus = typeof RUN_STATUSES[number]
export type TerminalRunStatus = Extract<RunStatus, 'completed' | 'failed' | 'cancelled' | 'interrupted'>

export const TERMINAL_RUN_STATUSES: readonly TerminalRunStatus[] = ['completed', 'failed', 'cancelled', 'interrupted']

const transitions: Record<RunStatus, readonly RunStatus[]> = {
  queued: ['running', 'failed', 'cancelled', 'interrupted'],
  running: ['completed', 'failed', 'cancelled', 'interrupted'],
  completed: [],
  failed: [],
  cancelled: [],
  interrupted: [],
}

export const isRunStatus = (value: unknown): value is RunStatus => RUN_STATUSES.includes(value as RunStatus)
export const isTerminalRunStatus = (value: unknown): value is TerminalRunStatus => TERMINAL_RUN_STATUSES.includes(value as TerminalRunStatus)
export const canTransitionRun = (from: RunStatus, to: RunStatus) => transitions[from].includes(to)

// The embedded Runtime has no durable scheduler. A queued or running Run
// therefore has no executor after process restart and must become interrupted.
export const restartRecoveryStatus = (status: RunStatus): RunStatus => status === 'queued' || status === 'running' ? 'interrupted' : status
