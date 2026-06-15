// src/lib/person-match.js — duplicate contact candidate detection (PERSON-LINK.2)

import { normalisePhone9, normaliseName } from './person-links.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const CLASSPASS_STATUS = 'classpass_payg'

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function isClassPass(c) {
  return c.glofox_membership_status === CLASSPASS_STATUS
}

export function contactName(c) {
  const raw = c.name || `${c.first_name || ''} ${c.last_name || ''}`
  return normaliseName(raw)
}

export function contactPhone9(c) {
  return normalisePhone9(c.phone || c.wa_phone)
}

/**
 * pairKey(id1, id2) → canonical '<min>:<max>' string so A:B === B:A.
 * Sorts the two ids as strings ascending.
 */
export function pairKey(id1, id2) {
  const a = String(id1)
  const b = String(id2)
  return a <= b ? `${a}:${b}` : `${b}:${a}`
}

// ---------------------------------------------------------------------------
// Placeholder phone detection
// ---------------------------------------------------------------------------

/**
 * placeholderPhones(contacts, { threshold = 10 } = {})
 * Returns a Set of normalised phone strings (contactPhone9) that appear on
 * STRICTLY MORE THAN `threshold` contacts across the full contacts array.
 * Catches the ~1,569-contact ClassPass placeholder number and any shared
 * reception / landline numbers.
 */
export function placeholderPhones(contacts, { threshold = 10 } = {}) {
  const counts = new Map()
  for (const c of contacts) {
    const ph = contactPhone9(c)
    if (ph) counts.set(ph, (counts.get(ph) ?? 0) + 1)
  }
  const placeholders = new Set()
  for (const [ph, n] of counts) {
    if (n > threshold) placeholders.add(ph)
  }
  return placeholders
}

// ---------------------------------------------------------------------------
// Confidence ordering helper (for dedup)
// ---------------------------------------------------------------------------

const CONFIDENCE_RANK = { high: 2, medium: 1, low: 0 }

// ---------------------------------------------------------------------------
// Main detection function
// ---------------------------------------------------------------------------

/**
 * detectCandidates(contacts, options)
 *
 * Returns array of { aId, bId, method, confidence, reason } with aId < bId.
 *
 * @param {Array}  contacts                   - Full contact array for this location
 * @param {Set}    options.dismissedPairKeys   - pairKey strings to skip
 * @param {Map}    options.groupOf             - contactId → groupId (already linked)
 * @param {Map}    options.primaryByGroup      - groupId → primaryContactId
 * @param {number} options.placeholderThreshold - threshold for placeholder detection
 */
