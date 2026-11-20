import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { logError } from '@/lib/log'
import { MANAGER_ROLES } from '@/lib/schemas'
import { importClassKnowledge } from '@/lib/agent/knowledge-import'
import { GLOFOX_SETTINGS_UNREADABLE, GLOFOX_SETTINGS_UNREADABLE_MESSAGE } from '@/lib/glofox-settings-read'

// KNOWLEDGE-IMPORT.1 — POST: pull the Glofox timetable's class types +
// descriptions into knowledge for the active location. Existing titles
// are never overwritten; re-running only adds what's new. The weekly
// sync-class-knowledge cron runs the same core every Monday so the
// knowledge base keeps itself fresh.

const KNOWN_REASONS = ['glofox_not_connected', 'glofox_unreachable', GLOFOX_SETTINGS_UNREADABLE]

// Gate as before: MANAGER_ROLES on the role at the active studio ('Forbidden'
// 403), then an active studio (400).
export const POST = withAuth({ permission: null, roles: MANAGER_ROLES, forbiddenMessage: 'Forbidden', location: true }, async ({ user, db, locationId }) => {
  const result = await importClassKnowledge(db, locationId, { updatedBy: user.id })
  if (!result.ok) {
    // A database write failure carries the database's own text as its reason:
    // logged, never answered.
    if (!KNOWN_REASONS.includes(result.reason)) logError('knowledge-import', 'import failed', { locationId, reason: result.reason })
    const msg = result.reason === 'glofox_not_connected'
      ? 'Glofox is not connected for this location.'
      : result.reason === 'glofox_unreachable'
        ? 'Could not load the Glofox timetable just now.'
        : result.reason === GLOFOX_SETTINGS_UNREADABLE
          ? GLOFOX_SETTINGS_UNREADABLE_MESSAGE
          : 'Could not import the classes just now.'
    // REGISTRYREAD.1b: a failed settings read is a 503 (try again), not a
    // 400 "not connected".
    const status = result.reason === 'glofox_not_connected' ? 400
      : result.reason === GLOFOX_SETTINGS_UNREADABLE ? 503
        : 502
    return NextResponse.json({ success: false, error: msg }, { status })
  }

  return NextResponse.json({
    success: true,
    imported: result.imported,
    skipped: result.skipped,
    missing_description: result.missing_description,
  })
})
