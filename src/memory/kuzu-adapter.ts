/**
 * Kuzu graph database adapter for the memory system.
 *
 * Provides a KuzuGraphAdapter interface + KuzuGraphAdapterImpl that wraps
 * a capacitor-kuzu connection to execute Cypher queries for knowledge graph
 * operations. The consumer injects a KuzuConnection at construction time —
 * this module does NOT import capacitor-kuzu directly.
 *
 * Inspired by:
 * - Mem0: entity-centric subgraph expansion, parallel graph+vector ops
 * - Zep/Graphiti: bi-temporal relations (validFrom/validUntil)
 * - SPRIG: lightweight NER for zero-cost entity seeding
 */

import { getSchemaStatements, relTypeToTable, tableToRelType } from './kuzu-schema'
import type {
  GraphQueryResult,
  KuzuConnection,
  KuzuGraphAdapter,
  MemorySource,
  RelationType,
  StoredEntity,
  StoredRelation,
} from './types'

// ── Implementation ───────────────────────────────────────────────────

export class KuzuGraphAdapterImpl implements KuzuGraphAdapter {
  private _conn: KuzuConnection | null = null
  private _initialized = false

  /**
   * @param connFactory — called once during open() to obtain a KuzuConnection.
   *   The consumer creates the database + connection via capacitor-kuzu and
   *   passes a factory that returns the connection's query method.
   */
  constructor(private readonly _connFactory: (dbPath: string, pathType?: string) => Promise<KuzuConnection>) {}

  async open(opts: { dbPath: string; pathType?: string }): Promise<void> {
    if (this._initialized) return
    this._conn = await this._connFactory(opts.dbPath, opts.pathType)

    // Create schema (IF NOT EXISTS — safe to run multiple times)
    for (const ddl of getSchemaStatements()) {
      await this._conn.query(ddl)
    }
    this._initialized = true
  }

  async close(): Promise<void> {
    if (this._conn?.close) await this._conn.close()
    this._conn = null
    this._initialized = false
  }

  private _requireConn(): KuzuConnection {
    if (!this._conn) throw new Error('KuzuGraphAdapter not initialized — call open() first')
    return this._conn
  }

  // ── Entity CRUD ──────────────────────────────────────────────────

  async addEntity(entity: StoredEntity): Promise<{ id: string }> {
    const conn = this._requireConn()
    await conn.query(
      `CREATE (e:Entity {
        id: $id, entityType: $entityType, name: $name,
        propertiesJson: $propertiesJson, confidence: $confidence,
        source: $source, createdAt: $createdAt, accessedAt: $accessedAt,
        accessCount: $accessCount, deleted: $deleted
      })`,
      {
        id: entity.id,
        entityType: entity.entityType,
        name: entity.name,
        propertiesJson: entity.propertiesJson,
        confidence: entity.confidence,
        source: entity.source,
        createdAt: entity.createdAt,
        accessedAt: entity.accessedAt,
        accessCount: entity.accessCount,
        deleted: entity.deleted,
      },
    )
    return { id: entity.id }
  }

  async updateEntity(entity: StoredEntity): Promise<void> {
    const conn = this._requireConn()
    await conn.query(
      `MATCH (e:Entity {id: $id})
       SET e.entityType = $entityType, e.name = $name,
           e.propertiesJson = $propertiesJson, e.confidence = $confidence,
           e.source = $source, e.accessedAt = $accessedAt,
           e.accessCount = $accessCount, e.deleted = $deleted`,
      {
        id: entity.id,
        entityType: entity.entityType,
        name: entity.name,
        propertiesJson: entity.propertiesJson,
        confidence: entity.confidence,
        source: entity.source,
        accessedAt: entity.accessedAt,
        accessCount: entity.accessCount,
        deleted: entity.deleted,
      },
    )
  }

  async softDeleteEntity(id: string): Promise<void> {
    const conn = this._requireConn()
    await conn.query('MATCH (e:Entity {id: $id}) SET e.deleted = true', { id })
  }

