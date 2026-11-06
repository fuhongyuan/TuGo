const http = require('node:http')
const { randomBytes, timingSafeEqual } = require('node:crypto')
const { writeFile, rename, unlink, mkdir } = require('node:fs/promises')
const { join } = require('node:path')

// One process owns SQLite. The CLI only talks to that process, never opens it.
async function startCliServer({ directory, dispatch, ready = () => true }) {
  const token = randomBytes(32).toString('hex')
  const requests = new Map()
  let queue = Promise.resolve(), pending = 0
  const server = http.createServer(async (request, response) => {
    const send = (status, body) => { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(body)) }
    const fail = (status, code, message) => send(status, { ok: false, error: { code, message } })
    const supplied = Buffer.from(String(request.headers.authorization || ''))
    const expected = Buffer.from(`Bearer ${token}`)
    if (request.headers.origin || request.headers.host !== `127.0.0.1:${server.address().port}` || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return fail(403, 'UNAUTHORIZED', '本机凭证无效或不允许浏览器调用')
    if (request.method !== 'POST' || request.url !== '/v1/command') return fail(404, 'NOT_FOUND', 'Unknown endpoint')
    try {
      if (!String(request.headers['content-type']).startsWith('application/json')) return fail(415, 'INVALID_REQUEST', 'Content-Type must be application/json')
      const chunks = []; let bytes = 0
      for await (const chunk of request) { bytes += chunk.length; if (bytes > 16 * 1024 * 1024) { fail(413, 'TOO_LARGE', '请求超过 16 MB'); return } chunks.push(chunk) }
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (!input || typeof input.method !== 'string' || !input.params || typeof input.params !== 'object' || Array.isArray(input.params) || typeof input.id !== 'string' || input.id.length > 128 || !input.id) return fail(400, 'INVALID_REQUEST', 'Expected id, method and params object')
      if (input.method === 'status') return send(200, { ok: true, result: { product: 'TuGo', protocol: 1, ready: ready() } })
      if (!ready()) return fail(503, 'NOT_READY', '请打开 TuGo 窗口并等待加载完成')
      const fingerprint = JSON.stringify([input.method, input.params])
      const previous = requests.get(input.id)
      if (previous && previous.fingerprint !== fingerprint) return fail(409, 'REQUEST_ID_CONFLICT', '同一 request-id 不能用于不同命令')
      if (previous) return send(200, await previous.promise)
      if (pending >= 32) return fail(429, 'BUSY', '命令队列已满，请稍后重试')
      pending++
      const promise = queue.then(async () => {
        try { return { ok: true, result: await dispatch(input.method, input.params) } }
        catch (error) { return { ok: false, error: { code: 'COMMAND_FAILED', message: String(error.message || error) } } }
        finally { pending-- }
      })
      queue = promise.then(() => undefined)
      requests.set(input.id, { fingerprint, promise })
      // Completed replay protection is process-local and bounded.
      promise.then(() => { if (requests.size > 256) requests.delete(requests.keys().next().value) })
      send(200, await promise)
    } catch (error) { if (!response.headersSent) fail(400, 'INVALID_REQUEST', String(error.message || error)) }
  })
  server.requestTimeout = 20_000
  server.headersTimeout = 10_000
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const info = { protocol: 1, port: server.address().port, token, pid: process.pid }
  const path = join(directory, 'cli-endpoint.json'), temporary = `${path}.${process.pid}.tmp`
  await mkdir(directory, { recursive: true })
  await writeFile(temporary, JSON.stringify(info), { mode: 0o600 })
  await rename(temporary, path)
  return { ...info, close: async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await unlink(path).catch(() => {}) } }
}
module.exports = { startCliServer }
