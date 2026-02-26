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

  /**
   * Store a memory entry (upsert — overwrites if key exists).
   */
  memoryStore(options: {
    key: string
    agentId: string
    text: string
    embedding: number[]
    metadata?: string
  }): Promise<void>

  /**
   * Search for nearest neighbours to `queryVector`.
   */
  memorySearch(options: { queryVector: number[]; limit: number; filter?: string }): Promise<{ results: SearchResult[] }>

  /**
   * Delete a memory entry by key.
   */
  memoryDelete(options: { key: string }): Promise<void>

  /**
   * List memory keys, optionally filtered by prefix.
   */
  memoryList(options?: { prefix?: string; limit?: number }): Promise<{ keys: string[] }>

  /**
   * Drop all data from the memory table.
   */
  memoryClear(options?: { collection?: string }): Promise<void>
}