  async touchEntity(id: string): Promise<void> {
    const conn = this._requireConn()
    const now = new Date().toISOString()
    await conn.query(
      `MATCH (e:Entity {id: $id})
       SET e.accessedAt = $now, e.accessCount = e.accessCount + 1`,
      { id, now },
    )
  }

  // ── Relation CRUD ────────────────────────────────────────────────

  async addRelation(
    relation: StoredRelation & { validFrom?: string; validUntil?: string },
  ): Promise<{ id: string }> {
    const conn = this._requireConn()
    const table = relTypeToTable(relation.relationType)
    await conn.query(
      `MATCH (src:Entity {id: $srcId}), (tgt:Entity {id: $tgtId})
       CREATE (src)-[:${table} {
         id: $id, confidence: $confidence, source: $source,
         createdAt: $createdAt, accessedAt: $accessedAt,
         accessCount: $accessCount, deleted: $deleted,
         propertiesJson: $propertiesJson,
         validFrom: $validFrom, validUntil: $validUntil
       }]->(tgt)`,
      {
        srcId: relation.sourceId,
        tgtId: relation.targetId,
        id: relation.id,
        confidence: relation.confidence,
        source: relation.source,
        createdAt: relation.createdAt,
        accessedAt: relation.accessedAt,
        accessCount: relation.accessCount,
        deleted: relation.deleted,
        propertiesJson: '{}',
        validFrom: relation.validFrom ?? relation.createdAt,
        validUntil: relation.validUntil ?? '',
      },
    )
    return { id: relation.id }
  }

  async softDeleteRelation(id: string): Promise<void> {
    const conn = this._requireConn()
    // Must search across all rel tables since we don't know the type
    for (const table of ALL_REL_TABLE_NAMES) {
      await conn.query(
        `MATCH ()-[r:${table} {id: $id}]->() SET r.deleted = true`,
        { id },
      ).catch(() => {}) // Ignore if relation not in this table
    }
  }

  async invalidateRelation(id: string, validUntil: string): Promise<void> {
    const conn = this._requireConn()
    for (const table of ALL_REL_TABLE_NAMES) {
      await conn.query(
        `MATCH ()-[r:${table} {id: $id}]->() SET r.validUntil = $validUntil`,
        { id, validUntil },
      ).catch(() => {})
    }
  }

  // ── Queries ──────────────────────────────────────────────────────

