export type { LanceDBPlugin, SearchResult } from './definitions'
export { chunkMarkdown, indexWorkspaceMemory } from './memory/indexer'
// High-level memory system
export { MemoryManager } from './memory/manager'
export {
  detectCategory,
  escapeMemoryForPrompt,
  formatRelevantMemoriesContext,
  looksLikePromptInjection,
  shouldCapture,
} from './memory/security'
export type {
  DeviceTool,
  MemoryCategory,
  MemoryEntry,
  MemoryManagerConfig,
} from './memory/types'
export { LanceDB } from './plugin'
export { memoryTools } from './tools/memory.tools'
