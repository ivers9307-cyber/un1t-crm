// Contact view helpers shared by /contacts/[id] and the pipeline
// contact drawer. Pure functions — no DB access; callers pass todayStr
// (from dublinTodayStr()) when they want overdue-task detection, so
// this module never computes "today" itself.

const FUNNEL_SLUGS = new Set(['new_lead', 'first_class', 'second_class', 'trial_done'])
const MESSAGE_TYPES = new Set(['whatsapp_sent', 'whatsapp_received', 'sms_sent', 'email'])

// Unified timeline: notes + activities, newest first. Extracted from
// the contact page (the shape feeds its activityIcons map). The spread
// order is deliberate and behaviour-preserving: the raw row spreads
// LAST, so an activity's own `type` column wins the `type` key —
// `activityType` is the reliable discriminator, not `type`.
export function mergeTimeline(notes, activities) {
  return [
    ...(notes || []).map((n) => ({ type: 'note', activityType: 'note', date: n.created_at, ...n })),
    ...(activities || []).map((a) => ({ type: 'activity', activityType: a.type || 'task', date: a.created_at, ...a })),
  ].sort((a, b) => new Date(b.date) - new Date(a.date))
}

// Filter-pill grouping for the timeline: classes / messages / notes /
// system. Anything unrecognised lands in "system" so new activity
// types never vanish behind the filters.
export function timelineFilterGroup(item) {
  const t = item.activityType
  if (t === 'booking') return 'classes'
  if (MESSAGE_TYPES.has(t)) return 'messages'
  if (t === 'note') return 'notes'
  return 'system'
}

// Needs-attention derivation for the drawer + the contact page's right
// rail. Returns [{ key, label, detail, tone }]; tone maps to the
// light-theme chip ramp (danger → red, warn → amber).
//
// `arrearsCents` is the total the viewer sees (Glofox plus un1t.online's EUR);
// `glofoxArrearsCents` is the Glofox part alone (default: all of it), which
// decides whether the person is on Glofox's Overdue chase-list. `overdue` is
// un1t.online's flag.
export function deriveNeedsAttention({ contact, arrearsCents = 0, glofoxArrearsCents = arrearsCents, openTasks = [], todayStr = null, overdue = false }) {
  const items = []
  // A NULL count is "no count" (C145): still flag the missing class, with no
  // number. A known 0 means the trial is spent, so no flag.
  const credits = contact?.trial_credits_remaining
  const hasCount = Number.isFinite(credits)
  if (
    FUNNEL_SLUGS.has(contact?.pipeline_stage_slug) &&
    !contact?.next_class_at &&
    (!hasCount || credits > 0)
  ) {
    items.push({
      key: 'no_next_class',
      label: 'No next class booked',
      detail: hasCount ? `${credits} trial credit${credits === 1 ? '' : 's'} unused` : '',
      tone: 'danger',
    })
  }
  // HATCHPIPE.2 — `overdue` is un1t.online's flag, which can be true while the
  // amount is unreported (null → no cents), so it raises the item by itself.
  if (arrearsCents > 0 || overdue) {
    const detail = [
      glofoxArrearsCents > 0 ? 'On the Overdue chase-list' : null,
      overdue ? 'Past due on un1t.online' : null,
    ].filter(Boolean).join(' · ')
    items.push({ key: 'arrears', label: 'Payment overdue', detail, tone: 'danger' })
  }
  if (todayStr) {
    const overdueTasks = (openTasks || []).filter((t) => t.due_date && t.due_date <= todayStr)
    if (overdueTasks.length > 0) {
      items.push({
        key: 'task_overdue',
        label: `${overdueTasks.length} task${overdueTasks.length === 1 ? '' : 's'} overdue`,
        detail: overdueTasks[0].subject || '',
        tone: 'warn',
      })
    }
  }
  return items
}

// CARDLENS.2 — { location_id: shortName } for the studio tags on the contact
// page, from loadContactStudios rows. Empty when the person has fewer than two
// studios, so a single-studio contact (the norm) shows no tag at all. A word
// every name starts with ("UN1T") is dropped, unless that would leave a name
// empty.
export function studioNameMap(rows) {
  const byId = new Map()
  for (const r of rows || []) {
    const name = String(r?.location?.name || '').trim()
    if (r?.location_id && name && !byId.has(r.location_id)) byId.set(r.location_id, name)
  }
  if (byId.size < 2) return {}
  const words = [...byId.values()].map((n) => n.split(/\s+/))
  const first = words[0][0]
  const strip = words.every((w) => w.length > 1 && w[0] === first)
  const out = {}
  for (const [id, name] of byId) out[id] = strip ? name.split(/\s+/).slice(1).join(' ') : name
  return out
}
