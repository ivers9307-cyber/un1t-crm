// glofox-trial-options — build the option list for the Glofox trial-
// membership picker (GlofoxIntegrationTab).
//
// The list comes from the live Glofox membership catalogue, but the
// currently-saved value MUST always be selectable even when the
// catalogue hasn't loaded (or no longer contains it). Otherwise the
// <select> falls back to "— None —" while a real value is stored, and
// a Save would silently overwrite the operator's setting with null.

/**
 * @param {Array<{membership_id:string, plan_code:string, label?:string}>} memberships
 *   the live Glofox catalogue (may be empty while loading / on error)
 * @param {string} trialKey  the currently-saved `${membership_id}:${plan_code}` (or '')
 * @returns {Array<{value:string, label:string}>}
 */
export function buildTrialOptions(memberships, trialKey) {
  const opts = (Array.isArray(memberships) ? memberships : []).map((m) => ({
    value: `${m.membership_id}:${m.plan_code}`,
    label: m.label || `${m.membership_id} / ${m.plan_code}`,
  }))

  // Guarantee the saved value is present so it never displays as "None"
  // and can never be wiped by a Save that didn't touch the picker.
  if (trialKey && !opts.some((o) => o.value === trialKey)) {
    opts.unshift({
      value: trialKey,
      label: `Current selection (${String(trialKey).split(':')[0]})`,
    })
  }

  return opts
}
