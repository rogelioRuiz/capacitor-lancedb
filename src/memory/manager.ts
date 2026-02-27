/**
 * MemoryManager — high-level memory system for mobile-claw.
 *
 * Wraps the raw capacitor-lancedb plugin with:
 * - Embedding generation (OpenAI API or local hash fallback)
 * - High-level agent tools (recall, store, forget, search, get)
 * - Auto-recall (inject relevant memories before each turn)
 * - Auto-capture (detect and store memorable content after each turn)
 * - File indexing (chunk MEMORY.md + memory/*.md into LanceDB)
 * - Memory flush prompt (pre-compaction durable memory save)
 *
 * Ported from OpenClaw's memory-lancedb extension + memory-search + memory-flush.
 */

import { LanceDB } from '../plugin'
import { indexWorkspaceMemory } from './indexer'
import { detectCategory, formatRelevantMemoriesContext, looksLikePromptInjection, shouldCapture } from './security'
import {
  DEFAULT_CAPTURE_MAX_CHARS,
  DEFAULT_DB_PATH,
  DEFAULT_DUP_THRESHOLD,
  DEFAULT_EMBEDDING_DIM,
  DEFAULT_RECALL_LIMIT,
  DEFAULT_RECALL_MIN_SCORE,
  type DeviceTool,
  type MemoryCategory,
  type MemoryManagerConfig,
} from './types'

// ── Embedding helpers ────────────────────────────────────────────────────────

/**
 * FNV-1a hash for deterministic random-projection embedding fallback.
 */
function fnv1a(str: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i)
    hash = (hash * 0x01000193) >>> 0
  }
  return hash
}

/**
 * Seeded pseudo-random number from two integers.
 * Returns a value in [-1, 1].
 */
function seededRandom(seed: number, dim: number): number {
  let h = seed ^ (dim * 2654435761)
  h = ((h >>> 16) ^ h) * 0x45d9f3b
  h = ((h >>> 16) ^ h) * 0x45d9f3b
  h = (h >>> 16) ^ h
  return (h / 0xffffffff) * 2 - 1
}

/**
 * Local hash-based embedding (deterministic random projection).
 * Lower quality than neural embeddings but works fully offline.
 */
function localHashEmbed(text: string, dim: number): number[] {
  const tokens = text.toLowerCase().split(/\s+/).filter(Boolean)
  const vec = new Float32Array(dim)
  for (const token of tokens) {
    const hash = fnv1a(token)
    for (let i = 0; i < dim; i++) {
      vec[i] += seededRandom(hash, i)
    }
  }
  // L2 normalize
  let norm = 0
  for (let i = 0; i < dim; i++) norm += vec[i] * vec[i]
  norm = Math.sqrt(norm) || 1
  const result: number[] = new Array(dim)
  for (let i = 0; i < dim; i++) result[i] = vec[i] / norm
  return result
}

// ── MemoryManager ────────────────────────────────────────────────────────────

export class MemoryManager {
  private _initialized = false
  private _initPromise: Promise<void> | null = null
  private _config: Required<
    Pick<
      MemoryManagerConfig,
      | 'embeddingDim'
      | 'dbPath'
      | 'agentId'
      | 'autoRecall'
      | 'autoCapture'
      | 'recallLimit'
      | 'recallMinScore'
      | 'captureMaxChars'
      | 'dupThreshold'
    >
  > & { openaiApiKey?: string; httpRequest?: MemoryManagerConfig['httpRequest'] } = {
    embeddingDim: DEFAULT_EMBEDDING_DIM,
    dbPath: DEFAULT_DB_PATH,
    agentId: 'main',
    autoRecall: true,
    autoCapture: true,
    recallLimit: DEFAULT_RECALL_LIMIT,
    recallMinScore: DEFAULT_RECALL_MIN_SCORE,
    captureMaxChars: DEFAULT_CAPTURE_MAX_CHARS,
    dupThreshold: DEFAULT_DUP_THRESHOLD,
  }

  get initialized(): boolean {
    return this._initialized
  }

  // ── Init ─────────────────────────────────────────────────────────────────

  async init(config: MemoryManagerConfig = {}): Promise<void> {
    if (this._initPromise) return this._initPromise
    this._initPromise = this._doInit(config)
    return this._initPromise
  }

