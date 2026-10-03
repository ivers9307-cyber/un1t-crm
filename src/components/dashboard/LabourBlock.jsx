// src/components/dashboard/LabourBlock.jsx
//
// LABOUR.1 — async SERVER component for the Business dashboard. It loads
// the owner's labour view model with the service-role client and renders it
// to HTML here, so no pay-derived data is serialised to the browser. The
// caller (page.js) decides who sees it: canSeeLabour(user), owners only.
//
// react-hooks/error-boundaries: the await happens inside try/catch and the
// JSX is built after it (the DASH-REBUILD pattern in page.js).

import { createServerClient } from '@/lib/supabase'
import { loadLabourMonth } from '@/lib/labour-month-data'
import { LabourPanel } from './LabourPanel'
import { BlockError } from './BusinessBlocks'

export async function LabourBlock({ activeLocationId, studios, nowMs = Date.now() }) {
  let vm = null
  try {
    const res = await loadLabourMonth(createServerClient(), { activeLocationId, studios, nowMs })
    vm = res?.data ?? null
  } catch {
    vm = null
  }
  if (!vm) return <BlockError label="Labour against revenue" />
  return <LabourPanel vm={vm} />
}
