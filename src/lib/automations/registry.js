// AUTOMATIONS hub registry — mirrors src/lib/approvals/registry.js.
// To add an automation later: add a definition here + (if it acts on
// data) a hook the relevant code path calls. The hub page renders a
// card per definition automatically.
//
// Definition contract:
//   key:          stable id, used in URLs + the location_automations row
//   label:        operator-facing card title
//   description:  one line under the title
//   supportsBackfill: boolean — does the card show a "push existing" button (Phase 2)
//   reviewBase:   path operators jump to for failures (existing Glofox review)

export const AUTOMATIONS = Object.freeze([
  {
    key: 'glofox_lead_provisioning',
    label: 'Auto-create leads in Glofox',
    description: 'When a new lead is created, create their Glofox account and attach the studio trial membership.',
    supportsBackfill: true,
    // ADMIN.2h Task 1 — moved out of /admin.
    reviewBase: '/settings/glofox-import',
  },
  {
    key: 'class_climate',
    label: 'Class climate control',
    description: 'Turn the studio AC on before each Glofox class and off after — automatically, on the class schedule.',
    supportsBackfill: false,
    reviewBase: '/automations',
  },
  {
    key: 'bathroom_climate',
    label: 'Bathroom climate control',
    description: 'Turn the bathroom AC on after each class starts and off on a timer — automatically, on the class schedule.',
    supportsBackfill: false,
    reviewBase: '/automations',
  },
])

export function getAutomation(key) {
  return AUTOMATIONS.find((a) => a.key === key) || null
}

/**
 * Pure: is Glofox actually connected at this location? Reads the
 * location row's settings.glofox (no DB). Mirrors the three-header
 * v3 requirement (branch_id + api_key + api_token).
 *
 * @deprecated W1.M3a — the answer now comes from locations.membership_source
 * via membershipStateForPage() (src/lib/membership/state-for-page.js); the
 * by-id reader passes it to automationStatus() as `connected`. This legacy
 * slice test is only the fallback when no `connected` is given, and goes
 * with the next release (registry.test.js pins it until then).
 */
export function glofoxConnected(location) {
  const g = location?.settings?.glofox
  if (!g) return false
  return Boolean(g.branch_id && g.api_key && g.api_token)
}

/**
 * Pure status summary for a card. Branch on key as automations are added.
 *
 * W1.M3a — `connected` (a boolean) is the membership-source answer the
 * by-id reader resolved (configured, with a schedule); when given it is
 * THE connection test. The legacy settings-slice test (glofoxConnected) is
 * only the fallback for a caller that passes no `connected`.
 *
 * @param {string} key
 * @param {object|null} location  `{ settings }` — trial config still lives in the slice
 * @param {{ connected?: boolean }} [opts]
 * @returns {{ available: boolean, trialConfigured: boolean }}
 */
export function automationStatus(key, location, { connected } = {}) {
  const available = typeof connected === 'boolean' ? connected : glofoxConnected(location)
  if (key === 'glofox_lead_provisioning') {
    const g = location?.settings?.glofox || {}
    return {
      available,
      trialConfigured: Boolean(g.trial_membership_id && g.trial_plan_code),
    }
  }
  if (key === 'class_climate' || key === 'bathroom_climate') {
    // Needs the class schedule as its trigger source. AC-device presence
    // is surfaced in the dedicated card (which has the device list); here
    // we only gate on the schedule source being connected.
    return { available, trialConfigured: false }
  }
  return { available: false, trialConfigured: false }
}