  private async _doInit(config: MemoryManagerConfig): Promise<void> {
    this._config = {
      embeddingDim: config.embeddingDim ?? DEFAULT_EMBEDDING_DIM,
      dbPath: config.dbPath ?? DEFAULT_DB_PATH,
      agentId: config.agentId ?? 'main',
      openaiApiKey: config.openaiApiKey,
      autoRecall: config.autoRecall ?? true,
      autoCapture: config.autoCapture ?? true,
      recallLimit: config.recallLimit ?? DEFAULT_RECALL_LIMIT,
      recallMinScore: config.recallMinScore ?? DEFAULT_RECALL_MIN_SCORE,
      captureMaxChars: config.captureMaxChars ?? DEFAULT_CAPTURE_MAX_CHARS,
      dupThreshold: config.dupThreshold ?? DEFAULT_DUP_THRESHOLD,
      httpRequest: config.httpRequest,
    }

    // On native platforms, relative paths must be resolved under the app's
    // private files directory via the "files://" prefix understood by the
    // Kotlin/Swift bridge.  Absolute paths and already-prefixed paths pass through.
    let resolvedPath = this._config.dbPath
    if (!resolvedPath.startsWith('/') && !resolvedPath.startsWith('files://')) {
      resolvedPath = `files://${resolvedPath}`
    }

    await LanceDB.open({
      dbPath: resolvedPath,
      embeddingDim: this._config.embeddingDim,
    })

    this._initialized = true
  }

  /** Update config at runtime (e.g. after user sets an API key). */
  updateConfig(partial: Partial<MemoryManagerConfig>): void {
    if (partial.openaiApiKey !== undefined) this._config.openaiApiKey = partial.openaiApiKey
    if (partial.autoRecall !== undefined) this._config.autoRecall = partial.autoRecall
    if (partial.autoCapture !== undefined) this._config.autoCapture = partial.autoCapture
    if (partial.httpRequest !== undefined) this._config.httpRequest = partial.httpRequest
  }

  // ── Embedding ────────────────────────────────────────────────────────────

  async embed(text: string): Promise<number[]> {
    if (this._config.openaiApiKey) {
      return this._embedOpenAI(text)
    }
    return localHashEmbed(text, this._config.embeddingDim)
  }