export function detectCandidates(contacts, {
  dismissedPairKeys = new Set(),
  groupOf = new Map(),
  primaryByGroup = new Map(),
  placeholderThreshold = 10,
} = {}) {
  // ---------------------------------------------------------------------------
  // Person identity helpers
  // ---------------------------------------------------------------------------

  // Set of valid contact ids — used to guard against emitting candidates
  // with group ids when primaryByGroup is incomplete.
  const contactIdSet = new Set(contacts.map(c => c.id))

  // A contact's "person" identity: its group id if grouped, else its own id.
  function personOf(c) {
    return groupOf.get(c.id) ?? c.id
  }

  // The contact to link TO for a person: the group's primary if it's a group,
  // else the contact itself.
  function repOf(personId) {
    return primaryByGroup.get(personId) ?? personId
  }

  // Map from pairKey → best candidate so far (for dedup)
  const best = new Map()

  function consider(aId, bId, candidate) {
    const key = pairKey(aId, bId)

    // Drop dismissed pairs
    if (dismissedPairKeys.has(key)) return

    // Drop if the two endpoints resolve to the SAME person (already linked)
    const pA = groupOf.get(aId) ?? aId
    const pB = groupOf.get(bId) ?? bId
    if (pA === pB) return

    // Dedup: keep the highest-confidence match for this pair
    const existing = best.get(key)
    if (!existing || CONFIDENCE_RANK[candidate.confidence] > CONFIDENCE_RANK[existing.confidence]) {
      // Enforce canonical aId < bId
      const [minId, maxId] = String(aId) <= String(bId) ? [aId, bId] : [bId, aId]
      best.set(key, { aId: minId, bId: maxId, ...candidate })
    }
  }

  // ---------------------------------------------------------------------------
  // 1. Phone-based matching (non-ClassPass only)
  // ---------------------------------------------------------------------------

  const placeholders = placeholderPhones(contacts, { threshold: placeholderThreshold })

  // Group non-ClassPass contacts by normalised phone (skip nulls and placeholders)
  const byPhone = new Map()
  for (const c of contacts) {
    if (isClassPass(c)) continue
    const ph = contactPhone9(c)
    if (!ph) continue
    if (placeholders.has(ph)) continue
    if (!byPhone.has(ph)) byPhone.set(ph, [])
    byPhone.get(ph).push(c)
  }

  for (const group of byPhone.values()) {
    const n = group.length
    if (n === 1) continue

    if (n === 2) {
      const [a, b] = group
      const nameA = contactName(a)
      const nameB = contactName(b)
      const sameNonEmptyName = nameA !== '' && nameA === nameB
      if (sameNonEmptyName) {
        consider(a.id, b.id, { method: 'phone', confidence: 'high', reason: 'Same phone and name' })
      } else {
        consider(a.id, b.id, { method: 'phone', confidence: 'medium', reason: 'Same phone, different name' })
      }
    } else {
      // n >= 3: every unordered pair is low-confidence
      const reason = `Phone shared by ${n} accounts`
      for (let i = 0; i < group.length; i++) {
        for (let j = i + 1; j < group.length; j++) {
          consider(group[i].id, group[j].id, { method: 'phone', confidence: 'low', reason })
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 2. Name-based matching (person-aware)
  // ---------------------------------------------------------------------------

  // Build realByName: Map<nname, Map<personId, repContactId>>
  // Collapses multi-account persons to ONE entry per name key.
  const realByName = new Map()
  for (const c of contacts) {
    if (isClassPass(c)) continue
    const nm = contactName(c)
    if (!nm) continue
    if (!realByName.has(nm)) realByName.set(nm, new Map())
    const personId = personOf(c)
    // repOf maps: grouped person → primary; ungrouped → itself
    realByName.get(nm).set(personId, repOf(personId))
  }

  // (a) ClassPass↔real: for each ClassPass contact, look up matching persons
  for (const c of contacts) {
    if (!isClassPass(c)) continue
    const nm = contactName(c)
    if (!nm) continue
    const persons = realByName.get(nm)
    if (!persons || persons.size === 0) continue

    if (persons.size === 1) {
      const [[, rep]] = persons
      // Guard: skip if rep is a group id (primaryByGroup incomplete)
      if (!contactIdSet.has(rep)) continue
      consider(c.id, rep, {
        method: 'name',
        confidence: 'high',
        reason: 'ClassPass matches one person',
      })
    } else {
      const reason = `ClassPass name matches ${persons.size} people`
      for (const rep of persons.values()) {
        // Guard: skip if rep is a group id (primaryByGroup incomplete)
        if (!contactIdSet.has(rep)) continue
        consider(c.id, rep, { method: 'name', confidence: 'medium', reason })
      }
    }
  }

  // (b) real↔real by name: for each name with ≥2 distinct persons,
  // emit a candidate for each unordered pair of distinct persons.
  for (const persons of realByName.values()) {
    if (persons.size < 2) continue
    const entries = Array.from(persons.entries()) // [personId, repId]

    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const [pId, pRep] = entries[i]
        const [qId, qRep] = entries[j]

        const pIsGroup = primaryByGroup.has(pId)
        const qIsGroup = primaryByGroup.has(qId)

        if (pIsGroup && qIsGroup) {
          // Both are already groups — skip, do not auto-merge two existing groups
          continue
        }

        // Guard: only emit if both reps are valid contact ids.
        // If primaryByGroup is incomplete (e.g. no entry for a group id),
        // repOf returns the group id itself which is not a contact id.
        if (!contactIdSet.has(pRep) || !contactIdSet.has(qRep)) continue

        if (pIsGroup !== qIsGroup) {
          // Exactly one is a group → HIGH: the singleton joins the group's primary
          consider(pRep, qRep, {
            method: 'name',
            confidence: 'high',
            reason: 'Name matches an existing linked person',
          })
        } else {
          // Neither is a group → MEDIUM: two ungrouped singletons with the same name
          consider(pRep, qRep, {
            method: 'name',
            confidence: 'medium',
            reason: 'Same name — possible duplicate',
          })
        }
      }
    }
  }

  return Array.from(best.values())
}
