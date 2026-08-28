import { describe, expect, it } from 'vitest'
import { canTransitionRun, isRunStatus, isTerminalRunStatus, restartRecoveryStatus, RUN_STATUSES } from '../src/runState.js'

describe('Run state machine', () => {
  it('allows only the declared queued and running transitions', () => {
    const expected = new Set([
      'queued->running', 'queued->failed', 'queued->cancelled', 'queued->interrupted',
      'running->completed', 'running->failed', 'running->cancelled', 'running->interrupted',
    ])
    for (const from of RUN_STATUSES) for (const to of RUN_STATUSES) {
      expect(canTransitionRun(from, to), `${from}->${to}`).toBe(expected.has(`${from}->${to}`))
    }
  })

  it('makes every terminal state immutable', () => {
    for (const terminal of ['completed', 'failed', 'cancelled', 'interrupted'] as const) {
      expect(isTerminalRunStatus(terminal)).toBe(true)
      for (const target of RUN_STATUSES) expect(canTransitionRun(terminal, target)).toBe(false)
    }
  })

  it('interrupts executor-owned states on restart and preserves terminal history', () => {
    expect(restartRecoveryStatus('queued')).toBe('interrupted')
    expect(restartRecoveryStatus('running')).toBe('interrupted')
    for (const terminal of ['completed', 'failed', 'cancelled', 'interrupted'] as const) expect(restartRecoveryStatus(terminal)).toBe(terminal)
  })

  it('rejects values outside the persisted status vocabulary', () => {
    expect(isRunStatus('running')).toBe(true)
    expect(isRunStatus('success')).toBe(false)
    expect(isTerminalRunStatus('running')).toBe(false)
  })
})
