//
// Pure next-steps playbook for agent approval decisions. Shared by the
// web inbox (Wave 1) and the mobile inbox (Wave 2) so the recommended
// follow-ups can't drift between platforms. Pure — no DB, no network,
// no platform imports.
//
// getNextSteps(kind, outcome, ctx) → [{ id, label, type, draft? }]
//   type 'composer' — prefill the thread composer with `draft`; staff
//                     edit and send it themselves (nothing auto-sends)
//   type 'book'     — open the Command Centre Book tab (desktop rail)
//   type 'sequence' — open the sequence picker for the contact
//
// Auto-executed approvals ('actioned') get no steps: the agent already
// sent the confirmation into the thread.

export const DECLINE_REASONS = Object.freeze([
  ['class_full', 'Class full'],
  ['already_booked', 'Already booked'],
  ['not_eligible', 'Not eligible'],
  ['other', 'Other'],
])

export const BOOKING_KINDS = new Set(['class_booking', 'event_booking', 'consultation'])

function firstName(ctx) {
  return (ctx && ctx.firstName) || 'there'
}

function whatLabel(ctx) {
  const d = (ctx && ctx.details) || {}
  const name = d.class_name || d.event_name || null
  const time = d.class_time || d.event_date || null
  return [name, time].filter(Boolean).join(' at ')
}

export function buildDeclineDraft(kind, reasonKey, ctx = {}) {
  const name = firstName(ctx)
  const what = whatLabel(ctx)
  if (BOOKING_KINDS.has(kind)) {
    const base = `Hi ${name}, unfortunately we couldn't book you into ${what || 'that session'}`
    switch (reasonKey) {
      case 'class_full':
        return `${base} — it's fully booked. Would another time suit? I can send you a few options.`
      case 'already_booked':
        return `${base} — it looks like you're already booked in for it. See you there!`
      case 'not_eligible':
        return `${base} — your current membership doesn't cover it. Reply here and we can look at options.`
      default:
        return `${base}. Reply here and we'll sort something out.`
    }
  }
  if (kind === 'class_cancellation' || kind === 'event_cancellation') {
    return `Hi ${name}, we weren't able to cancel ${what || 'your booking'} this time. Reply here and we'll help.`
  }
  if (kind === 'pause') {
    return `Hi ${name}, we couldn't set up that membership pause just yet. Reply here and we'll look at what's possible.`
  }
  if (kind === 'cancellation') {
    return `Hi ${name}, thanks for reaching out. We'd love a quick chat before anything changes with your membership. When suits a call?`
  }
  return `Hi ${name}, we couldn't action that request this time — reply here and we'll sort it out.`
}

export function getNextSteps(kind, outcome, ctx = {}) {
  const name = firstName(ctx)
  const what = whatLabel(ctx)

  if (outcome === 'declined') {
    const steps = []
    if (BOOKING_KINDS.has(kind)) {
      steps.push({ id: 'offer_slots', label: 'Offer alternative slots', type: 'book' })
    }
    steps.push({
      id: 'decline_message',
      label: 'Send explanation',
      type: 'composer',
      draft: buildDeclineDraft(kind, (ctx && ctx.reason) || 'other', ctx),
    })
    return steps
  }

  if (outcome === 'failed') {
    const steps = []
    if (BOOKING_KINDS.has(kind)) {
      steps.push({ id: 'book_manually', label: 'Book manually', type: 'book' })
    }
    steps.push({
      id: 'holding_message',
      label: "Let them know we're on it",
      type: 'composer',
      draft: `Hi ${name}, just picking this up now — I'll confirm ${what || 'your request'} shortly.`,
    })
    return steps
  }

  // CANCEL-FORM.6 — a membership cancellation now confirms the member
  // automatically on approve (and on actioned, when the location's Glofox
  // auto-cancel is on), so the farewell is a personal goodbye, not a second
  // promise to confirm. Same follow-ups either way.
  if ((outcome === 'approved' || outcome === 'actioned') && kind === 'cancellation') {
    return [
      { id: 'winback', label: 'Enrol in win-back sequence', type: 'sequence' },
      { id: 'farewell_consult', label: 'Book a farewell consult', type: 'book' },
      {
        id: 'farewell_message',
        label: 'Send farewell message',
        type: 'composer',
        draft: `Hi ${name}, sorry to see you go. Thanks for training with us, and you would be welcome back any time.`,
      },
    ]
  }

  if (outcome === 'approved') {
    if (kind === 'pause') {
      const d = (ctx && ctx.details) || {}
      const span = [d.start_date, d.end_date].filter(Boolean).join(' to ')
      return [{
        id: 'pause_confirm',
        label: 'Confirm pause dates',
        type: 'composer',
        draft: `Hi ${name}, your membership pause${span ? ` from ${span}` : ''} is approved. We're setting it up now.`,
      }]
    }
    return []
  }

  if (outcome === 'saved') {
    return [{
      id: 'saved_thanks',
      label: 'Send a thank-you',
      type: 'composer',
      draft: `Hi ${name}, great chatting, really glad you're staying with us. Any questions about what we discussed, just reply here.`,
    }]
  }

  return []
}
