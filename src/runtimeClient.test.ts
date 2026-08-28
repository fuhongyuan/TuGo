import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const { EmbeddedRuntimeClient } = require('../electron/runtime-client.cjs') as { EmbeddedRuntimeClient: new (options: Record<string, unknown>) => any }

class FakeWorker extends EventEmitter {
  static instances: FakeWorker[] = []
  static failReplayOnce = false
  requests: Array<Record<string, unknown>> = []
  constructor() {
    super(); FakeWorker.instances.push(this)
    queueMicrotask(() => this.emit('message', { kind: 'ready', protocol_version: 'test' }))
  }
  postMessage(message: Record<string, any>) {
    if (message.kind === 'shutdown') { queueMicrotask(() => this.emit('exit', 0)); return }
    if (message.kind !== 'request') return
    this.requests.push(message)
    if (message.method === 'runtime.secrets.set' && FakeWorker.failReplayOnce && FakeWorker.instances.indexOf(this) > 0) {
      FakeWorker.failReplayOnce = false
      queueMicrotask(() => this.emit('message', { kind: 'response', id: message.id, error: 'invalid replay fixture' }))
      return
    }
    const result = message.method === 'run.start' ? { run_id: 'run-1', subscription_id: 'sub-1' } : { ok: true }
    queueMicrotask(() => this.emit('message', { kind: 'response', id: message.id, result }))
  }
  terminate() { this.emit('exit', 0); return Promise.resolve(0) }
  crash() { this.emit('exit', 9) }
}

describe('EmbeddedRuntimeClient recovery', () => {
  it('restarts an unexpected Worker exit and replays in-memory secrets', async () => {
    FakeWorker.instances = []; FakeWorker.failReplayOnce = false
    const onEvent = vi.fn(); const onStreamEnd = vi.fn()
    const client = new EmbeddedRuntimeClient({
      app: { isPackaged: false, getPath: () => '/tmp/tugo-runtime-client-test' }, projectRoot: '/tmp/project',
      log: async () => undefined, onEvent, onStreamEnd, onToolCall: async () => ({}), WorkerClass: FakeWorker,
    })
    await client.start()
    await client.request('runtime.secrets.set', { secrets: { key: 'secret-value' } })
    await client.request('run.start', {})
    FakeWorker.instances[0].crash()
    const deadline = Date.now() + 2_000
    while (FakeWorker.instances.length < 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
    expect(FakeWorker.instances).toHaveLength(2)
    const replay = FakeWorker.instances[1].requests.find(item => item.method === 'runtime.secrets.set')
    expect(replay?.params).toEqual({ secrets: { key: 'secret-value' } })
    expect(onEvent).toHaveBeenCalledWith('sub-1', expect.objectContaining({ type: 'session.failed', run_id: 'run-1' }))
    expect(onStreamEnd).toHaveBeenCalledWith('sub-1', 'run-1')
    await expect(client.request('runtime.http', {})).resolves.toEqual({ ok: true })
    await client.stop()
  })

  it('terminates a half-ready Worker when secret replay fails and retries through the circuit', async () => {
    FakeWorker.instances = []; FakeWorker.failReplayOnce = false
    const client = new EmbeddedRuntimeClient({
      app: { isPackaged: false, getPath: () => '/tmp/tugo-runtime-client-replay-test' }, projectRoot: '/tmp/project',
      log: async () => undefined, onEvent: vi.fn(), onStreamEnd: vi.fn(), onToolCall: async () => ({}), WorkerClass: FakeWorker,
    })
    await client.start(); await client.request('runtime.secrets.set', { secrets: { key: 'secret-value' } })
    FakeWorker.failReplayOnce = true; FakeWorker.instances[0].crash()
    const deadline = Date.now() + 3_000
    while (FakeWorker.instances.length < 3 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
    expect(FakeWorker.instances).toHaveLength(3)
    expect(FakeWorker.instances[2].requests.find(item => item.method === 'runtime.secrets.set')?.params).toEqual({ secrets: { key: 'secret-value' } })
    await expect(client.request('runtime.http', {})).resolves.toEqual({ ok: true })
    await client.stop()
  })

  it('does not spawn a replacement Worker after shutdown starts', async () => {
    FakeWorker.instances = []; FakeWorker.failReplayOnce = false
    const client = new EmbeddedRuntimeClient({
      app: { isPackaged: false, getPath: () => '/tmp/tugo-runtime-client-shutdown-test' }, projectRoot: '/tmp/project',
      log: async () => undefined, onEvent: vi.fn(), onStreamEnd: vi.fn(), onToolCall: async () => ({}), WorkerClass: FakeWorker,
    })
    await client.start()
    await client.stop()
    await expect(client.request('runtime.http', {})).rejects.toThrow('shutting down')
    expect(FakeWorker.instances).toHaveLength(1)
  })
})
