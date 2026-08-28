import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { JsonObject, ToolDefinition } from './contracts.js'

type ConnectionRecord = JsonObject & { connection_id: string; name: string; transport: string; url_or_command: string; credentials: JsonObject; allowlist: string[] }
type Active = { client: Client; transport: Transport; tools: ToolDefinition[]; record: ConnectionRecord; fingerprint: string }

export class McpManager {
  private active = new Map<string, Active>()
  private secrets = new Map<string, string>()
  private secretRevision = 0

  setSecrets(values: Map<string, string>) { this.secrets = new Map(values); this.secretRevision += 1; void this.invalidate() }
  private hydrate(value: unknown): unknown {
    if (typeof value === 'string' && value.startsWith('secret://')) return this.secrets.get(value.slice('secret://'.length)) || ''
    if (Array.isArray(value)) return value.map(item => this.hydrate(item))
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as JsonObject).map(([key, item]) => [key, this.hydrate(item)]))
    return value
  }

  private fingerprint(record: ConnectionRecord) { return JSON.stringify({ transport: record.transport, target: record.url_or_command, credentials: record.credentials, allowlist: record.allowlist, secretRevision: this.secretRevision }) }

  private async disconnect(connectionId: string) {
    const cached = this.active.get(connectionId)
    if (!cached) return
    this.active.delete(connectionId)
    try { await cached.transport.close() } catch { /* already disconnected */ }
  }
  async invalidate(connectionId?: string) { await Promise.all((connectionId ? [connectionId] : [...this.active.keys()]).map(id => this.disconnect(id))) }

  private async connect(record: ConnectionRecord): Promise<Active> {
    const cached = this.active.get(record.connection_id)
    const fingerprint = this.fingerprint(record)
    if (cached?.fingerprint === fingerprint) return cached
    if (cached) await this.disconnect(record.connection_id)
    const credentials = this.hydrate(record.credentials || {}) as JsonObject; const transportName = String(record.transport || 'http').toLowerCase()
    let transport: Transport
    if (transportName === 'stdio') {
      transport = new StdioClientTransport({ command: String(record.url_or_command), args: Array.isArray(credentials.args) ? credentials.args.map(String) : [], env: Object.fromEntries(Object.entries((credentials.env as JsonObject) || {}).map(([key, value]) => [key, String(value)])), stderr: 'pipe' })
    } else if (transportName === 'sse') {
      const headers = Object.fromEntries(Object.entries((credentials.headers as JsonObject) || {}).map(([key, value]) => [key, String(value)]))
      transport = new SSEClientTransport(new URL(String(record.url_or_command)), { requestInit: { headers } })
    } else {
      const headers = Object.fromEntries(Object.entries((credentials.headers as JsonObject) || {}).map(([key, value]) => [key, String(value)]))
      transport = new StreamableHTTPClientTransport(new URL(String(record.url_or_command)), { requestInit: { headers } })
    }
    const client = new Client({ name: 'tugo-runtime', version: '2.0.0' }, { capabilities: {} })
    await client.connect(transport, { timeout: 20_000 })
    const listed = await client.listTools(undefined, { timeout: 20_000 })
    const allow = new Set(record.allowlist || [])
    const prefix = String(record.name).replace(/[^a-zA-Z0-9_-]/g, '_')
    const tools: ToolDefinition[] = listed.tools.filter(tool => !allow.size || allow.has(tool.name)).map(tool => ({ name: `${prefix}__${tool.name}`, description: `[MCP ${record.name}] ${tool.description || tool.name}`, inputSchema: (tool.inputSchema || { type: 'object' }) as JsonObject, source: 'mcp', connectionId: record.connection_id, handlerKey: tool.name, timeoutMs: 30_000 }))
    const active = { client, transport, tools, record, fingerprint }; this.active.set(record.connection_id, active); return active
  }

  async tools(records: ConnectionRecord[]) {
    const groups = await Promise.allSettled(records.map(record => this.connect(record)))
    return groups.flatMap(group => group.status === 'fulfilled' ? group.value.tools : [])
  }
  async call(tool: ToolDefinition, args: JsonObject, signal: AbortSignal) {
    if (!tool.connectionId) throw new Error('MCP tool has no connection id')
    const active = this.active.get(tool.connectionId)
    if (!active) throw new Error('MCP connection is not active')
    try {
      const result = await active.client.callTool({ name: String(tool.handlerKey), arguments: args }, undefined, { signal, timeout: tool.timeoutMs, maxTotalTimeout: tool.timeoutMs })
      if (result.isError) throw new Error(JSON.stringify(result.content).slice(0, 4000))
      return result
    } catch (error) {
      await this.disconnect(tool.connectionId)
      throw error
    }
  }

  async test(record: ConnectionRecord) { const active = await this.connect(record); return { ok: true, tools: active.tools.map(tool => ({ name: tool.handlerKey || tool.name, exposed_name: tool.name, description: tool.description })) } }
  async close() { await Promise.all([...this.active.keys()].map(id => this.disconnect(id))) }
}
