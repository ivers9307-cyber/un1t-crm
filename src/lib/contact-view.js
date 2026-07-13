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
export function deriveNeedsAttention({ contact, arrearsCents = 0, openTasks = [], todayStr = null }) {
  const items = []
  if (
    FUNNEL_SLUGS.has(contact?.pipeline_stage_slug) &&
    !contact?.next_class_at &&
    (contact?.trial_credits_remaining ?? 0) > 0
  ) {
    items.push({
      key: 'no_next_class',
      label: 'No next class booked',
      detail: `${contact.trial_credits_remaining} trial credit${contact.trial_credits_remaining === 1 ? '' : 's'} unused`,
      tone: 'danger',
    })
  }
  if (arrearsCents > 0) {
    items.push({ key: 'arrears', label: 'Payment overdue', detail: 'On the Overdue chase-list', tone: 'danger' })
  }
  if (todayStr) {
    const overdue = (openTasks || []).filter((t) => t.due_date && t.due_date <= todayStr)
    if (overdue.length > 0) {
      items.push({
        key: 'task_overdue',
        label: `${overdue.length} task${overdue.length === 1 ? '' : 's'} overdue`,
        detail: overdue[0].subject || '',
        tone: 'warn',
      })
    }
  }
  return items
}
