import { describe, expect, it } from 'vitest'
import { ConversationRunCoordinator } from './conversationRunCoordinator'

describe('ConversationRunCoordinator', () => {
  it('owns one abortable ephemeral run per conversation and clears it on completion', () => {
    const coordinator = new ConversationRunCoordinator()
    const controller = coordinator.begin('conversation-a')
    expect(() => coordinator.begin('conversation-a')).toThrow('运行中的任务')
    expect(coordinator.bindRuntimeRun('conversation-a', { threadId: 'thread-a', runId: 'run-a' })).toBe(true)
    expect(coordinator.active('conversation-a')).toEqual({ threadId: 'thread-a', runId: 'run-a' })
    expect(coordinator.cancel('conversation-a', 'timeout')).toEqual({ threadId: 'thread-a', runId: 'run-a' })
    expect(controller.signal).toMatchObject({ aborted: true, reason: 'timeout' })
    expect(coordinator.finish('conversation-a')).toEqual({ threadId: 'thread-a', runId: 'run-a' })
    expect(coordinator.has('conversation-a')).toBe(false)
  })

  it('does not revive an already-finished conversation from a late runtime event', () => {
    const coordinator = new ConversationRunCoordinator()
    coordinator.begin('conversation-a'); coordinator.finish('conversation-a')
    expect(coordinator.bindRuntimeRun('conversation-a', { threadId: 'thread-a', runId: 'late-run' })).toBe(false)
    expect(coordinator.active('conversation-a')).toBeUndefined()
  })
})

it('keeps a cancelled terminal message when a queued run publishes an older pending snapshot',()=>{
 const coordinator=new ConversationRunCoordinator()
 const pending={id:'old',role:'assistant' as const,content:'',createdAt:'',pending:true}
 const cancelled={...pending,pending:false,content:'已取消本次 AI 操作。'}
 coordinator.rememberTerminal('c',cancelled)
 const queued={id:'next',role:'assistant' as const,content:'',createdAt:'',pending:true}
 expect(coordinator.reconcileTerminal('c',[pending,queued])).toEqual([cancelled,queued])
 expect(coordinator.reconcileTerminal('other',[pending])).toEqual([pending])
 expect(coordinator.reconcileTerminal('c',[queued])).toEqual([queued])
})
