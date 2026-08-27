import { parentPort, workerData } from 'node:worker_threads'
import type { HostToRuntime, JsonObject, RuntimeToHost } from './contracts.js'
import { PROTOCOL_VERSION } from './contracts.js'
import { TuGoRuntime } from './runtime.js'

if (!parentPort) throw new Error('TuGo Runtime must run in a Worker')
const port = parentPort
const send = (message: RuntimeToHost) => port.postMessage(message)
const runtime = new TuGoRuntime(String(workerData.dataDir), String(workerData.defaultsPath), send)

await runtime.start()
port.on('message', (message: HostToRuntime) => {
  if (message.kind === 'tool_result') { runtime.resolveHostTool(message); return }
  if (message.kind === 'shutdown') { void runtime.close().finally(() => process.exit(0)); return }
  if (message.kind !== 'request') return
  const params = message.params || {}
  void (async () => {
    try {
      let result: unknown
      if (message.method === 'runtime.http') {
        const method = String(params.method || 'GET').toUpperCase()
        result = await runtime.http(method, String(params.path || ''), params.body)
        if (method !== 'GET') await runtime.repository.flush()
      }
      else if (message.method === 'runtime.secrets.set') result = runtime.setSecrets((params.secrets || {}) as JsonObject)
      else if (message.method === 'runtime.secrets.export-legacy') result = runtime.exportLegacySecrets()
      else if (message.method === 'runtime.secrets.apply-references') { result = runtime.applySecretReferences((params.references || {}) as JsonObject); await runtime.repository.flush() }
      else if (message.method === 'run.start') result = runtime.startRun(params)
      else if (message.method === 'run.cancel') result = runtime.cancelRun(String(params.run_id || ''))
      else if (message.method === 'run.steer') result = runtime.steerRun(String(params.run_id || ''), String(params.content || ''), String(params.client_request_id || ''))
      else throw new Error(`Unknown runtime method: ${message.method}`)
      send({ kind: 'response', id: message.id, result })
    } catch (error) { send({ kind: 'response', id: message.id, error: error instanceof Error ? error.message : String(error) }) }
  })()
})

// Only announce readiness after the request listener is attached. The host
// sends secret/bootstrap RPCs immediately after `ready`; emitting first leaves
// a small startup race in which that first RPC can be lost and the desktop
// window waits for the full request timeout.
send({ kind: 'ready', protocol_version: PROTOCOL_VERSION })
