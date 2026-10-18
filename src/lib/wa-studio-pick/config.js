// WASTUDIOPICK.1 — settings for the WhatsApp studio picker
// (locations.settings.wa_studio_picker; spec R8). Every studio may be
// `listed` (with a `label` and classifier `keywords`); the studio that owns the
// number carries `enabled` and the `question`. Defaults keep it all OFF.
import { logWarn } from '../log'
import { locationsWithWhatsApp } from '../whatsapp-config'

export const DEFAULT_PICKER_QUESTION = 'Thanks for getting in touch. Which studio is this about?'
export const PICKER_ID_PREFIX = 'studio:'
export const LABEL_MAX = 20
export const QUESTION_MAX = 1024
export const KEYWORDS_MAX = 10
export const KEYWORD_LEN_MAX = 40

const pickerOf = (loc) => (loc?.settings && typeof loc.settings === 'object' ? loc.settings.wa_studio_picker : null) || {}

export function pickerLabel(loc) {
  const label = String(pickerOf(loc).label || '').trim()
  return (label || String(loc?.name || '').trim()).slice(0, LABEL_MAX)
}

export async function readPickerConfig(db, receivingLocationId) {
  try {
    const { data: home, error: homeErr } = await db.from('locations')
      .select('id, name, organization_id, settings').eq('id', receivingLocationId).maybeSingle()
    if (homeErr) throw homeErr
    if (!home?.organization_id) return null
    const { data: rows, error } = await db.from('locations')
      .select('id, name, organization_id, settings').eq('organization_id', home.organization_id).order('name')
    if (error) throw error
    const own = pickerOf(home)
    const listed = (rows || []).filter((l) => pickerOf(l).listed === true)
    // A sibling with its own WhatsApp number is only offered on that number: a
    // thread moved to it here would be answered from this number, not its own.
    const siblingIds = listed.map((l) => l.id).filter((id) => id !== receivingLocationId)
    // WAORGNUMBER.1 — "its own number" is an active number switched on there
    // (locationsWithWhatsApp throws on a failed read: caught below, picker skipped).
    const numbered = await locationsWithWhatsApp(db, siblingIds)
    const studios = listed
      .filter((l) => !numbered.has(l.id))
      .map((l) => ({
        id: l.id,
        name: l.name,
        label: pickerLabel(l),
        keywords: (Array.isArray(pickerOf(l).keywords) ? pickerOf(l).keywords : [])
          .map((k) => String(k).trim()).filter(Boolean).slice(0, KEYWORDS_MAX),
      }))
    const question = String(own.question || '').trim() || DEFAULT_PICKER_QUESTION
    return { enabled: own.enabled === true, question, studios }
  } catch (e) {
    logWarn('wa-studio-pick', 'picker settings unreadable; picker skipped', { receivingLocationId, err: e?.message || String(e) })
    return null
  }
}
