// A studio's inbox follow-up config: how long a thread we replied to may stay
// quiet before it returns to "Needs reply", and whether Mia nudges first.
// Lives in the studio's customer-agent settings at
// followups.staff_threads.{quiet_after_hours, nudge_enabled}. The rules that
// read it are in shared/inbox-queues.js.
import { DEFAULT_FOLLOWUP_CFG } from '@shared/inbox-queues'
import { resolveAgentSettings } from '@/lib/agent/settings-resolve'
import { logError } from '@/lib/log'

const MIN_HOURS = 4
const MAX_HOURS = 336

export function followupConfigFromSettings(customerAgentSettings) {
  const st = customerAgentSettings?.followups?.staff_threads
  const raw = st && typeof st === 'object' ? st.quiet_after_hours : undefined
  const hours = typeof raw === 'number' && Number.isFinite(raw)
    ? Math.min(MAX_HOURS, Math.max(MIN_HOURS, raw))
    : DEFAULT_FOLLOWUP_CFG.quietHours
  return {
    quietHours: hours,
    nudgeEnabled: !!st && typeof st === 'object' && st.nudge_enabled === true,
  }
}

export async function readInboxFollowupConfig(db, locationId) {
  try {
    const resolved = await resolveAgentSettings(db, locationId)
    if (!resolved.ok) {
      logError('inbox-followup-config', 'settings read failed, using defaults', { locationId, reason: resolved.reason })
      return { ...DEFAULT_FOLLOWUP_CFG }
    }
    return followupConfigFromSettings(resolved.settings)
  } catch (err) {
    logError('inbox-followup-config', 'settings read threw, using defaults', { locationId, err })
    return { ...DEFAULT_FOLLOWUP_CFG }
  }
}
