// VOICEREPLY.1 — the studio's voice-reply settings (locations.settings
// .voice_replies) and who may change them. Shared by the voices route and the
// sample route. Managers pick voices (Richard, 4 Nov 2026), unlike Mia's own
// settings, which are owner-only (MIAROLE.1).

import { z } from 'zod'
import { VOICE_KINDS } from '@shared/voice-note'
import { hasRoleAtLocation } from '@/lib/role-at-location'

export const VOICE_SETTINGS_EDIT_ROLES = Object.freeze(['owner', 'manager'])
export const SAMPLE_SENTENCE = "Hi, it's Mia from UN1T. Your class is booked for seven tomorrow morning."

export function canEditVoices(user, locationId) {
  return hasRoleAtLocation(user, locationId, VOICE_SETTINGS_EDIT_ROLES)
}

const VoiceChoice = z.object({ voice_id: z.string().trim().min(1).max(64), name: z.string().trim().min(1).max(120) }).strict().nullable()

export const VoiceSettingsSchema = z.object({
  voices: z.object(Object.fromEntries(VOICE_KINDS.map((k) => [k, VoiceChoice.optional()]))).strict(),
  ai_notice: z.string().max(300).nullable().optional(),
  buttons_line: z.string().max(80).nullable().optional(),
}).strict()

export function studioVoiceSettings(settings) {
  const v = settings?.voice_replies || {}
  return {
    voices: v.voices && typeof v.voices === 'object' ? v.voices : {},
    ai_notice: v.ai_notice || null,
    buttons_line: v.buttons_line || null,
  }
}
