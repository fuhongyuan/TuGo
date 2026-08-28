const { Worker } = require('node:worker_threads')
const { join } = require('node:path')
const { randomUUID } = require('node:crypto')

class EmbeddedRuntimeClient {
  constructor({ app, projectRoot, log, onEvent, onStreamEnd, onToolCall, WorkerClass = Worker }) {
    this.app = app
    this.projectRoot = projectRoot
    this.log = log
    this.onEvent = onEvent
    this.onStreamEnd = onStreamEnd
    this.onToolCall = onToolCall
    this.WorkerClass = WorkerClass
    this.worker = null
    this.pending = new Map()
    this.subscriptions = new Map()
    this.ready = null
    this.resolveReady = null
    this.rejectReady = null
    this.stopping = false
    this.restartTimer = null
    this.restartAttempts = []
    this.secretSnapshot = null
  }

  runtimePaths() {
    const root = this.app.isPackaged ? join(__dirname, '..') : this.projectRoot
    return {
      workerPath: join(root, 'runtime-ts', 'dist', 'worker.js'),
      defaultsPath: join(root, 'templates', 'runtime-defaults.json'),
      dataDir: join(this.app.getPath('userData'), 'runtime'),
    }
  }

  async start() {
    if (this.stopping) throw new Error('TypeScript Runtime is shutting down')
    // `request()` is called concurrently during renderer bootstrap.  The old
    // check only became true *after* the async log write below, so every
    // caller in that small window could create its own Runtime Worker.  Apart
    // from racing the SQLite files, dozens of workers restoring journals can
    // exhaust the JS heap.  `ready` is assigned synchronously and is the
    // single-flight marker for both a starting and a ready worker.
    if (this.worker || this.ready) return this.ready
    this.stopping = false
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null }
    const paths = this.runtimePaths()
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject })
    await this.log(`typescript runtime worker spawn file=${paths.workerPath}`)
    const worker = new this.WorkerClass(paths.workerPath, { workerData: { dataDir: paths.dataDir, defaultsPath: paths.defaultsPath }, name: 'tugo-runtime' })
    this.worker = worker
    worker.on('message', message => { void this.handleMessage(message) })
    worker.on('error', error => { this.rejectReady?.(error); void this.log(`runtime worker error ${error.stack || error.message}`) })
    worker.on('exit', code => {
      if (this.worker !== worker && this.worker !== null) return
      const error = new Error(`TypeScript Runtime worker exited (code=${code})`)
      if (code !== 0) this.rejectReady?.(error)
      for (const pending of this.pending.values()) pending.reject(error)
      this.pending.clear(); this.worker = null; this.ready = null
      for (const [runId, subscriptionId] of this.subscriptions) {
        this.onEvent(subscriptionId, {
          protocol_version: '2026-07-13', event_id: `evt_${runId}_runtime_exit`, sequence: Number.MAX_SAFE_INTEGER,
          ts: new Date().toISOString(), thread_id: '', run_id: runId, type: 'session.failed', agent_id: null, message_id: null, tool_call_id: null,
          payload: { status: 'failed', error_type: 'RuntimeWorkerExit', error_detail: error.message, message: error.message },
        })
        this.onStreamEnd(subscriptionId, runId)
      }
      this.subscriptions.clear()
      void this.log(error.message)
      if (!this.stopping) this.scheduleRestart()
    })
    const timeout = setTimeout(() => this.rejectReady?.(new Error('TypeScript Runtime startup timed out')), 30_000)
    try {
      await this.ready
      if (this.secretSnapshot) await this.request('runtime.secrets.set', { secrets: this.secretSnapshot })
      // A restart is only healthy after the runtime has also accepted the
      // encrypted-secret snapshot. Resetting before replay would let a broken
      // snapshot restart forever without ever opening the circuit breaker.
      this.restartAttempts = []
    } catch (error) {
      // A Worker that cannot finish initialization (including secret replay)
      // is not healthy. Terminating it feeds the failure back through the same
      // bounded restart circuit instead of leaving a half-ready Worker behind.
      if (this.worker === worker) await worker.terminate().catch(() => undefined)
      throw error
    } finally { clearTimeout(timeout) }
  }

  scheduleRestart() {
    if (this.stopping || this.restartTimer || this.worker) return
    const current = Date.now()
    this.restartAttempts = this.restartAttempts.filter(value => current - value < 60_000)
    const attempt = this.restartAttempts.length + 1
    if (attempt > 5) { void this.log('runtime worker restart circuit opened after 5 failures in 60s'); return }
    this.restartAttempts.push(current)
    const delay = Math.min(5_000, 250 * (2 ** (attempt - 1)))
    void this.log(`runtime worker restart scheduled attempt=${attempt} delay_ms=${delay}`)
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      void this.start().then(() => this.log('runtime worker restart completed')).catch(error => {
        void this.log(`runtime worker restart failed ${String(error?.stack || error)}`)
        this.scheduleRestart()
      })
    }, delay)
  }

  send(message) {
    if (!this.worker) throw new Error('TypeScript Runtime is not running')
    this.worker.postMessage(message)
    if (message.kind === 'request') void this.log(`runtime request posted method=${message.method} id=${message.id}`)
  }

  async handleMessage(message) {
    if (message.kind === 'ready') { await this.log(`typescript runtime ready protocol=${message.protocol_version}`); this.resolveReady?.(true); return }
    if (message.kind === 'response') { const pending = this.pending.get(message.id); if (!pending) { await this.log(`runtime response has no pending request id=${message.id}`); return }; await this.log(`runtime response received method=${pending.method} id=${message.id}`); this.pending.delete(message.id); if (!message.error && pending.method === 'run.start' && message.result?.run_id && message.result?.subscription_id) this.subscriptions.set(String(message.result.run_id), String(message.result.subscription_id)); message.error ? pending.reject(new Error(message.error)) : pending.resolve(message.result); return }
    if (message.kind === 'event') { this.onEvent(message.subscription_id, message.event); return }
    if (message.kind === 'stream_end') { this.subscriptions.delete(String(message.run_id)); this.onStreamEnd(message.subscription_id, message.run_id); return }
    if (message.kind === 'tool_call') {
      try { const result = await this.onToolCall(message.name, message.args || {}, message.context || {}); this.send({ kind: 'tool_result', id: message.id, result }) }
      catch (error) { this.send({ kind: 'tool_result', id: message.id, error: error instanceof Error ? error.message : String(error) }) }
    }
  }

  async request(method, params = {}) {
    if (this.stopping) throw new Error('TypeScript Runtime is shutting down')
    await this.start()
    if (this.stopping || !this.worker) throw new Error('TypeScript Runtime is shutting down')
    const id = `rpc_${randomUUID()}`
    await this.log(`runtime request started method=${method} id=${id}`)
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        void this.log(`runtime request timed out method=${method} id=${id}`)
        reject(new Error(`TypeScript Runtime request timed out: ${method}`))
      }, method === 'run.start' ? 30_000 : method === 'runtime.http' && String(params?.path || '').split('?', 1)[0] === '/api/models/test' ? 35_000 : 60_000)
      this.pending.set(id, {
        method,
        resolve: value => { clearTimeout(timer); void this.log(`runtime request completed method=${method} id=${id}`); resolve(value) },
        reject: error => { clearTimeout(timer); void this.log(`runtime request failed method=${method} id=${id} error=${String(error?.message || error)}`); reject(error) },
      })
      try { this.send({ kind: 'request', id, method, params }) } catch (error) { this.pending.delete(id); clearTimeout(timer); reject(error) }
    })
    if (method === 'runtime.secrets.set') this.secretSnapshot = { ...(params.secrets || {}) }
    return result
  }

  // A Run is useful only while its renderer can receive both the progress
  // stream and board-tool callbacks.  macOS keeps the application process
  // alive after its last window closes, so explicitly abort the subscriptions
  // instead of leaving durable rows in `running` forever.
  async cancelRunsForRendererLoss() {
    const runIds = [...this.subscriptions.keys()]
    await Promise.allSettled(runIds.map(runId => this.request('run.cancel', { run_id: runId })))
    return { cancelled: runIds.length }
  }

  async stop() {
    this.stopping = true
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null }
    const error = new Error('TypeScript Runtime is shutting down')
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
    if (!this.worker) { this.ready = null; return }
    const worker = this.worker; this.worker = null
    const exit = new Promise(resolve => worker.once('exit', resolve))
    worker.postMessage({ kind: 'shutdown' })
    const completed = await Promise.race([exit.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 5000))])
    if (!completed) await worker.terminate()
    this.ready = null
  }
}

module.exports = { EmbeddedRuntimeClient }
