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
import { buildExtractionPrompt, parseExtractionResponse } from './entity-extractor'
import { extractEntityNames } from './ner'
import {
  DEFAULT_CAPTURE_MAX_CHARS,
  DEFAULT_DB_PATH,
  DEFAULT_DUP_THRESHOLD,
  DEFAULT_EMBEDDING_DIM,
  DEFAULT_EVERGREEN_CATEGORIES,
  DEFAULT_GRAPH_MAX_HOPS,
  DEFAULT_HALF_LIFE_DAYS,
  DEFAULT_MIN_DECAY_SCORE,
  DEFAULT_MMR_LAMBDA,
  DEFAULT_RECALL_LIMIT,
  DEFAULT_RECALL_MIN_SCORE,
  DEFAULT_RRF_K,
  type AgentOsAdapter,
  type DeviceTool,
  type ExtractionResult,
  type KuzuGraphAdapter,
  type MemoryCategory,
  type MemoryManagerConfig,
  type MemorySource,
  type ScoringInput,
  type StoredEntity,
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
      | 'rrfK'
      | 'halfLifeDays'
      | 'mmrLambda'
      | 'minDecayScore'
      | 'enableGraph'
      | 'enableEntityExtraction'
      | 'enableEmbeddingCache'
      | 'graphMaxHops'
      | 'enableNerRecall'
    >
  > & {
    openaiApiKey?: string
    httpRequest?: MemoryManagerConfig['httpRequest']
    agentOs?: AgentOsAdapter
    kuzuGraph?: KuzuGraphAdapter
    evergreenCategories: string[]
    extractEntities?: (text: string) => Promise<ExtractionResult>
  } = {
    embeddingDim: DEFAULT_EMBEDDING_DIM,
    dbPath: DEFAULT_DB_PATH,
    agentId: 'main',
    autoRecall: true,
    autoCapture: true,
    recallLimit: DEFAULT_RECALL_LIMIT,
    recallMinScore: DEFAULT_RECALL_MIN_SCORE,
    captureMaxChars: DEFAULT_CAPTURE_MAX_CHARS,
    dupThreshold: DEFAULT_DUP_THRESHOLD,
    rrfK: DEFAULT_RRF_K,
    halfLifeDays: DEFAULT_HALF_LIFE_DAYS,
    mmrLambda: DEFAULT_MMR_LAMBDA,
    minDecayScore: DEFAULT_MIN_DECAY_SCORE,
    enableGraph: false,
    enableEntityExtraction: false,
    enableEmbeddingCache: true,
    evergreenCategories: DEFAULT_EVERGREEN_CATEGORIES,
    graphMaxHops: DEFAULT_GRAPH_MAX_HOPS,
    enableNerRecall: false,
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
      rrfK: config.rrfK ?? DEFAULT_RRF_K,
      halfLifeDays: config.halfLifeDays ?? DEFAULT_HALF_LIFE_DAYS,
      mmrLambda: config.mmrLambda ?? DEFAULT_MMR_LAMBDA,
      minDecayScore: config.minDecayScore ?? DEFAULT_MIN_DECAY_SCORE,
      enableGraph: config.enableGraph ?? false,
      enableEntityExtraction: config.enableEntityExtraction ?? false,
      enableEmbeddingCache: config.enableEmbeddingCache ?? (config.agentOs != null),
      evergreenCategories: config.evergreenCategories ?? DEFAULT_EVERGREEN_CATEGORIES,
      agentOs: config.agentOs,
      extractEntities: config.extractEntities,
      kuzuGraph: config.kuzuGraph,
      graphMaxHops: config.graphMaxHops ?? DEFAULT_GRAPH_MAX_HOPS,
      enableNerRecall: config.enableNerRecall ?? (config.kuzuGraph != null),
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

    // Initialize agent-os subsystems if adapter provided
    if (this._config.agentOs) {
      if (this._config.enableGraph && !this._config.kuzuGraph) {
        // Only open SQLite graph if Kuzu is NOT configured (Kuzu replaces it)
        await this._config.agentOs.openKnowledgeStore({ dbPath: resolvedPath + '-graph' })
      }
      await this._config.agentOs.createScoringEngine({
        config: {
          halfLifeDays: this._config.halfLifeDays,
          minScore: this._config.minDecayScore,
          evergreenCategories: this._config.evergreenCategories,
          mmrLambda: this._config.mmrLambda,
        },
      })
    }

    // Initialize Kuzu graph if adapter provided
    if (this._config.kuzuGraph && this._config.enableGraph) {
      await this._config.kuzuGraph.open({ dbPath: resolvedPath + '-kuzu-graph' })
    }

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
    const { agentOs, enableEmbeddingCache } = this._config

    // Check embedding cache first
    if (agentOs && enableEmbeddingCache) {
      try {
        const hash = String(fnv1a(text))
        const cached = await agentOs.getCachedEmbedding({ textHash: hash })
        if (cached.embeddingJson) return JSON.parse(cached.embeddingJson)
      } catch {
        // Cache miss or error — proceed to compute
      }
    }

    const vec = this._config.openaiApiKey
      ? await this._embedOpenAI(text)
      : localHashEmbed(text, this._config.embeddingDim)

    // Store in cache
    if (agentOs && enableEmbeddingCache) {
      try {
        const hash = String(fnv1a(text))
        await agentOs.cacheEmbedding({ textHash: hash, embeddingJson: JSON.stringify(vec) })
      } catch {
        // Non-fatal — caching is best-effort
      }
    }

    return vec
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

      const { agentOs } = this._config
      const limit = this._config.recallLimit

      // Use hybrid search (vector + BM25 text) with over-fetch for scoring
      const overFetchLimit = agentOs ? limit * 2 : limit
      const { results: hybridResults } = await LanceDB.hybridSearch({
        queryVector: vector,
        queryText: prompt,
        limit: overFetchLimit,
        rrfK: this._config.rrfK,
      })

      if (hybridResults.length === 0) return null

      // Apply scoring (decay + MMR) if agent-os available
      let finalResults: Array<{ text: string; category: MemoryCategory; score: number }>

      if (agentOs) {
        const scoringInputs: ScoringInput[] = hybridResults.map((r) => {
          const meta = r.metadata ? JSON.parse(r.metadata) : {}
          return {
            key: r.key,
            text: r.text,
            score: r.rrfScore,
            category: meta.category,
            accessedAt: meta.accessedAt || new Date().toISOString(),
            metadataJson: r.metadata ?? undefined,
          }
        })

        const { items: scored } = await agentOs.scoreAndRank({ items: scoringInputs, limit })
        finalResults = scored.map((s) => {
          const meta = s.metadataJson ? JSON.parse(s.metadataJson) : {}
          return {
            text: s.text,
            category: (meta.category as MemoryCategory) || 'other',
            score: s.decayedScore,
          }
        })

        // Touch accessed entities in graph
        if (this._config.enableGraph) {
          for (const s of scored) {
            const meta = s.metadataJson ? JSON.parse(s.metadataJson) : {}
            if (meta.entityId) {
              if (this._config.kuzuGraph) {
                this._config.kuzuGraph.touchEntity(meta.entityId).catch(() => {})
              } else {
                agentOs.touchKnowledgeEntity({ id: meta.entityId }).catch(() => {})
              }
            }
          }
        }
      } else {
        // Fallback: take top results by RRF score, filter by min score
        finalResults = hybridResults.slice(0, limit).map((r) => {
          const meta = r.metadata ? JSON.parse(r.metadata) : {}
          return {
            text: r.text,
            category: (meta.category as MemoryCategory) || 'other',
            score: r.rrfScore,
          }
        })
      }

      // Filter by min score threshold
      const relevant = finalResults.filter((r) => r.score >= this._config.recallMinScore)
      if (relevant.length === 0 && !this._config.kuzuGraph) return null

      // Graph-augmented recall (Mem0-style parallel pipeline)
      let graphContext = ''
      if (this._config.kuzuGraph && this._config.enableGraph && this._config.enableNerRecall) {
        try {
          // NER: extract entity names from prompt + top hybrid result texts (zero LLM cost)
          const textsForNer = [prompt, ...hybridResults.slice(0, 3).map((r) => r.text)]
          const entityNames = [...new Set(textsForNer.flatMap(extractEntityNames))]

          if (entityNames.length > 0) {
            const { contextText } = await this._config.kuzuGraph.getEntityContext({
              entityNames,
              maxHops: this._config.graphMaxHops,
              limit: 10,
            })
            if (contextText) {
              graphContext = `\n<graph-context>\n${contextText}\n</graph-context>`
            }
          }
        } catch {
          // Graph context expansion is best-effort — don't fail recall
        }
      }

      const vectorContext = relevant.length > 0 ? formatRelevantMemoriesContext(relevant) : null
      if (!vectorContext && !graphContext) return null

      return (vectorContext ?? '') + graphContext
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

      const now = new Date().toISOString()
      const key = `auto-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      await LanceDB.store({
        key,
        agentId: this._config.agentId,
        text,
        embedding: vector,
        metadata: JSON.stringify({ category, importance: 0.7, auto: true, accessedAt: now }),
      })

      // Entity extraction → knowledge graph (background, non-blocking)
      if (this._config.enableGraph && this._config.enableEntityExtraction && this._config.extractEntities) {
        this._extractAndStoreEntities(text).catch(() => {})
      }

      return true
    } catch {
      return false
    }
  }

  // ── Entity Extraction (graph population) ────────────────────────────

  private async _extractAndStoreEntities(text: string): Promise<void> {
    const { agentOs, kuzuGraph, extractEntities } = this._config
    if (!extractEntities) return
    // Need either agentOs or kuzuGraph for storage
    if (!agentOs && !kuzuGraph) return

    const extraction = await extractEntities(text)
    if (extraction.entities.length === 0 && extraction.relations.length === 0) return

    const now = new Date().toISOString()
    const entityIdByName = new Map<string, string>()

    if (kuzuGraph) {
      // ── Kuzu path ──────────────────────────────────────────────────
      for (const ent of extraction.entities) {
        // Check for existing entity by name
        const existing = await kuzuGraph.queryGraph({ namePattern: ent.name, entityType: ent.type })
        const match = existing.entities.find(
          (e) => e.name.toLowerCase() === ent.name.toLowerCase() && e.entityType === ent.type,
        )

        if (match) {
          const merged: StoredEntity = {
            ...match,
            propertiesJson: JSON.stringify({
              ...JSON.parse(match.propertiesJson || '{}'),
              ...(ent.properties || {}),
            }),
            accessedAt: now,
          }
          await kuzuGraph.updateEntity(merged)
          entityIdByName.set(ent.name, match.id)
        } else {
          const newEntity: StoredEntity = {
            id: `ent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            entityType: ent.type,
            name: ent.name,
            propertiesJson: JSON.stringify(ent.properties || {}),
            confidence: 0.8,
            source: 'Conversation' as MemorySource,
            createdAt: now,
            accessedAt: now,
            accessCount: 1,
            deleted: false,
          }
          const { id } = await kuzuGraph.addEntity(newEntity)
          entityIdByName.set(ent.name, id)
        }
      }

      // Add relations with Zep-style validFrom
      for (const rel of extraction.relations) {
        const sourceId = entityIdByName.get(rel.sourceName)
        const targetId = entityIdByName.get(rel.targetName)
        if (!sourceId || !targetId) continue

        await kuzuGraph.addRelation({
          id: `rel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          sourceId,
          relationType: rel.type,
          targetId,
          confidence: 0.7,
          source: 'Conversation' as MemorySource,
          createdAt: now,
          accessedAt: now,
          accessCount: 1,
          deleted: false,
          validFrom: now,
        })
      }
    } else if (agentOs) {
      // ── SQLite fallback path (existing behavior) ───────────────────
      for (const ent of extraction.entities) {
        const existing = await agentOs.queryKnowledgeGraph({ namePattern: ent.name, entityType: ent.type })
        const match = existing.entities.find(
          (e) => e.name.toLowerCase() === ent.name.toLowerCase() && e.entityType === ent.type,
        )

        if (match) {
          const merged = {
            ...match,
            propertiesJson: JSON.stringify({
              ...JSON.parse(match.propertiesJson || '{}'),
              ...(ent.properties || {}),
            }),
            accessedAt: now,
          }
          await agentOs.updateKnowledgeEntity({ entity: merged })
          entityIdByName.set(ent.name, match.id)
        } else {
          const newEntity: StoredEntity = {
            id: `ent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            entityType: ent.type,
            name: ent.name,
            propertiesJson: JSON.stringify(ent.properties || {}),
            confidence: 0.8,
            source: 'Conversation' as MemorySource,
            createdAt: now,
            accessedAt: now,
            accessCount: 1,
            deleted: false,
          }
          const { id } = await agentOs.addKnowledgeEntity({ entity: newEntity })
          entityIdByName.set(ent.name, id)
        }
      }

      for (const rel of extraction.relations) {
        const sourceId = entityIdByName.get(rel.sourceName)
        const targetId = entityIdByName.get(rel.targetName)
        if (!sourceId || !targetId) continue

        await agentOs.addKnowledgeRelation({
          relation: {
            id: `rel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            sourceId,
            relationType: rel.type,
            targetId,
            confidence: 0.7,
            source: 'Conversation' as MemorySource,
            createdAt: now,
            accessedAt: now,
            accessCount: 1,
            deleted: false,
          },
        })
      }
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
    const tools = [
      this._memoryRecallTool(),
      this._memoryStoreTool(),
      this._memoryForgetTool(),
      this._memorySearchTool(),
      this._memoryGetTool(),
    ]

    // Add graph tools when graph backend (Kuzu or agent-os) is available
    const hasGraph = this._config.enableGraph && (this._config.kuzuGraph || this._config.agentOs)
    if (hasGraph) {
      tools.push(this._knowledgeGraphQueryTool(), this._knowledgeGraphAddTool())
      if (this._config.kuzuGraph) {
        tools.push(this._knowledgeGraphHubsTool())
      }
    }
    if (this._config.agentOs || this._config.kuzuGraph) {
      tools.push(this._memoryStatsTool())
    }

    return tools
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
        const { results } = await LanceDB.hybridSearch({
          queryVector: vector,
          queryText: query,
          limit,
          rrfK: this._config.rrfK,
        })
        const filtered = results.filter((r) => r.rrfScore > 0)

        if (filtered.length === 0) return { message: 'No relevant memories found.' }

        const text = filtered
          .map((r, i) => {
            const meta = r.metadata ? JSON.parse(r.metadata) : {}
            return `${i + 1}. [${meta.category || 'other'}] ${r.text} (rrf:${r.rrfScore.toFixed(4)})`
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
        const now = new Date().toISOString()
        const key = `mem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

        await LanceDB.store({
          key,
          agentId: this._config.agentId,
          text,
          embedding: vector,
          metadata: JSON.stringify({ category, importance: 0.7, accessedAt: now }),
        })

        // Entity extraction → knowledge graph (background)
        if (this._config.enableGraph && this._config.enableEntityExtraction && this._config.extractEntities) {
          this._extractAndStoreEntities(text).catch(() => {})
        }

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

  // ── Knowledge Graph Tools ────────────────────────────────────────────────

  private _knowledgeGraphQueryTool(): DeviceTool {
    return {
      name: 'knowledge_graph_query',
      description:
        'Query the knowledge graph for entities and relations. Filter by entity type or name pattern. Supports multi-hop expansion when maxHops > 1.',
      inputSchema: {
        type: 'object',
        properties: {
          entityType: {
            type: 'string',
            enum: ['Person', 'Organization', 'Project', 'Concept', 'Location', 'Tool', 'File', 'Other'],
            description: 'Filter by entity type',
          },
          namePattern: { type: 'string', description: 'Filter by name pattern (substring match)' },
          maxHops: { type: 'number', description: 'Multi-hop expansion depth (default: 1, max: 3). Kuzu only.' },
        },
        additionalProperties: false,
      },
      execute: async (args) => {
        const { kuzuGraph, agentOs } = this._config
        if (!kuzuGraph && !agentOs) return { error: 'Knowledge graph not available' }

        const entityType = args.entityType as string | undefined
        const namePattern = args.namePattern as string | undefined
        const maxHops = Math.min((args.maxHops as number) ?? 1, 3)

        let result: import('./types').GraphQueryResult

        if (kuzuGraph) {
          // Kuzu path — supports multi-hop
          const base = await kuzuGraph.queryGraph({ entityType, namePattern })
          if (maxHops > 1 && base.entities.length > 0) {
            const expanded = await kuzuGraph.expandNeighborhood({
              entityIds: base.entities.map((e) => e.id),
              maxHops,
              limit: 50,
            })
            // Merge base + expanded (dedup by id)
            const entityMap = new Map(base.entities.map((e) => [e.id, e]))
            for (const e of expanded.entities) {
              if (!entityMap.has(e.id)) entityMap.set(e.id, e)
            }
            const relMap = new Map(base.relations.map((r) => [r.id, r]))
            for (const r of expanded.relations) {
              if (!relMap.has(r.id)) relMap.set(r.id, r)
            }
            result = { entities: [...entityMap.values()], relations: [...relMap.values()] }
          } else {
            result = base
          }
        } else {
          // SQLite fallback via agent-os
          result = await agentOs!.queryKnowledgeGraph({ entityType, namePattern })
        }

        return {
          entities: result.entities.map((e) => ({
            id: e.id,
            type: e.entityType,
            name: e.name,
            properties: JSON.parse(e.propertiesJson || '{}'),
            confidence: e.confidence,
            accessCount: e.accessCount,
          })),
          relations: result.relations.map((r) => ({
            id: r.id,
            sourceId: r.sourceId,
            type: r.relationType,
            targetId: r.targetId,
            confidence: r.confidence,
          })),
        }
      },
    }
  }

  private _knowledgeGraphAddTool(): DeviceTool {
    return {
      name: 'knowledge_graph_add',
      description:
        'Add an entity or relation to the knowledge graph. For entities: provide name and type. For relations: provide sourceName, type, and targetName.',
      inputSchema: {
        type: 'object',
        properties: {
          entity: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              type: {
                type: 'string',
                enum: ['Person', 'Organization', 'Project', 'Concept', 'Location', 'Tool', 'File', 'Other'],
              },
              properties: { type: 'object', description: 'Arbitrary key-value metadata' },
            },
            required: ['name', 'type'],
          },
          relation: {
            type: 'object',
            properties: {
              sourceName: { type: 'string' },
              type: {
                type: 'string',
                enum: [
                  'WorksAt', 'KnowsAbout', 'RelatedTo', 'DependsOn',
                  'OwnedBy', 'CreatedBy', 'LocatedIn', 'PartOf', 'Uses', 'Produces',
                ],
              },
              targetName: { type: 'string' },
            },
            required: ['sourceName', 'type', 'targetName'],
          },
        },
        additionalProperties: false,
      },
      execute: async (args) => {
        const { kuzuGraph, agentOs } = this._config
        if (!kuzuGraph && !agentOs) return { error: 'Knowledge graph not available' }

        const now = new Date().toISOString()
        const results: Array<{ action: string; id: string; name?: string }> = []

        // Add entity
        if (args.entity) {
          const ent = args.entity as { name: string; type: string; properties?: Record<string, unknown> }
          const newEntity: StoredEntity = {
            id: `ent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            entityType: ent.type as StoredEntity['entityType'],
            name: ent.name,
            propertiesJson: JSON.stringify(ent.properties || {}),
            confidence: 0.9,
            source: 'UserProvided' as MemorySource,
            createdAt: now,
            accessedAt: now,
            accessCount: 1,
            deleted: false,
          }
          if (kuzuGraph) {
            const { id } = await kuzuGraph.addEntity(newEntity)
            results.push({ action: 'entity_added', id, name: ent.name })
          } else {
            const { id } = await agentOs!.addKnowledgeEntity({ entity: newEntity })
            results.push({ action: 'entity_added', id, name: ent.name })
          }
        }

        // Add relation
        if (args.relation) {
          const rel = args.relation as { sourceName: string; type: string; targetName: string }

          // Resolve names to IDs
          let srcEntity: StoredEntity | undefined
          let tgtEntity: StoredEntity | undefined

          if (kuzuGraph) {
            const srcQ = await kuzuGraph.queryGraph({ namePattern: rel.sourceName })
            const tgtQ = await kuzuGraph.queryGraph({ namePattern: rel.targetName })
            srcEntity = srcQ.entities.find((e) => e.name.toLowerCase() === rel.sourceName.toLowerCase())
            tgtEntity = tgtQ.entities.find((e) => e.name.toLowerCase() === rel.targetName.toLowerCase())
          } else {
            const srcQ = await agentOs!.queryKnowledgeGraph({ namePattern: rel.sourceName })
            const tgtQ = await agentOs!.queryKnowledgeGraph({ namePattern: rel.targetName })
            srcEntity = srcQ.entities.find((e) => e.name.toLowerCase() === rel.sourceName.toLowerCase())
            tgtEntity = tgtQ.entities.find((e) => e.name.toLowerCase() === rel.targetName.toLowerCase())
          }

          if (!srcEntity) return { error: `Entity not found: ${rel.sourceName}` }
          if (!tgtEntity) return { error: `Entity not found: ${rel.targetName}` }

          const relData = {
            id: `rel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            sourceId: srcEntity.id,
            relationType: rel.type as import('./types').RelationType,
            targetId: tgtEntity.id,
            confidence: 0.9,
            source: 'UserProvided' as MemorySource,
            createdAt: now,
            accessedAt: now,
            accessCount: 1,
            deleted: false,
          }

          if (kuzuGraph) {
            const { id } = await kuzuGraph.addRelation({ ...relData, validFrom: now })
            results.push({ action: 'relation_added', id })
          } else {
            const { id } = await agentOs!.addKnowledgeRelation({ relation: relData })
            results.push({ action: 'relation_added', id })
          }
        }

        return { results }
      },
    }
  }

  private _knowledgeGraphHubsTool(): DeviceTool {
    return {
      name: 'knowledge_graph_hubs',
      description:
        'Discover the most highly connected entities in the knowledge graph. Useful for understanding key concepts, people, or projects.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Max results (default: 10)' },
          entityType: {
            type: 'string',
            enum: ['Person', 'Organization', 'Project', 'Concept', 'Location', 'Tool', 'File', 'Other'],
            description: 'Filter by entity type',
          },
        },
        additionalProperties: false,
      },
      execute: async (args) => {
        const { kuzuGraph } = this._config
        if (!kuzuGraph) return { error: 'Hub discovery requires Kuzu graph backend' }

        const limit = (args.limit as number) ?? 10
        const entityType = args.entityType as string | undefined

        const hubs = await kuzuGraph.getHubs({ limit, entityType })
        return {
          hubs: hubs.map((h) => ({
            name: h.entity.name,
            type: h.entity.entityType,
            degree: h.degree,
            id: h.entity.id,
          })),
          count: hubs.length,
        }
      },
    }
  }

  private _memoryStatsTool(): DeviceTool {
    return {
      name: 'memory_stats',
      description: 'Get aggregate memory statistics: vector count, graph entity/relation counts.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      execute: async () => {
        if (!this._initialized) return { error: 'Memory not initialized' }

        const vectorCount = await this.count()
        const stats: Record<string, unknown> = { vectorCount }

        if (this._config.enableGraph) {
          try {
            if (this._config.kuzuGraph) {
              stats.graphEntities = await this._config.kuzuGraph.entityCount()
              stats.graphRelations = await this._config.kuzuGraph.relationCount()
              stats.graphBackend = 'kuzu'
            } else if (this._config.agentOs) {
              const graph = await this._config.agentOs.queryKnowledgeGraph()
              stats.graphEntities = graph.entities.length
              stats.graphRelations = graph.relations.length
              stats.graphBackend = 'sqlite'
            }
          } catch {
            stats.graphEntities = 0
            stats.graphRelations = 0
          }
        }

        return stats
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
