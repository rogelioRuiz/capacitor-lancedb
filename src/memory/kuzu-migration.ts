/**
 * Kuzu graph migration + export/import utilities.
 *
 * - migrateFromAgentOs: One-time migration from SQLite (agent-os) to Kuzu
 * - exportGraph: Export Kuzu graph to portable JSON
 * - importGraph: Import portable JSON into Kuzu graph
 *
 * The portable JSON format works with any future graph backend,
 * mitigating Apple-Kuzu acquisition risk.
 */

import type {
  AgentOsAdapter,
  KuzuGraphAdapter,
  MemorySource,
  StoredEntity,
  StoredRelation,
} from './types'

// ── Portable format ───────────────────────────────────────────────────

export interface PortableGraph {
  version: 1
  exportedAt: string
  entities: StoredEntity[]
  relations: (StoredRelation & { validFrom?: string; validUntil?: string })[]
}

// ── Migration from agent-os SQLite ────────────────────────────────────

const MIGRATION_FLAG_ID = '_migration_v1'

/**
 * Migrate entities and relations from agent-os SQLite graph to Kuzu.
 * Idempotent — checks for migration flag before proceeding.
 *
 * @returns Migration result with counts or skip reason.
 */
export async function migrateFromAgentOs(opts: {
  agentOs: AgentOsAdapter
  kuzuGraph: KuzuGraphAdapter
}): Promise<{ migrated: boolean; entities: number; relations: number; reason?: string }> {
  const { agentOs, kuzuGraph } = opts

  // Check if already migrated
  try {
    const existing = await kuzuGraph.queryGraph({ namePattern: MIGRATION_FLAG_ID })
    if (existing.entities.some((e) => e.id === MIGRATION_FLAG_ID)) {
      return { migrated: false, entities: 0, relations: 0, reason: 'already_migrated' }
    }
  } catch {
    // First run — no entities yet
  }

  // Read all from SQLite
  const graph = await agentOs.queryKnowledgeGraph()
  const { entities, relations } = graph

  // Batch insert entities
  let entityCount = 0
  for (const entity of entities) {
    try {
      await kuzuGraph.addEntity(entity)
      entityCount++
    } catch {
      // Skip duplicates or errors
    }
  }

  // Insert relations
  let relationCount = 0
  for (const relation of relations) {
    try {
      await kuzuGraph.addRelation({
        ...relation,
        validFrom: relation.createdAt,
      })
      relationCount++
    } catch {
      // Skip if source/target entity missing or other error
    }
  }

  // Set migration flag
  const now = new Date().toISOString()
  await kuzuGraph.addEntity({
    id: MIGRATION_FLAG_ID,
    entityType: 'Other',
    name: MIGRATION_FLAG_ID,
    propertiesJson: JSON.stringify({
      migratedAt: now,
      entityCount,
      relationCount,
    }),
    confidence: 1,
    source: 'System' as MemorySource,
    createdAt: now,
    accessedAt: now,
    accessCount: 0,
    deleted: false,
  })

  return { migrated: true, entities: entityCount, relations: relationCount }
}

// ── Export ─────────────────────────────────────────────────────────────

/**
 * Export the entire Kuzu graph to a portable JSON format.
 * Includes all non-deleted entities and relations.
 */
export async function exportGraph(kuzuGraph: KuzuGraphAdapter): Promise<PortableGraph> {
  const { entities, relations } = await kuzuGraph.queryGraph()

  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    entities: entities.filter((e) => e.id !== MIGRATION_FLAG_ID),
    relations,
  }
}

// ── Import ─────────────────────────────────────────────────────────────

/**
 * Import a portable JSON graph into Kuzu.
 * Skips entities/relations that already exist (by id).
 *
 * @returns Import result with counts.
 */
export async function importGraph(
  kuzuGraph: KuzuGraphAdapter,
  data: PortableGraph,
): Promise<{ entities: number; relations: number; skipped: number }> {
  let entityCount = 0
  let relationCount = 0
  let skipped = 0

  for (const entity of data.entities) {
    try {
      await kuzuGraph.addEntity(entity)
      entityCount++
    } catch {
      skipped++
    }
  }

  for (const relation of data.relations) {
    try {
      await kuzuGraph.addRelation(relation)
      relationCount++
    } catch {
      skipped++
    }
  }

  return { entities: entityCount, relations: relationCount, skipped }
}
