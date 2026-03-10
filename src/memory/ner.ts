/**
 * Lightweight regex-based Named Entity Recognition (NER).
 *
 * SPRIG-inspired zero-LLM-cost entity extraction for recall augmentation.
 * Extracts entity name candidates from text using pattern matching — NOT
 * used for graph population (that uses LLM extraction). Used only to seed
 * graph context expansion during recall.
 */

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'as', 'is', 'was', 'are', 'were', 'been',
  'be', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
  'could', 'should', 'may', 'might', 'shall', 'can', 'not', 'no', 'nor',
  'so', 'yet', 'both', 'either', 'neither', 'each', 'every', 'all',
  'any', 'few', 'more', 'most', 'other', 'some', 'such', 'than', 'too',
  'very', 'just', 'about', 'above', 'after', 'again', 'also', 'because',
  'before', 'between', 'into', 'through', 'during', 'out', 'off', 'over',
  'under', 'up', 'down', 'then', 'once', 'here', 'there', 'when', 'where',
  'why', 'how', 'what', 'which', 'who', 'whom', 'this', 'that', 'these',
  'those', 'am', 'it', 'its', 'my', 'your', 'his', 'her', 'our', 'their',
  'i', 'you', 'he', 'she', 'we', 'they', 'me', 'him', 'us', 'them',
  // Common sentence starters that aren't entities
  'if', 'while', 'until', 'since', 'although', 'however', 'therefore',
  'meanwhile', 'furthermore', 'moreover', 'nevertheless', 'otherwise',
  'regardless', 'instead', 'perhaps', 'maybe', 'probably', 'certainly',
])

// Minimum length to consider as entity name
const MIN_ENTITY_LENGTH = 2

/**
 * Extract entity name candidates from text using lightweight patterns.
 *
 * Patterns:
 * 1. Capitalized word sequences (proper nouns): "John Smith", "New York"
 * 2. @mentions: "@alice"
 * 3. Quoted strings: "some entity"
 * 4. CamelCase identifiers: "MyProject", "GraphRAG"
 *
 * Returns deduplicated, stopword-filtered entity names.
 */
export function extractEntityNames(text: string): string[] {
  const candidates = new Set<string>()

  // 1. Capitalized word sequences (2+ chars, allowing hyphens and dots)
  //    Matches: "John Smith", "New York City", "U.S.A", "Jean-Claude"
  const capitalizedRe = /\b([A-Z][a-zA-Z.\-']+(?:\s+[A-Z][a-zA-Z.\-']+)*)\b/g
  let match: RegExpExecArray | null
  while ((match = capitalizedRe.exec(text)) !== null) {
    const candidate = match[1].trim()
    if (candidate.length >= MIN_ENTITY_LENGTH && !isStopword(candidate)) {
      candidates.add(candidate)
    }
  }

  // 2. @mentions
  const mentionRe = /@(\w+)/g
  while ((match = mentionRe.exec(text)) !== null) {
    if (match[1].length >= MIN_ENTITY_LENGTH) {
      candidates.add(match[1])
    }
  }

  // 3. Quoted strings (single or double quotes, max 50 chars)
  const quotedRe = /["']([^"']{2,50})["']/g
  while ((match = quotedRe.exec(text)) !== null) {
    const candidate = match[1].trim()
    if (candidate.length >= MIN_ENTITY_LENGTH && !isStopword(candidate)) {
      candidates.add(candidate)
    }
  }

  // 4. CamelCase identifiers (at least 2 uppercase transitions)
  const camelRe = /\b([A-Z][a-z]+(?:[A-Z][a-z]+)+)\b/g
  while ((match = camelRe.exec(text)) !== null) {
    candidates.add(match[1])
  }

  return [...candidates]
}

function isStopword(text: string): boolean {
  return STOPWORDS.has(text.toLowerCase())
}
