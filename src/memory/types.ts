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
