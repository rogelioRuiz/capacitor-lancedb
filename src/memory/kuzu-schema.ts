/**
 * Kuzu graph database schema definitions.
 *
 * Defines the Cypher DDL for the knowledge graph schema, relation type
 * to table name mapping, and schema initialization helpers.
 */

import type { RelationType } from './types'

// ── Relation type → Kuzu table name mapping ──────────────────────────

const RELATION_TABLE_MAP: Record<RelationType, string> = {
  WorksAt: 'WORKS_AT',
  KnowsAbout: 'KNOWS_ABOUT',
  RelatedTo: 'RELATED_TO',
  DependsOn: 'DEPENDS_ON',
  OwnedBy: 'OWNED_BY',
  CreatedBy: 'CREATED_BY',
  LocatedIn: 'LOCATED_IN',
  PartOf: 'PART_OF',
  Uses: 'USES',
  Produces: 'PRODUCES',
}

/** Convert a RelationType enum value to a Kuzu REL TABLE name. */
export function relTypeToTable(relationType: RelationType): string {
  return RELATION_TABLE_MAP[relationType] ?? 'RELATED_TO'
}

/** Convert a Kuzu REL TABLE name back to a RelationType enum value. */
export function tableToRelType(tableName: string): RelationType {
  for (const [rel, table] of Object.entries(RELATION_TABLE_MAP)) {
    if (table === tableName) return rel as RelationType
  }
  return 'RelatedTo'
}

/** All relation table names for iteration during schema init. */
export const ALL_REL_TABLES = Object.values(RELATION_TABLE_MAP)

// ── Schema DDL ───────────────────────────────────────────────────────

export const ENTITY_TABLE_DDL = `
CREATE NODE TABLE IF NOT EXISTS Entity (
  id STRING,
  entityType STRING,
  name STRING,
  propertiesJson STRING DEFAULT '{}',
  confidence DOUBLE DEFAULT 1.0,
  source STRING DEFAULT 'System',
  createdAt STRING,
  accessedAt STRING,
  accessCount INT64 DEFAULT 0,
  deleted BOOLEAN DEFAULT FALSE,
  PRIMARY KEY (id)
)`.trim()

/**
 * Generate the DDL for a single relation table.
 * All rel tables share the same column set — only the table name differs.
 */
function relTableDDL(tableName: string): string {
  return `
CREATE REL TABLE IF NOT EXISTS ${tableName} (
  FROM Entity TO Entity,
  id STRING,
  confidence DOUBLE DEFAULT 1.0,
  source STRING DEFAULT 'System',
  createdAt STRING,
  accessedAt STRING,
  accessCount INT64 DEFAULT 0,
  deleted BOOLEAN DEFAULT FALSE,
  propertiesJson STRING DEFAULT '{}',
  validFrom STRING,
  validUntil STRING
)`.trim()
}

/** All DDL statements needed to initialize the schema. */
export function getSchemaStatements(): string[] {
  return [
    ENTITY_TABLE_DDL,
    ...ALL_REL_TABLES.map(relTableDDL),
  ]
}
