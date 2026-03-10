/**
 * LLM entity extraction prompt and response parser.
 *
 * This module provides the prompt template and parser for extracting
 * structured entities and relations from text. It does NOT call the LLM
 * directly — the consumer injects an `extractEntities` callback.
 */

import type { EntityType, ExtractionResult, RelationType } from './types'

const VALID_ENTITY_TYPES: Set<string> = new Set([
  'Person', 'Organization', 'Project', 'Concept',
  'Location', 'Tool', 'File', 'Other',
])

const VALID_RELATION_TYPES: Set<string> = new Set([
  'WorksAt', 'KnowsAbout', 'RelatedTo', 'DependsOn',
  'OwnedBy', 'CreatedBy', 'LocatedIn', 'PartOf', 'Uses', 'Produces',
])

/**
 * Build the extraction prompt for a given text.
 * The LLM should return JSON matching ExtractionResult.
 */
export function buildExtractionPrompt(text: string): string {
  return `Extract entities and relations from the following text.

Entity types: Person, Organization, Project, Concept, Location, Tool, File, Other
Relation types: WorksAt, KnowsAbout, RelatedTo, DependsOn, OwnedBy, CreatedBy, LocatedIn, PartOf, Uses, Produces

Return ONLY valid JSON (no markdown fences) matching this schema:
{
  "entities": [{ "name": "...", "type": "...", "properties": {} }],
  "relations": [{ "sourceName": "...", "type": "...", "targetName": "..." }]
}

If no entities or relations are found, return: { "entities": [], "relations": [] }

Text:
${text}`
}

/**
 * Parse LLM response into a validated ExtractionResult.
 * Gracefully handles malformed output by returning empty arrays.
 */
export function parseExtractionResponse(response: string): ExtractionResult {
  const empty: ExtractionResult = { entities: [], relations: [] }

  try {
    // Strip markdown code fences if present
    let json = response.trim()
    if (json.startsWith('```')) {
      json = json.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '')
    }

    const parsed = JSON.parse(json)
    if (!parsed || typeof parsed !== 'object') return empty

    const entities = Array.isArray(parsed.entities)
      ? parsed.entities
          .filter(
            (e: Record<string, unknown>) =>
              typeof e.name === 'string' &&
              e.name.length > 0 &&
              typeof e.type === 'string' &&
              VALID_ENTITY_TYPES.has(e.type),
          )
          .map((e: Record<string, unknown>) => ({
            name: e.name as string,
            type: e.type as EntityType,
            properties:
              e.properties && typeof e.properties === 'object'
                ? (e.properties as Record<string, unknown>)
                : undefined,
          }))
      : []

    const relations = Array.isArray(parsed.relations)
      ? parsed.relations
          .filter(
            (r: Record<string, unknown>) =>
              typeof r.sourceName === 'string' &&
              r.sourceName.length > 0 &&
              typeof r.type === 'string' &&
              VALID_RELATION_TYPES.has(r.type) &&
              typeof r.targetName === 'string' &&
              r.targetName.length > 0,
          )
          .map((r: Record<string, unknown>) => ({
            sourceName: r.sourceName as string,
            type: r.type as RelationType,
            targetName: r.targetName as string,
          }))
      : []

    return { entities, relations }
  } catch {
    return empty
  }
}
