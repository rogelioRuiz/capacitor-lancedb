/**
 * Shared types for the LanceDB memory system.
 */

export const MEMORY_CATEGORIES = ['preference', 'fact', 'decision', 'entity', 'other'] as const
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number]

export const DEFAULT_EMBEDDING_DIM = 1536
export const DEFAULT_DB_PATH = 'memory-lancedb'
export const DEFAULT_RECALL_LIMIT = 3
export const DEFAULT_RECALL_MIN_SCORE = 0.3
export const DEFAULT_CAPTURE_MAX_CHARS = 500
export const DEFAULT_DUP_THRESHOLD = 0.95
export const DEFAULT_RRF_K = 60
export const DEFAULT_HALF_LIFE_DAYS = 30
export const DEFAULT_MIN_DECAY_SCORE = 0.05
export const DEFAULT_MMR_LAMBDA = 0.7
export const DEFAULT_EVERGREEN_CATEGORIES: string[] = ['preference']
export const DEFAULT_GRAPH_MAX_HOPS = 2

// ── Agent-OS types (subset used by MemoryManager) ────────────────────

export type EntityType =
  | 'Person' | 'Organization' | 'Project' | 'Concept'
  | 'Location' | 'Tool' | 'File' | 'Other'

export type RelationType =
  | 'WorksAt' | 'KnowsAbout' | 'RelatedTo' | 'DependsOn'
  | 'OwnedBy' | 'CreatedBy' | 'LocatedIn' | 'PartOf' | 'Uses' | 'Produces'

export type MemorySource =
  | 'Conversation' | 'Document' | 'Observation'
  | 'Inference' | 'UserProvided' | 'System'

export interface ScoringConfig {
  halfLifeDays: number
  minScore: number
  evergreenCategories: string[]
  mmrLambda: number
}

export interface ScoringInput {
  key: string
  text: string
  score: number
  category?: string
  accessedAt: string
  metadataJson?: string
}

export interface ScoredItem {
  key: string
  text: string
  rawScore: number
  decayedScore: number
  category?: string
  accessedAt: string
  metadataJson?: string
}

export interface StoredEntity {
  id: string
  entityType: EntityType
  name: string
  propertiesJson: string
  confidence: number
  source: MemorySource
  createdAt: string
  accessedAt: string
  accessCount: number
  deleted: boolean
}

export interface StoredRelation {
  id: string
  sourceId: string
  relationType: RelationType
  targetId: string
  confidence: number
  source: MemorySource
  createdAt: string
  accessedAt: string
  accessCount: number
  deleted: boolean
}

export interface GraphQueryResult {
  entities: StoredEntity[]
  relations: StoredRelation[]
}

// ── Kuzu graph adapter types ─────────────────────────────────────────

/**
 * Minimal connection interface expected by KuzuGraphAdapterImpl.
 * The consumer creates this from capacitor-kuzu's KuzuConnectionClient.
 */
export interface KuzuConnection {
  query(cypher: string, params?: Record<string, unknown>): Promise<{ rows: unknown[][] }>
  close?(): Promise<void>
}

/**
 * Kuzu-backed knowledge graph adapter.
 * Replaces the SQLite graph methods from AgentOsAdapter with Cypher-powered
 * multi-hop traversal, temporal relations, and hub discovery.
 */
export interface KuzuGraphAdapter {
  open(opts: { dbPath: string; pathType?: string }): Promise<void>
  close(): Promise<void>

  // Entity CRUD
  addEntity(entity: StoredEntity): Promise<{ id: string }>
  updateEntity(entity: StoredEntity): Promise<void>
  softDeleteEntity(id: string): Promise<void>
  touchEntity(id: string): Promise<void>

  // Relation CRUD (with Zep-style temporal support)
  addRelation(relation: StoredRelation & { validFrom?: string; validUntil?: string }): Promise<{ id: string }>
  softDeleteRelation(id: string): Promise<void>
  invalidateRelation(id: string, validUntil: string): Promise<void>

  // Queries
  queryGraph(opts?: { entityType?: string; namePattern?: string }): Promise<GraphQueryResult>
  expandNeighborhood(opts: { entityIds: string[]; maxHops: number; limit: number }): Promise<GraphQueryResult>
  getEntityContext(opts: { entityNames: string[]; maxHops: number; limit: number }): Promise<{ entities: StoredEntity[]; relations: StoredRelation[]; contextText: string }>
  getHubs(opts: { limit: number; entityType?: string }): Promise<Array<{ entity: StoredEntity; degree: number }>>
  rawQuery(cypher: string, params?: Record<string, unknown>): Promise<unknown>

  // Stats
  entityCount(): Promise<number>
  relationCount(): Promise<number>
}

export interface ExtractionResult {
  entities: { name: string; type: EntityType; properties?: Record<string, unknown> }[]
  relations: { sourceName: string; type: RelationType; targetName: string }[]
}

/**
 * Agent-OS plugin interface injected by consumer.
 * MemoryManager does NOT import agent-os directly to avoid a hard npm dependency.
 */
