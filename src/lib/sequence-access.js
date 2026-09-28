// SEQROUTEGATE.1 — who may build sequences, judged at a named location.
//
// The rule is the /automations builder page's own gate, copied exactly:
// `email` OR `whatsapp` (src/app/(marketing)/automations/[id]/page.js and the
// /automations flow list's `canFlows`). A sequence can be all WhatsApp steps,
// and reception holds `whatsapp` but not `email` by default, so an email-only
// API rule would let the page open and then refuse every save.
//
// Every /api/sequences builder route asks it AT the sequence's location, after
// its membership check (the ROLESWEEP pattern), with canBuildSequencesSomewhere
// as the coarse pre-check before the row is read. The enrolment routes (enrol,
// clone, exit, resume, audience/seed) keep their own `email` rule.

import { NextResponse } from 'next/server'
import { hasPermissionForLocation, hasPermissionAtAnyLocation } from '@/lib/permissions'

export const SEQUENCE_BUILDER_PERMISSIONS = Object.freeze(['email', 'whatsapp'])
export const SEQUENCE_PERMISSION_ERROR = 'Email or WhatsApp permission required'

/** The rule at `locationId` (the role, overrides, template and features there). */
export function canBuildSequencesAt(user, locationId) {
  if (!user || !locationId) return false
  return SEQUENCE_BUILDER_PERMISSIONS.some((key) => hasPermissionForLocation(user, locationId, key))
}

/** The coarse pre-check: the rule holds at some studio the caller belongs to. */
export function canBuildSequencesSomewhere(user) {
  if (!user) return false
  return SEQUENCE_BUILDER_PERMISSIONS.some((key) => hasPermissionAtAnyLocation(user, key))
}

export function sequencePermissionRequired() {
  return NextResponse.json({ success: false, error: SEQUENCE_PERMISSION_ERROR }, { status: 403 })
}
