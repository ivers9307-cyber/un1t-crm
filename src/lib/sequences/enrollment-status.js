// PRESEND.1 — a leaf module holding the one write every layer needs.
//
// setEnrollmentStatus lived in scheduler.js, which is the top of the sequence
// module graph: scheduler -> steps -> dunning-payment. The dunning pre-send
// gate has to end a run, so importing it from scheduler closed the loop back
// to the top. ESM tolerates that (the export is a hoisted function declaration
// called only at runtime), but a cycle through a module that big is a latch
// waiting to catch someone — and it forces any test of the gate to drag the
// whole runner in behind it.
//
// So the write sits here, with no imports of its own beyond the client, and
// scheduler.js re-exports it for its existing callers (the pause / resume /
// exit routes and dunning.js) which keep importing it from where they always
// did.
import { createServerClient } from '@/lib/supabase'

/**
 * Update the status of a single enrolment. Used by /api/sequences/...
 * pause / resume / exit endpoints, by dunning.js's webhook exit, and by the
 * dunning pre-send gate.
 */
export async function setEnrollmentStatus({ enrollmentId, status, reason }) {
  const db = createServerClient()
  const updates = { status }
  if (reason) updates.last_error = reason
  const { error } = await db.from('sequence_enrollments').update(updates).eq('id', enrollmentId)
  if (error) throw error
}