export interface AgentOsAdapter {
  // Scoring
  createScoringEngine(opts: { config: ScoringConfig }): Promise<void>
  applyDecay(opts: { items: ScoringInput[] }): Promise<{ items: ScoredItem[] }>
  scoreAndRank(opts: { items: ScoringInput[]; limit: number }): Promise<{ items: ScoredItem[] }>
  // Embedding cache
  getCachedEmbedding(opts: { textHash: string }): Promise<{ embeddingJson: string | null }>
  cacheEmbedding(opts: { textHash: string; embeddingJson: string }): Promise<void>
  // Knowledge graph
  openKnowledgeStore(opts: { dbPath: string }): Promise<void>
  addKnowledgeEntity(opts: { entity: StoredEntity }): Promise<{ id: string }>
  updateKnowledgeEntity(opts: { entity: StoredEntity }): Promise<void>
  queryKnowledgeGraph(opts?: { entityType?: string; namePattern?: string }): Promise<GraphQueryResult>
  addKnowledgeRelation(opts: { relation: StoredRelation }): Promise<{ id: string }>
  softDeleteKnowledgeRelation(opts: { id: string }): Promise<void>
  touchKnowledgeEntity(opts: { id: string }): Promise<void>
}

// ── Config ───────────────────────────────────────────────────────────

export interface MemoryManagerConfig {
  /** Embedding vector dimension. Default: 1536 (OpenAI text-embedding-3-small). */
  embeddingDim?: number
  /** LanceDB path (relative; Capacitor resolves to app sandbox). Default: 'memory-lancedb'. */
  dbPath?: string
  /** Agent ID for multi-agent partitioning. Default: 'main'. */
  agentId?: string
  /** OpenAI API key for text-embedding-3-small. If unset, uses local hash fallback. */
  openaiApiKey?: string
  /** Enable auto-recall (inject relevant memories before each turn). Default: true. */
  autoRecall?: boolean
  /** Enable auto-capture (detect and store memorable content after each turn). Default: true. */
  autoCapture?: boolean
  /** Max results for auto-recall. Default: 3. */
  recallLimit?: number
  /** Min similarity score for recall results. Default: 0.3. */
  recallMinScore?: number
  /** Max chars for auto-capture eligibility. Default: 500. */
  captureMaxChars?: number
  /** Similarity threshold for duplicate detection. Default: 0.95. */
  dupThreshold?: number
  /**
   * Injectable HTTP request function (for CORS bypass on mobile).
   * Signature matches Capacitor NetworkTools.httpRequest().
   * If unset, uses standard fetch().
   */
  httpRequest?: (opts: HttpRequestOptions) => Promise<HttpResponse>

  // ── Scoring (agent-os ScoringEngine) ─────────────────────────────
  /** RRF constant for hybrid search. Default: 60. */
  rrfK?: number
  /** Exponential decay half-life in days. Default: 30. */
  halfLifeDays?: number
  /** Categories exempt from temporal decay. Default: ['preference']. */
  evergreenCategories?: string[]
  /** MMR relevance-vs-diversity balance (0–1). Default: 0.7 (relevance-biased). */
  mmrLambda?: number
  /** Minimum decayed score; items below this are pruned. Default: 0.05. */
  minDecayScore?: number

  // ── Knowledge graph (agent-os KnowledgeStore) ────────────────────
  /** Enable knowledge graph entity/relation tracking. Default: false. */
  enableGraph?: boolean
  /** Enable LLM-based entity extraction on store. Default: false. Requires extractEntities. */
  enableEntityExtraction?: boolean
  /** Enable agent-os embedding cache. Default: true when agentOs provided. */
  enableEmbeddingCache?: boolean

  // ── Agent-OS adapter (injected by consumer) ──────────────────────
  /** Agent-OS plugin methods. If provided, enables scoring, caching, and graph features. */
  agentOs?: AgentOsAdapter
  /** LLM entity extraction callback. Called during store when enableEntityExtraction is true. */
  extractEntities?: (text: string) => Promise<ExtractionResult>

  // ── Kuzu graph adapter (injected by consumer) ─────────────────────
  /** Kuzu graph adapter. If provided with enableGraph=true, replaces agent-os graph methods. */
  kuzuGraph?: KuzuGraphAdapter
  /** Max hops for graph context expansion during recall. Default: 2. */
  graphMaxHops?: number
  /** Enable lightweight NER for graph-augmented recall (no LLM cost). Default: true when kuzuGraph provided. */
  enableNerRecall?: boolean
}

export interface HttpRequestOptions {
  url: string
  method: string
  headers: Record<string, string>
  body: string
  timeout?: number
}

export interface HttpResponse {
  statusCode: number
  body: string | Record<string, unknown>
}

export interface MemoryEntry {
  key: string
  text: string
  score: number
  category?: MemoryCategory
  metadata?: Record<string, unknown>
}

export interface DeviceTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  execute: (args: Record<string, unknown>) => Promise<unknown>
}

export interface FileChunk {
  path: string
  startLine: number
  endLine: number
  text: string
}
