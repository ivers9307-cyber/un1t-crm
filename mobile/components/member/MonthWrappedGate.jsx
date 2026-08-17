// PHASE2 stage C — champ's MonthWrappedGate, ported from
// champ-app/mobile/app/_layout.jsx into the (member) tree. Auto-presents
// the "Monthly Wrapped" month-end story once per month, at the start of a
// new Dublin month, when last month has content and hasn't been seen.
// Mirrors ProfileSetupGate: an auth-context-consuming, render-null
// side-effect component, mounted by app/(member)/_layout.jsx. Runs at
// most once per app launch (presentedRef) and DEFERS to the
// profile-setup wizard — both are gesture-locked fullScreen modals, so
// they must never stack.

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'expo-router'
import { useAuth } from '../../lib/member/contact-context'
import { getDismissedAtMs } from '../../lib/member/profile-setup-dismissal'
import { hasSeenMonthRecap } from '../../lib/member/recap-seen'
import { supabase } from '../../lib/member/supabase'
import { profileSetupStatus } from 'shared/profile-setup'
import { monthlyRecap, personalRecords } from 'shared/progress-analytics'
import { monthWrappedModel, monthWrappedKey } from 'shared/month-wrapped'

export default function MonthWrappedGate() {
  const { contact, loading } = useAuth()
  const router = useRouter()
  const [dismissedAtMs, setDismissedAtMs] = useState(undefined) // undefined = not loaded yet
  const presentedRef = useRef(false)

  useEffect(() => { getDismissedAtMs().then((v) => setDismissedAtMs(v)) }, [])

  useEffect(() => {
    if (loading || dismissedAtMs === undefined || !contact?.id || presentedRef.current) return
    // Defer to profile setup: if the wizard will present this launch, skip the
    // wrapped auto-present (don't set presentedRef, so it can still fire once
    // the profile is completed/dismissed and the status flips).
    if (profileSetupStatus(contact, { dismissedAtMs }) === 'wizard') return
    let cancelled = false

    ;(async () => {
      try {
        // The completed-month key derives from the clock ALONE, so consult the
        // "seen" flag FIRST — the common path (recap already seen this month)
        // must cost ZERO session reads on launch (champ re-audit A5).
        const nowMs = Date.now()
        if (await hasSeenMonthRecap(monthWrappedKey(nowMs))) {
          // Seen stays seen for the rest of the month — done for this launch.
          presentedRef.current = true
          return
        }
        if (cancelled) return

        // Never ambush a member MID-CLASS with a gesture-locked takeover
        // (champ re-audit A7): if they have an OPEN live session, skip
        // WITHOUT burning presentedRef, so a later re-run of the gate this
        // launch — or the next launch — can still present once the class is
        // over. Best-effort: an errored check also skips (we can't be sure
        // they're not training).
        const { data: openSession, error: liveErr } = await supabase
          .from('heart_rate_sessions')
          .select('id')
          .is('ended_at', null)
          .order('started_at', { ascending: false })
          .limit(1)
          .maybeSingle()
        if (cancelled) return
        if (liveErr || openSession) return

        // Committing to this launch's one presentation attempt.
        presentedRef.current = true

        // Lightweight: last ~400 days of sessions, RLS-scoped to the member.
        const sinceIso = new Date(nowMs - 400 * 24 * 3600 * 1000).toISOString()
        const all = []
        const PAGE = 1000
        for (let from = 0; ; from += PAGE) {
          const { data, error } = await supabase
            .from('heart_rate_sessions')
            .select('id, started_at, ended_at, effort_points, avg_hr_bpm, peak_hr_bpm')
            .gte('started_at', sinceIso)
            .order('started_at', { ascending: false })
            .range(from, from + PAGE - 1)
          if (error) throw error
          const rows = data || []
          all.push(...rows)
          if (rows.length < PAGE) break
        }
        if (cancelled) return
        // Same nowMs as the seen pre-check, so the model's monthKey is
        // guaranteed to be the key we just confirmed unseen.
        const model = monthWrappedModel(monthlyRecap(all, nowMs, 6), personalRecords(all), nowMs)
        if (!model?.hasContent) return // nothing to celebrate — never present empty
        if (cancelled) return
        router.push('/wrapped/month')
      } catch {
        // Best-effort: a failed pre-check just means no auto-present this launch.
      }
    })()

    return () => { cancelled = true }
  }, [loading, contact, dismissedAtMs, router])

  return null
}
