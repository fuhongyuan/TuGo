import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const server = new Server({ name: 'tugo-test-mcp', version: '1.0.0' }, { capabilities: { tools: {} } })
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
  { name: 'echo', description: 'Echo a value', inputSchema: { type: 'object', required: ['value'], properties: { value: { type: 'string' } } } },
  { name: 'slow', description: 'Slow fixture', inputSchema: { type: 'object' } },
] }))
server.setRequestHandler(CallToolRequestSchema, async request => {
  if (request.params.name === 'slow') await new Promise(resolve => setTimeout(resolve, 200))
  return { content: [{ type: 'text', text: `echo:${String(request.params.arguments?.value || '')}` }] }
})
await server.connect(new StdioServerTransport())
