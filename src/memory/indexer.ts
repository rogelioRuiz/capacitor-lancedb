/**
 * File indexer — chunks MEMORY.md + memory/*.md files and stores them
 * in LanceDB for semantic search.
 *
 * Ported from OpenClaw's memory-search.ts chunking logic.
 */

import { LanceDB } from '../plugin'
import type { FileChunk } from './types'

const DEFAULT_CHUNK_TOKENS = 400
const DEFAULT_CHUNK_OVERLAP = 80
// Rough estimate: 1 token ≈ 4 chars
const CHARS_PER_TOKEN = 4

/**
 * Split markdown text into overlapping chunks, preserving section headers.
 * Each chunk carries its source line range.
 */
export function chunkMarkdown(text: string, path: string, opts?: { tokens?: number; overlap?: number }): FileChunk[] {
  const maxChars = (opts?.tokens ?? DEFAULT_CHUNK_TOKENS) * CHARS_PER_TOKEN
  const overlapChars = (opts?.overlap ?? DEFAULT_CHUNK_OVERLAP) * CHARS_PER_TOKEN
  const lines = text.split('\n')
  if (lines.length === 0) return []

  const chunks: FileChunk[] = []
  let chunkLines: string[] = []
  let chunkStart = 1 // 1-indexed
  let chunkChars = 0
  let lastHeader = ''

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const lineNum = i + 1

    // Track the most recent markdown header
    if (/^#{1,4}\s/.test(line)) {
      lastHeader = line
    }

    chunkLines.push(line)
    chunkChars += line.length + 1 // +1 for newline

    if (chunkChars >= maxChars) {
      const chunkText = chunkLines.join('\n').trim()
      if (chunkText.length > 0) {
        chunks.push({
          path,
          startLine: chunkStart,
          endLine: lineNum,
          text: chunkText,
        })
      }

      // Start next chunk with overlap
      const overlapLines: string[] = []
      let overlapLen = 0
      // Include the last header for context continuity
      if (lastHeader && !chunkLines.slice(-Math.ceil(overlapChars / 40)).includes(lastHeader)) {
        overlapLines.push(lastHeader)
        overlapLen += lastHeader.length + 1
      }
      // Take lines from the end of the current chunk for overlap
      for (let j = chunkLines.length - 1; j >= 0 && overlapLen < overlapChars; j--) {
        overlapLines.unshift(chunkLines[j])
        overlapLen += chunkLines[j].length + 1
      }

      chunkLines = overlapLines
      chunkStart = lineNum - overlapLines.length + 1
      chunkChars = overlapLen
    }
  }

  // Flush remaining
  const remaining = chunkLines.join('\n').trim()
  if (remaining.length > 0) {
    chunks.push({
      path,
      startLine: chunkStart,
      endLine: lines.length,
      text: remaining,
    })
  }

  return chunks
}

/**
 * Index workspace memory files (MEMORY.md + memory/*.md) into LanceDB.
 *
 * @param readFile  Reads a workspace file by relative path. Returns { content: string }.
 * @param listFiles Lists files in a workspace directory. Returns { files: Array<{ name, type }> }.
 * @param embedFn   Generates an embedding vector for a text string.
 * @param agentId   Agent ID for LanceDB entries.
 */
export async function indexWorkspaceMemory(
  readFile: (path: string) => Promise<{ content: string }>,
  listFiles: (path: string) => Promise<{ files: Array<{ name: string; type: string }> }>,
  embedFn: (text: string) => Promise<number[]>,
  agentId: string,
): Promise<{ indexed: number; errors: string[] }> {
  let indexed = 0
  const errors: string[] = []

  // Clear existing file-indexed entries
  try {
    const existing = await LanceDB.list({ prefix: 'file:' })
    for (const key of existing.keys) {
      await LanceDB.delete({ key })
    }
  } catch {
    // Table may not exist yet — that's fine
  }

  // Collect files to index
  const filesToIndex: string[] = []

  // 1. MEMORY.md
  try {
    const result = await readFile('MEMORY.md')
    if (result.content && result.content.trim().length > 0) {
      filesToIndex.push('MEMORY.md')
    }
  } catch {
    // File doesn't exist — skip
  }

  // 2. memory/*.md
  try {
    const listing = await listFiles('memory')
    for (const f of listing.files) {
      if (f.type === 'file' && f.name.endsWith('.md')) {
        filesToIndex.push(`memory/${f.name}`)
      }
    }
  } catch {
    // Directory doesn't exist — skip
  }

  // Index each file
  for (const filePath of filesToIndex) {
    try {
      const { content } = await readFile(filePath)
      if (!content || content.trim().length === 0) continue

      const chunks = chunkMarkdown(content, filePath)
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i]
        const key = `file:${filePath}:${i}`
        const embedding = await embedFn(chunk.text)
        const metadata = JSON.stringify({
          source: 'file',
          path: chunk.path,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          chunkIndex: i,
        })

        await LanceDB.store({
          key,
          agentId,
          text: chunk.text,
          embedding,
          metadata,
        })
        indexed++
      }
    } catch (e) {
      errors.push(`${filePath}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  return { indexed, errors }
}
