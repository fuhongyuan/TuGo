const { test } = require('node:test')
const assert = require('node:assert/strict')
const { mkdtemp, stat, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { startCliServer } = require('../electron/cli-server.cjs')
test('loopback auth, readiness, replay protection and serialized dispatch', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tugo-cli-unit-'))
  let ready = false, calls = 0, active = 0
  const server = await startCliServer({ directory, ready: () => ready, dispatch: async (method, params) => {
    assert.equal(active++, 0); calls++; await new Promise(r => setTimeout(r, 10)); active--; return params
  } })
  const request = async (id, method, params = {}, headers = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.port}/v1/command`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${server.token}`, ...headers }, body: JSON.stringify({ id, method, params }) })
    return { status: response.status, body: await response.json() }
  }
  try {
    assert.equal((await stat(join(directory, 'cli-endpoint.json'))).mode & 0o777, 0o600)
    assert.equal((await request('1', 'status', {}, { authorization: '' })).status, 403)
    assert.equal((await request('1', 'status', {}, { origin: 'https://example.com' })).status, 403)
    const badHost = await new Promise(resolve => {
      const req = require('node:http').request({ hostname: '127.0.0.1', port: server.port, path: '/v1/command', method: 'POST', headers: { host: 'example.com', authorization: `Bearer ${server.token}` } }, res => { res.resume(); resolve(res.statusCode) }); req.end('{}')
    })
    assert.equal(badHost, 403)
    assert.equal((await request('1', 'status')).body.result.ready, false)
    assert.equal((await request('1', 'edit')).status, 503)
    ready = true
    const results = await Promise.all([request('a', 'edit', { text: '中文图形' }), request('a', 'edit', { text: '中文图形' }), request('b', 'edit')])
    assert.equal(calls, 2); assert.deepEqual(results[0], results[1]); assert.equal(results[0].body.result.text, '中文图形')
    assert.equal((await request('a', 'edit', { different: true })).status, 409)
  } finally { await server.close(); await rm(directory, { recursive: true, force: true }) }
})
