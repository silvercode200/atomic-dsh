/**
 * Minimal real MCP stdio server for the activation E2E test: one tool
 * "echo" that returns its input as text. Speaks the actual MCP protocol
 * over stdio via the official SDK.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from '@modelcontextprotocol/sdk/types.js'

const server = new Server({ name: 'echo-mcp-test-server', version: '0.0.1' }, { capabilities: { tools: {} } })

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'echo',
      description: 'Echo the input text back.',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
        additionalProperties: false
      }
    }
  ]
}))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== 'echo') throw new Error(`unknown tool: ${request.params.name}`)
  return { content: [{ type: 'text', text: `echo: ${request.params.arguments?.text ?? ''}` }] }
})

await server.connect(new StdioServerTransport())
