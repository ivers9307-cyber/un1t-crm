// The tag vocabulary of one studio, with a live count per tag: the UNION of
//
//   TAG_RULES ∪ PLATFORM_TAGS ∪ (distinct live tag in contact_tags there)
//
// Extracted from GET /api/segments (FILTER-A.3) so the audience builder and the
// pipeline builder's entry-rule picker (PIPEBUILD.5f) offer the same tags; see
// that route's header for why the third arm matters. Service role: the caller
// has already judged access to `locationId`, and every read is scoped to it.
import { TAG_RULES } from '@/lib/contact-events'
import { PLATFORM_TAGS, describeTag } from '@/lib/sequences/tag-vocabulary'
import { selectAll } from '@/lib/select-all'

/**
 * Live tag counts at one studio. ONE scan, paginated: contact_tags at a busy
 * studio is well over the 1000-row cap, and a truncated scan would undercount
 * silently. Throws on a read error (selectAll's contract).
 * @returns {Promise<Map<string, number>>}
 */
export async function studioTagCounts(db, locationId) {
  const rows = await selectAll((from, to) => db
    .from('contact_tags')
    .select('tag')
    .eq('location_id', locationId)
    .is('removed_at', null)
    .order('tag', { ascending: true })
    .range(from, to))
  const counts = new Map()
  for (const r of rows || []) {
    if (!r?.tag) continue
    counts.set(r.tag, (counts.get(r.tag) || 0) + 1)
  }
  return counts
}

/**
 * The vocabulary for a set of counts: union, de-duplicated, used tags first
 * (a tag with reach is more useful at the top of a dropdown than the
 * alphabetically-first echo of a webhook nobody targets).
 * @param {Map<string, number>} counts
 * @returns {Array<{ tag: string, description: string, count: number, inUse: boolean }>}
 */
export function buildTagVocabulary(counts = new Map()) {
  const ruleDescriptions = new Map(TAG_RULES.map((r) => [r.tag, r.description]))
  const tags = Array.from(new Set([
    ...TAG_RULES.map((r) => r.tag),
    ...PLATFORM_TAGS,
    ...counts.keys(),
  ]))
  return tags
    .map((tag) => ({
      tag,
      description: describeTag(tag, ruleDescriptions.get(tag)),
      count: counts.get(tag) || 0,
      inUse: (counts.get(tag) || 0) > 0,
    }))
    .sort((a, b) => (b.count - a.count) || a.tag.localeCompare(b.tag))
}

/** The vocabulary at one studio. Throws on a read error. */
export async function studioTagVocabulary(db, locationId) {
  return buildTagVocabulary(await studioTagCounts(db, locationId))
}
