import { LanceDB } from '../plugin'

export interface DeviceTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  execute: (args: Record<string, unknown>) => Promise<unknown>
}

export const memoryTools: DeviceTool[] = [
  {
    name: 'memory_store',
    description:
      'Store a text chunk with its embedding vector in persistent on-device memory. If a key already exists it is overwritten.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Unique identifier for this memory entry' },
        agentId: { type: 'string', description: 'Agent that owns this memory (e.g. "main")' },
        text: { type: 'string', description: 'The text content to store' },
        embedding: {
          type: 'array',
          items: { type: 'number' },
          description: 'Float32 embedding vector',
        },
        metadata: {
          type: 'string',
          description: 'Optional JSON metadata blob',
        },
      },
      required: ['key', 'agentId', 'text', 'embedding'],
      additionalProperties: false,
    },
    execute: async (args) => {
      await LanceDB.memoryStore({
        key: args.key as string,
        agentId: args.agentId as string,
        text: args.text as string,
        embedding: args.embedding as number[],
        metadata: args.metadata as string | undefined,
      })
      return { success: true }
    },
  },
  {
    name: 'memory_search',
    description:
      'Search for semantically similar memories using a query embedding vector. Returns the top-k nearest neighbours with distance scores.',
    inputSchema: {
      type: 'object',
      properties: {
        queryVector: {
          type: 'array',
          items: { type: 'number' },
          description: 'Float32 query embedding vector',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results to return (default: 5)',
        },
        filter: {
          type: 'string',
          description: 'Optional SQL-like filter predicate (e.g. "agent_id = \'main\'")',
        },
      },
      required: ['queryVector'],
      additionalProperties: false,
    },
    execute: async (args) => {
      const result = await LanceDB.memorySearch({
        queryVector: args.queryVector as number[],
        limit: (args.limit as number) ?? 5,
        filter: args.filter as string | undefined,
      })
      return result
    },
  },
  {
    name: 'memory_delete',
    description: 'Delete a specific memory entry by its key.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Key of the memory entry to delete' },
      },
      required: ['key'],
      additionalProperties: false,
    },
    execute: async (args) => {
      await LanceDB.memoryDelete({ key: args.key as string })
      return { success: true }
    },
  },
  {
    name: 'memory_list',
    description: 'List memory keys, optionally filtered by a key prefix.',
    inputSchema: {
      type: 'object',
      properties: {
        prefix: { type: 'string', description: 'Only return keys starting with this prefix' },
        limit: { type: 'number', description: 'Maximum number of keys to return' },
      },
      additionalProperties: false,
    },
    execute: async (args) => {
      const result = await LanceDB.memoryList({
        prefix: args.prefix as string | undefined,
        limit: args.limit as number | undefined,
      })
      return result
    },
  },
  {
    name: 'memory_clear',
    description: 'Drop all data from the memory table. Optionally specify a named collection.',
    inputSchema: {
      type: 'object',
      properties: {
        collection: { type: 'string', description: 'Named collection to clear (default: memories)' },
      },
      additionalProperties: false,
    },
    execute: async (args) => {
      await LanceDB.memoryClear({
        collection: args.collection as string | undefined,
      })
      return { success: true }
    },
  },
]
