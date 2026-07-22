// glofox-trial-options — build the option list for a Glofox trial-
// membership picker (Settings → Glofox Integration, and the class_funnel
// landing-page block).
//
// Input is the live Glofox membership catalogue exactly as
// listGlofoxMemberships() / GET /api/locations/[id]/glofox-memberships
// return it: an array of memberships, each with a nested plans[] array:
//   { _id, name, trial, plans: [{ code, type, price, name }] }
// We flatten it to one selectable option per membership×plan, keyed by the
// `${membershipId}:${planCode}` value the pickers persist.
//
// The currently-saved value MUST always stay selectable even when the
// catalogue hasn't loaded (or no longer contains it). Otherwise the
// <select> falls back to "— None —" while a real value is stored, and a
// Save would silently overwrite the operator's setting with null.

/**
 * @param {Array<{_id:string, name?:string, plans?:Array<{code:string, name?:string}>}>} memberships
 *   the live Glofox catalogue (may be empty while loading / on error)
 * @param {string} trialKey  the currently-saved `${membershipId}:${planCode}` (or '')
 * @returns {Array<{value:string, label:string}>}
 */
export function buildTrialOptions(memberships, trialKey) {
  const opts = []
  for (const m of Array.isArray(memberships) ? memberships : []) {
    const membershipId = m?._id
    if (!membershipId) continue
    const mName = m?.name || membershipId
    for (const p of Array.isArray(m?.plans) ? m.plans : []) {
      const planCode = p?.code
      if (!planCode) continue
      const pName = p?.name
      opts.push({
        value: `${membershipId}:${planCode}`,
        label: pName && pName !== mName ? `${mName} — ${pName}` : mName,
      })
    }
  }

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