  private async _embedOpenAI(text: string): Promise<number[]> {
    const body = JSON.stringify({
      model: 'text-embedding-3-small',
      input: text,
    })
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this._config.openaiApiKey}`,
      'Content-Type': 'application/json',
    }

    let data: any

    if (this._config.httpRequest) {
      // Use injectable HTTP client (CORS bypass on mobile)
      const resp = await this._config.httpRequest({
        url: 'https://api.openai.com/v1/embeddings',
        method: 'POST',
        headers,
        body,
        timeout: 15000,
      })
      data = typeof resp.body === 'string' ? JSON.parse(resp.body) : resp.body
    } else {
      // Standard fetch (web / tests)
      const resp = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(15000),
      })
      data = await resp.json()
    }

    if (data?.error) {
      throw new Error(`OpenAI embedding error: ${data.error.message || JSON.stringify(data.error)}`)
    }
    return data.data[0].embedding
  }

  // ── Auto-Recall ──────────────────────────────────────────────────────────

  /**
   * Search for memories relevant to the prompt and return a formatted
   * context block, or null if nothing relevant is found.
   */
  async recall(prompt: string): Promise<string | null> {
    if (!this._initialized || !this._config.autoRecall) return null
    if (!prompt || prompt.length < 5) return null

    try {
      const vector = await Promise.race([
        this.embed(prompt),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000)),
      ])

      const { results } = await LanceDB.search({
        queryVector: vector,
        limit: this._config.recallLimit,
      })

      const relevant = results.filter((r) => r.score >= this._config.recallMinScore)
      if (relevant.length === 0) return null

      return formatRelevantMemoriesContext(
        relevant.map((r) => {
          const meta = r.metadata ? JSON.parse(r.metadata) : {}
          return { category: (meta.category as MemoryCategory) || 'other', text: r.text }
        }),
      )
    } catch {
      return null
    }
  }

  // ── Auto-Capture ─────────────────────────────────────────────────────────

  /**
   * Analyze a user message and auto-store if it contains memorable content.
   */
  async capture(text: string): Promise<boolean> {
    if (!this._initialized || !this._config.autoCapture) return false
    if (!shouldCapture(text, { maxChars: this._config.captureMaxChars })) return false

    try {
      const category = detectCategory(text)
      const vector = await this.embed(text)

      // Duplicate check
      const { results } = await LanceDB.search({ queryVector: vector, limit: 1 })
      if (results.length > 0 && results[0].score >= this._config.dupThreshold) return false

      const key = `auto-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      await LanceDB.store({
        key,
        agentId: this._config.agentId,
        text,
        embedding: vector,
        metadata: JSON.stringify({ category, importance: 0.7, auto: true }),
      })
      return true
    } catch {
      return false
    }
  }

  // ── File Indexing ────────────────────────────────────────────────────────

  /**
   * Index workspace memory files (MEMORY.md + memory/*.md) into LanceDB.
   */
  async indexFiles(
    readFile: (path: string) => Promise<{ content: string }>,
    listFiles: (path: string) => Promise<{ files: Array<{ name: string; type: string }> }>,
  ): Promise<{ indexed: number; errors: string[] }> {
    if (!this._initialized) return { indexed: 0, errors: ['MemoryManager not initialized'] }
    return indexWorkspaceMemory(readFile, listFiles, (text) => this.embed(text), this._config.agentId)
  }

  // ── Memory Flush ─────────────────────────────────────────────────────────

  /**
   * Return the memory flush prompt to send to the agent before context compaction.
   */
  getFlushPrompt(): string {
    const dateStamp = new Date().toISOString().slice(0, 10)
    return [
      'Pre-compaction memory flush.',
      `Store durable memories now (use memory/${dateStamp}.md; create memory/ if needed).`,
      'IMPORTANT: If the file already exists, APPEND new content only and do not overwrite existing entries.',
      'If nothing to store, reply with [NO_REPLY].',
    ].join(' ')
  }

  // ── Agent Tools ──────────────────────────────────────────────────────────

  /**
   * Return 5 high-level DeviceTools for the agent.
   * These handle embedding internally — the agent just passes natural language.
   */
  getTools(): DeviceTool[] {
    return [
      this._memoryRecallTool(),
      this._memoryStoreTool(),
      this._memoryForgetTool(),
      this._memorySearchTool(),
      this._memoryGetTool(),
    ]
  }

  private _memoryRecallTool(): DeviceTool {
    return {
      name: 'memory_recall',
      description:
        'Search through long-term memories. Use when you need context about user preferences, past decisions, or previously discussed topics. Returns semantically similar entries.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Natural language search query' },
          limit: { type: 'number', description: 'Max results (default: 5)' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      execute: async (args) => {
        if (!this._initialized) return { error: 'Memory not initialized' }
        const query = args.query as string
        const limit = (args.limit as number) ?? 5

        const vector = await this.embed(query)
        const { results } = await LanceDB.search({ queryVector: vector, limit })
        const filtered = results.filter((r) => r.score >= 0.3)

        if (filtered.length === 0) return { message: 'No relevant memories found.' }

        const text = filtered
          .map((r, i) => {
            const meta = r.metadata ? JSON.parse(r.metadata) : {}
            return `${i + 1}. [${meta.category || 'other'}] ${r.text} (${(r.score * 100).toFixed(0)}%)`
          })
          .join('\n')

        return { count: filtered.length, memories: text }
      },
    }
  }

  private _memoryStoreTool(): DeviceTool {
    return {
      name: 'memory_store',
      description:
        'Save important information in long-term memory. Use for preferences, facts, decisions, entities. Automatically checks for duplicates.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Information to remember' },
          category: {
            type: 'string',
            enum: ['preference', 'fact', 'decision', 'entity', 'other'],
            description: 'Category (auto-detected if omitted)',
          },
        },
        required: ['text'],
        additionalProperties: false,
      },
      execute: async (args) => {
        if (!this._initialized) return { error: 'Memory not initialized' }
        const text = args.text as string

        if (looksLikePromptInjection(text)) {
          return { error: 'Content rejected: suspected prompt injection' }
        }

        const vector = await this.embed(text)

        // Duplicate check
        const { results } = await LanceDB.search({ queryVector: vector, limit: 1 })
        if (results.length > 0 && results[0].score >= this._config.dupThreshold) {
          return { action: 'duplicate', existing: results[0].text }
        }

        const category = (args.category as MemoryCategory) || detectCategory(text)
        const key = `mem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

        await LanceDB.store({
          key,
          agentId: this._config.agentId,
          text,
          embedding: vector,
          metadata: JSON.stringify({ category, importance: 0.7 }),
        })

        return { action: 'stored', key, category }
      },
    }
  }

  private _memoryForgetTool(): DeviceTool {
    return {
      name: 'memory_forget',
      description:
        'Delete specific memories. Provide a search query to find memories, or a specific memory key to delete directly.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query to find memory to forget' },
          key: { type: 'string', description: 'Specific memory key to delete' },
        },
        additionalProperties: false,
      },
      execute: async (args) => {
        if (!this._initialized) return { error: 'Memory not initialized' }

        if (args.key) {
          await LanceDB.delete({ key: args.key as string })
          return { action: 'deleted', key: args.key }
        }

        if (args.query) {
          const vector = await this.embed(args.query as string)
          const { results } = await LanceDB.search({ queryVector: vector, limit: 5 })
          const filtered = results.filter((r) => r.score >= 0.7)

          if (filtered.length === 0) return { message: 'No matching memories found.' }

          if (filtered.length === 1 && filtered[0].score > 0.9) {
            await LanceDB.delete({ key: filtered[0].key })
            return { action: 'deleted', text: filtered[0].text }
          }

          return {
            action: 'candidates',
            candidates: filtered.map((r) => ({ key: r.key, text: r.text, score: r.score })),
            message: 'Multiple matches found. Specify a key to delete.',
          }
        }

        return { error: 'Provide query or key.' }
      },
    }
  }

  private _memorySearchTool(): DeviceTool {
    return {
      name: 'memory_search',
      description:
        'Semantic search across MEMORY.md and memory/*.md files. Returns snippets with file path and line range. Use after memory_recall for file-specific lookups.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          maxResults: { type: 'number', description: 'Max results (default: 5)' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      execute: async (args) => {
        if (!this._initialized) return { error: 'Memory not initialized' }
        const query = args.query as string
        const limit = (args.maxResults as number) ?? 5

        const vector = await this.embed(query)
        const { results } = await LanceDB.search({
          queryVector: vector,
          limit,
          filter: 'metadata LIKE \'%"source":"file"%\'',
        })

        if (results.length === 0) return { results: [], count: 0 }

        const formatted = results.map((r) => {
          const meta = r.metadata ? JSON.parse(r.metadata) : {}
          return {
            path: meta.path || 'unknown',
            startLine: meta.startLine,
            endLine: meta.endLine,
            snippet: r.text,
            score: r.score,
            citation: `${meta.path || ''}#L${meta.startLine || 0}-L${meta.endLine || 0}`,
          }
        })

        return { results: formatted, count: formatted.length }
      },
    }
  }

  private _memoryGetTool(): DeviceTool {
    return {
      name: 'memory_get',
      description:
        'Read a specific memory file (MEMORY.md or memory/*.md) with optional line range. Use after memory_search to pull specific lines.',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Relative path (e.g. "MEMORY.md" or "memory/2026-02-26.md")',
          },
          from: { type: 'number', description: 'Start line (1-indexed)' },
          lines: { type: 'number', description: 'Number of lines to read' },
        },
        required: ['path'],
        additionalProperties: false,
      },
      execute: async (args) => {
        const relPath = args.path as string

        // Security: restrict to MEMORY.md or memory/ prefix
        const normalized = relPath.replace(/\\/g, '/')
        if (normalized !== 'MEMORY.md' && !normalized.startsWith('memory/')) {
          return { error: 'path must be MEMORY.md or memory/*.md' }
        }
        // Block path traversal
        if (normalized.includes('..') || normalized.includes('//')) {
          return { error: 'Invalid path' }
        }

        // memory_get needs a readFile function — this is provided at tool
        // registration time via closure. Since the tool is created by getTools()
        // and the consumer passes readFile to indexFiles(), we use a fallback.
        // In practice, this tool is most useful when the consumer has injected
        // a readFile via the _readFileFn property.
        if (!this._readFileFn) {
          return { error: 'File read not available. Use workspace_read instead.' }
        }

        try {
          const { content } = await this._readFileFn(relPath)
          if (!content) return { path: relPath, text: '' }

          const allLines = content.split('\n')
          const from = (args.from as number) ?? 1
          const lineCount = (args.lines as number) ?? allLines.length
          const slice = allLines.slice(Math.max(0, from - 1), from - 1 + lineCount)

          return { path: relPath, text: slice.join('\n') }
        } catch {
          return { path: relPath, text: '' }
        }
      },
    }
  }

  // ── Read file function (set by consumer) ─────────────────────────────────

  private _readFileFn: ((path: string) => Promise<{ content: string }>) | null = null

  /**
   * Set the file read function used by memory_get tool.
   * Typically set to the engine's readFile method.
   */
  setReadFile(fn: (path: string) => Promise<{ content: string }>): void {
    this._readFileFn = fn
  }

  // ── Stats ────────────────────────────────────────────────────────────────

  /** Return the total number of memory entries. */
  async count(): Promise<number> {
    if (!this._initialized) return 0
    try {
      const { keys } = await LanceDB.list()
      return keys.length
    } catch {
      return 0
    }
  }

  /** Clear all memories. */
  async clear(): Promise<void> {
    if (!this._initialized) return
    await LanceDB.clear()
  }
}
