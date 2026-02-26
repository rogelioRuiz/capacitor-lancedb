# capacitor-lancedb

[![npm version](https://img.shields.io/npm/v/capacitor-lancedb)](https://www.npmjs.com/package/capacitor-lancedb)
[![CI](https://github.com/rogelioRuiz/capacitor-lancedb/actions/workflows/ci.yml/badge.svg)](https://github.com/rogelioRuiz/capacitor-lancedb/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Native LanceDB vector database plugin for Capacitor — persistent on-device vector memory with ANN search, powered by Rust FFI.

## Features

- **On-device vector storage** — no cloud dependency, all data stays on the device
- **Approximate nearest neighbor (ANN) search** — fast similarity search via LanceDB
- **Semantic memory manager** — auto-recall and auto-capture for AI agent workflows
- **Prompt injection detection** — built-in heuristics to filter unsafe stored content
- **Markdown file indexing** — chunk and index MEMORY.md and workspace files
- **Cross-platform** — Android (arm64) and iOS (arm64 + simulator)

## Install

```bash
npm install capacitor-lancedb
npx cap sync
```

## Quick Start

### Low-level plugin API

```typescript
import { LanceDB } from 'capacitor-lancedb'

// Open a database (auto-created if it doesn't exist)
await LanceDB.open({ dbPath: 'files://memories', embeddingDim: 1536 })

// Store a vector
await LanceDB.memoryStore({
  key: 'fact-1',
  agentId: 'main',
  text: 'The user prefers dark mode',
  embedding: [0.1, 0.2, ...], // 1536-dim vector
})

// Search by similarity
const { results } = await LanceDB.memorySearch({
  queryVector: [0.1, 0.2, ...],
  limit: 5,
})

// List, delete, clear
const { keys } = await LanceDB.memoryList({ prefix: 'fact-' })
await LanceDB.memoryDelete({ key: 'fact-1' })
await LanceDB.memoryClear()
```

### High-level MemoryManager

The `MemoryManager` wraps the plugin with embedding generation, auto-recall, auto-capture, and agent tools:

```typescript
import { MemoryManager } from 'capacitor-lancedb'

const memory = new MemoryManager({
  openaiApiKey: 'sk-...',  // for embeddings (falls back to local hash)
  httpFetch: myFetchFn,     // CORS-bypassing fetch (e.g. CapacitorHttp)
})

await memory.init()

// Get agent tools to register with your AI engine
const tools = memory.getTools()

// Auto-recall: inject relevant memories before a turn
const context = await memory.recallForPrompt('What theme does the user like?')

// Auto-capture: detect and store memorable content
await memory.captureFromResponse('The user said they prefer dark mode.')
```

## API

### LanceDBPlugin

| Method | Description |
|--------|-------------|
| `open({ dbPath, embeddingDim })` | Open or create a database |
| `memoryStore({ key, agentId, text, embedding, metadata? })` | Store a vector entry (upsert) |
| `memorySearch({ queryVector, limit, filter? })` | ANN search, returns `SearchResult[]` |
| `memoryDelete({ key })` | Delete an entry by key |
| `memoryList({ prefix?, limit? })` | List keys, optionally filtered |
| `memoryClear({ collection? })` | Drop all data |

### MemoryManager Tools

The `MemoryManager` exposes 5 agent tools:

| Tool | Description |
|------|-------------|
| `memory_recall` | Semantic search across stored memories |
| `memory_store` | Store a memory with duplicate detection |
| `memory_forget` | Delete memories by search or key |
| `memory_search` | Search file-indexed content only |
| `memory_get` | Read MEMORY.md snippets |

## Platforms

| Platform | Architecture | Binary |
|----------|-------------|--------|
| Android | arm64-v8a | `liblancedb_ffi.so` (41 MB) |
| iOS | arm64 (device) | `LanceDBFFI.xcframework` |
| iOS | arm64 (Apple Silicon sim) | `LanceDBFFI.xcframework` |

Prebuilt native binaries are included in the npm package. No Rust toolchain required for consumers.

## Building Native Binaries

For contributors modifying the Rust FFI code:

```bash
# Android
./scripts/build-android.sh

# iOS
./scripts/build-ios.sh
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for toolchain requirements.

## Contributing

Contributions are welcome! Please read our [Contributing Guide](CONTRIBUTING.md) and [Code of Conduct](CODE_OF_CONDUCT.md).

## Security

To report vulnerabilities, see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) &copy; 2025-present Techxagon
