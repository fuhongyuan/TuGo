// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { createServer, type Server as HttpServer } from 'node:http'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { McpManager } from '../src/mcp.js'

const managers: McpManager[] = []
const servers: HttpServer[] = []
afterEach(async () => {
  await Promise.all(managers.splice(0).map(manager => manager.close()))
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolveClose => server.close(() => resolveClose()))))
})

const protocolServer = () => {
  const server = new Server({ name: 'tugo-http-fixture', version: '1.0.0' }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
    { name: 'echo', description: 'Echo', inputSchema: { type: 'object', properties: { value: { type: 'string' } } } },
    { name: 'hidden', description: 'Hidden', inputSchema: { type: 'object' } },
  ] }))
  server.setRequestHandler(CallToolRequestSchema, async request => ({ content: [{ type: 'text', text: `echo:${String(request.params.arguments?.value || '')}` }] }))
  return server
}

const listen = async (server: HttpServer) => {
  await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', resolveListen)); servers.push(server)
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('fixture did not listen')
  return `http://127.0.0.1:${address.port}`
}

describe('McpManager stdio integration', () => {
  it('performs a real initialize, tools/list and tools/call exchange', async () => {
    const manager = new McpManager(); managers.push(manager)
    const fixture = resolve(process.cwd(), 'runtime-ts/tests/fixtures/mcp-stdio-server.mjs')
    const record = { connection_id: 'fixture', name: 'fixture', transport: 'stdio', url_or_command: process.execPath, credentials: { args: [fixture] }, allowlist: [] }
    const tested = await manager.test(record)
    expect(tested).toMatchObject({ ok: true, tools: [{ name: 'echo', exposed_name: 'fixture__echo' }, { name: 'slow', exposed_name: 'fixture__slow' }] })
    const tools = await manager.tools([record])
    const result = await manager.call(tools[0], { value: 'hello' }, new AbortController().signal)
    expect(result).toMatchObject({ content: [{ type: 'text', text: 'echo:hello' }] })
    const slow = tools.find(tool => tool.handlerKey === 'slow')!
    await expect(manager.call({ ...slow, timeoutMs: 20 }, {}, new AbortController().signal)).rejects.toThrow(/timeout|timed out/i)
  })

  it('supports real Streamable HTTP, credentials, reconnect and allowlist', async () => {
    let expectedToken = 'alpha'
    const server = createServer(async (request, response) => {
      if (request.headers.authorization !== `Bearer ${expectedToken}`) { response.writeHead(401).end('unauthorized'); return }
      let body = ''; for await (const chunk of request) body += chunk
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
      const protocol = protocolServer(); await protocol.connect(transport)
      try { await transport.handleRequest(request, response, body ? JSON.parse(body) : undefined) }
      finally { await transport.close(); await protocol.close() }
    })
    const base = await listen(server); const manager = new McpManager(); managers.push(manager)
    manager.setSecrets(new Map([['http-token', 'Bearer alpha']]))
    const record = { connection_id: 'http-fixture', name: 'http_fixture', transport: 'http', url_or_command: `${base}/mcp`, credentials: { headers: { Authorization: 'secret://http-token' } }, allowlist: ['echo'] }
    await manager.test(record)
    let tools = await manager.tools([record]); expect(tools.map(tool => tool.handlerKey)).toEqual(['echo'])
    expectedToken = 'beta'; manager.setSecrets(new Map([['http-token', 'Bearer beta']]))
    tools = await manager.tools([record])
    expect(await manager.call(tools[0], { value: 'http' }, new AbortController().signal)).toMatchObject({ content: [{ text: 'echo:http' }] })
  })

  it('supports the real SSE transport and isolates a broken connection', async () => {
    const transports = new Map<string, SSEServerTransport>()
    const server = createServer(async (request, response) => {
      const url = new URL(request.url || '/', 'http://fixture')
      if (request.method === 'GET' && url.pathname === '/sse') {
        const transport = new SSEServerTransport('/messages', response); transports.set(transport.sessionId, transport); transport.onclose = () => transports.delete(transport.sessionId); await protocolServer().connect(transport); return
      }
      if (request.method === 'POST' && url.pathname === '/messages') {
        const transport = transports.get(String(url.searchParams.get('sessionId'))); if (!transport) { response.writeHead(404).end(); return }
        let body = ''; for await (const chunk of request) body += chunk
        await transport.handlePostMessage(request, response, body ? JSON.parse(body) : undefined); return
      }
      response.writeHead(404).end()
    })
    const base = await listen(server); const manager = new McpManager(); managers.push(manager)
    const good = { connection_id: 'sse-fixture', name: 'sse_fixture', transport: 'sse', url_or_command: `${base}/sse`, credentials: {}, allowlist: ['echo'] }
    const broken = { connection_id: 'broken', name: 'broken', transport: 'http', url_or_command: 'http://127.0.0.1:1/mcp', credentials: {}, allowlist: [] }
    await manager.test(good)
    const tools = await manager.tools([broken, good])
    expect(tools.map(tool => tool.name)).toEqual(['sse_fixture__echo'])
    expect(await manager.call(tools[0], { value: 'sse' }, new AbortController().signal)).toMatchObject({ content: [{ text: 'echo:sse' }] })
  })
})
