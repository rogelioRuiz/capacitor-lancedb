export interface SearchResult {
  key: string
  text: string
  score: number
  metadata?: string
}

export interface LanceDBPlugin {
  /**
   * Open or create a LanceDB database.
   * Called automatically during plugin load — normally you don't need this.
   */
  open(options: { dbPath: string; embeddingDim: number }): Promise<void>

  // ── Generic Vector DB API ────────────────────────────────────

  /**
   * Store a vector entry (upsert — overwrites if key exists).
   */
  store(options: { key: string; agentId: string; text: string; embedding: number[]; metadata?: string }): Promise<void>

  /**
   * Search for nearest neighbours to `queryVector`.
   */
  search(options: { queryVector: number[]; limit: number; filter?: string }): Promise<{ results: SearchResult[] }>

  /**
   * Delete an entry by key.
   */
  delete(options: { key: string }): Promise<void>

  /**
   * List keys, optionally filtered by prefix.
   */
  list(options?: { prefix?: string; limit?: number }): Promise<{ keys: string[] }>

  /**
   * Drop all data from the table.
   */
  clear(options?: { collection?: string }): Promise<void>

  // ── Deprecated memory-prefixed aliases ───────────────────────

  /** @deprecated Use store() instead */
  memoryStore(options: {
    key: string
    agentId: string
    text: string
    embedding: number[]
    metadata?: string
  }): Promise<void>

  /** @deprecated Use search() instead */
  memorySearch(options: { queryVector: number[]; limit: number; filter?: string }): Promise<{ results: SearchResult[] }>

  /** @deprecated Use delete() instead */
  memoryDelete(options: { key: string }): Promise<void>

  /** @deprecated Use list() instead */
  memoryList(options?: { prefix?: string; limit?: number }): Promise<{ keys: string[] }>

  /** @deprecated Use clear() instead */
  memoryClear(options?: { collection?: string }): Promise<void>
}