  async queryGraph(opts?: { entityType?: string; namePattern?: string }): Promise<GraphQueryResult> {
    const conn = this._requireConn()

    // Build WHERE clause
    const conditions: string[] = ['e.deleted = false']
    const params: Record<string, unknown> = {}

    if (opts?.entityType) {
      conditions.push('e.entityType = $entityType')
      params.entityType = opts.entityType
    }
    if (opts?.namePattern) {
      conditions.push('e.name CONTAINS $namePattern')
      params.namePattern = opts.namePattern
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

    // Fetch matching entities
    const entityResult = await conn.query(
      `MATCH (e:Entity) ${where}
       RETURN e.id, e.entityType, e.name, e.propertiesJson, e.confidence,
              e.source, e.createdAt, e.accessedAt, e.accessCount, e.deleted`,
      params,
    )
    const entities = parseEntityRows(entityResult.rows)

    // Fetch relations for matched entities (1-hop)
    const entityIds = entities.map((e) => e.id)
    const relations = entityIds.length > 0 ? await this._fetchRelationsForEntities(entityIds) : []

    return { entities, relations }
  }

  async expandNeighborhood(opts: {
    entityIds: string[]
    maxHops: number
    limit: number
  }): Promise<GraphQueryResult> {
    const conn = this._requireConn()
    if (opts.entityIds.length === 0) return { entities: [], relations: [] }

    const hops = Math.min(opts.maxHops, 3) // Cap at 3 hops

    // Variable-length path expansion
    const result = await conn.query(
      `MATCH (seed:Entity)-[r*1..${hops}]-(neighbor:Entity)
       WHERE seed.id IN $ids AND seed.deleted = false AND neighbor.deleted = false
       RETURN DISTINCT neighbor.id, neighbor.entityType, neighbor.name,
              neighbor.propertiesJson, neighbor.confidence, neighbor.source,
              neighbor.createdAt, neighbor.accessedAt, neighbor.accessCount, neighbor.deleted
       LIMIT $limit`,
      { ids: opts.entityIds, limit: opts.limit },
    )

    const entities = parseEntityRows(result.rows)
    const allIds = [...new Set([...opts.entityIds, ...entities.map((e) => e.id)])]
    const relations = await this._fetchRelationsForEntities(allIds)

    return { entities, relations }
  }

  async getEntityContext(opts: {
    entityNames: string[]
    maxHops: number
    limit: number
  }): Promise<{ entities: StoredEntity[]; relations: StoredRelation[]; contextText: string }> {
    const conn = this._requireConn()
    if (opts.entityNames.length === 0) {
      return { entities: [], relations: [], contextText: '' }
    }

    // Find seed entities by name
    const seedResult = await conn.query(
      `MATCH (e:Entity)
       WHERE e.deleted = false AND e.name IN $names
       RETURN e.id, e.entityType, e.name, e.propertiesJson, e.confidence,
              e.source, e.createdAt, e.accessedAt, e.accessCount, e.deleted`,
      { names: opts.entityNames },
    )
    const seedEntities = parseEntityRows(seedResult.rows)
    if (seedEntities.length === 0) {
      return { entities: [], relations: [], contextText: '' }
    }

    // Expand neighborhood
    const seedIds = seedEntities.map((e) => e.id)
    const { entities: neighborEntities, relations } = await this.expandNeighborhood({
      entityIds: seedIds,
      maxHops: opts.maxHops,
      limit: opts.limit,
    })

    // Merge seed + neighbor entities (dedup)
    const allEntities = deduplicateEntities([...seedEntities, ...neighborEntities])

    // Format as readable context text
    const contextText = formatGraphContext(allEntities, relations)

    return { entities: allEntities, relations, contextText }
  }

  async getHubs(opts: {
    limit: number
    entityType?: string
  }): Promise<Array<{ entity: StoredEntity; degree: number }>> {
    const conn = this._requireConn()

    const typeFilter = opts.entityType ? 'AND e.entityType = $entityType' : ''
    const params: Record<string, unknown> = { limit: opts.limit }
    if (opts.entityType) params.entityType = opts.entityType

    // Count connections per entity across all rel tables
    // Use a simple approach: query each rel table and aggregate in TypeScript
    const degreeMap = new Map<string, number>()
    const entityMap = new Map<string, StoredEntity>()

    const entityResult = await conn.query(
      `MATCH (e:Entity)
       WHERE e.deleted = false ${typeFilter}
       RETURN e.id, e.entityType, e.name, e.propertiesJson, e.confidence,
              e.source, e.createdAt, e.accessedAt, e.accessCount, e.deleted`,
      params,
    )
    for (const ent of parseEntityRows(entityResult.rows)) {
      entityMap.set(ent.id, ent)
      degreeMap.set(ent.id, 0)
    }

    // Count relations per entity
    for (const table of ALL_REL_TABLE_NAMES) {
      try {
        const relResult = await conn.query(
          `MATCH (a:Entity)-[r:${table}]-(b:Entity)
           WHERE r.deleted = false
           RETURN a.id AS entityId, count(r) AS cnt`,
        )
        for (const row of relResult.rows) {
          const id = row[0] as string
          const cnt = Number(row[1])
          degreeMap.set(id, (degreeMap.get(id) ?? 0) + cnt)
        }
      } catch {
        // Table may not exist yet
      }
    }

    // Sort by degree, take top N
    const sorted = [...degreeMap.entries()]
      .filter(([id]) => entityMap.has(id))
      .sort((a, b) => b[1] - a[1])
      .slice(0, opts.limit)

    return sorted.map(([id, degree]) => ({
      entity: entityMap.get(id)!,
      degree,
    }))
  }

  async rawQuery(cypher: string, params?: Record<string, unknown>): Promise<unknown> {
    const conn = this._requireConn()
    return conn.query(cypher, params)
  }

  // ── Stats ────────────────────────────────────────────────────────

  async entityCount(): Promise<number> {
    const conn = this._requireConn()
    const result = await conn.query(
      'MATCH (e:Entity) WHERE e.deleted = false RETURN count(e)',
    )
    return Number(result.rows[0]?.[0] ?? 0)
  }

  async relationCount(): Promise<number> {
    const conn = this._requireConn()
    let total = 0
    for (const table of ALL_REL_TABLE_NAMES) {
      try {
        const result = await conn.query(
          `MATCH ()-[r:${table}]->() WHERE r.deleted = false RETURN count(r)`,
        )
        total += Number(result.rows[0]?.[0] ?? 0)
      } catch {
        // Table may not exist
      }
    }
    return total
  }

  // ── Private helpers ──────────────────────────────────────────────

  private async _fetchRelationsForEntities(entityIds: string[]): Promise<StoredRelation[]> {
    const conn = this._requireConn()
    const relations: StoredRelation[] = []

    for (const table of ALL_REL_TABLE_NAMES) {
      try {
        const result = await conn.query(
          `MATCH (a:Entity)-[r:${table}]->(b:Entity)
           WHERE (a.id IN $ids OR b.id IN $ids) AND r.deleted = false
           RETURN r.id, a.id, b.id, r.confidence, r.source,
                  r.createdAt, r.accessedAt, r.accessCount, r.deleted, r.propertiesJson,
                  r.validFrom, r.validUntil`,
          { ids: entityIds },
        )
        const relType = tableToRelType(table)
        for (const row of result.rows) {
          relations.push({
            id: (row[0] as string) ?? '',
            sourceId: row[1] as string,
            relationType: relType,
            targetId: row[2] as string,
            confidence: Number(row[3] ?? 1),
            source: (row[4] as MemorySource) ?? 'System',
            createdAt: (row[5] as string) ?? '',
            accessedAt: (row[6] as string) ?? '',
            accessCount: Number(row[7] ?? 0),
            deleted: Boolean(row[8]),
          })
        }
      } catch {
        // Table may not exist yet
      }
    }

    return relations
  }
}

// ── Import from schema ─────────────────────────────────────────────

import { ALL_REL_TABLES as ALL_REL_TABLE_NAMES } from './kuzu-schema'

// ── Result parsing helpers ─────────────────────────────────────────

function parseEntityRows(rows: unknown[][]): StoredEntity[] {
  return rows.map((row) => ({
    id: row[0] as string,
    entityType: row[1] as StoredEntity['entityType'],
    name: row[2] as string,
    propertiesJson: (row[3] as string) ?? '{}',
    confidence: Number(row[4] ?? 1),
    source: (row[5] as MemorySource) ?? 'System',
    createdAt: (row[6] as string) ?? '',
    accessedAt: (row[7] as string) ?? '',
    accessCount: Number(row[8] ?? 0),
    deleted: Boolean(row[9]),
  }))
}

function deduplicateEntities(entities: StoredEntity[]): StoredEntity[] {
  const seen = new Map<string, StoredEntity>()
  for (const e of entities) {
    if (!seen.has(e.id)) seen.set(e.id, e)
  }
  return [...seen.values()]
}

function formatGraphContext(entities: StoredEntity[], relations: StoredRelation[]): string {
  if (entities.length === 0) return ''

  const entityMap = new Map(entities.map((e) => [e.id, e]))
  const lines: string[] = []

  // Entity list
  for (const e of entities) {
    lines.push(`- ${e.name} (${e.entityType})`)
  }

  // Relation list
  if (relations.length > 0) {
    lines.push('')
    for (const r of relations) {
      const src = entityMap.get(r.sourceId)
      const tgt = entityMap.get(r.targetId)
      if (src && tgt) {
        lines.push(`- ${src.name} --[${r.relationType}]--> ${tgt.name}`)
      }
    }
  }

  return lines.join('\n')
}
