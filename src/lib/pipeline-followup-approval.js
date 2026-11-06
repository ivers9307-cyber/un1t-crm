// PIPEBUILD.4e — a stage follow-up installed from a recipe pack waits in
// `awaiting_approval` until Meta approves its WhatsApp templates. This hook
// runs when a template's status changes (the Meta webhook, applyTemplateEvent,
// and the manual template sync) and moves the waiting follow-ups on:
//
//   APPROVED  → every waiting follow-up (want_live) whose sequence graph uses
//               this template publishes itself, but only once EVERY WhatsApp
//               template in that graph is APPROVED at the studio.
//   REJECTED / DISABLED → waiting follow-ups using it are marked `rejected`.
//               A `live` follow-up already passed approval and keeps running;
//               the runtime deferral/pausing handles a template Meta disables
//               later.
//
// Only follow-ups at the template's OWN studio are touched (service role: every
// query is scoped by location here). A follow-up is found by the template id
// appearing in its sequence's `draft_graph ?? graph` WhatsApp nodes, since a
// pack can use more than one template (trial_done: main + followup) and the
// row's `whatsapp_template_id` holds only the first. The row's link is used
// ONLY when the follow-up has no readable sequence: once the graph exists it
// is the truth, so a template an operator has since swapped out of the graph
// can no longer approve or reject the follow-up.
//
// The claim mirrors installFollowupPack: CAS `awaiting_approval → live`, then
// publish, and on failure CAS `live → awaiting_approval` back. The state check
// allows only draft|awaiting_approval|live|rejected|off, so there is no
// intermediate "publishing" state; a 0-row claim means someone else (the
// installer, or a second delivery of the same approval) is publishing it. If
// the publish fails AND the revert write fails, the row reads `live` over a
// draft sequence; that is logged under its own message, and a reinstall of
// the pack repairs it (installFollowupPack's recheckInstalled).
//
// Never throws: a failure is logged and the counts so far are returned, so it
// can never block onTemplateApproved or the webhook's 200.
import { publishSequence } from '@/lib/sequences/publish'
import { logError } from '@/lib/log'

const MODULE = 'pipeline-followup-approval'
const PAGE = 1000
const IN_CHUNK = 200
const REJECT_STATUSES = new Set(['REJECTED', 'DISABLED'])

async function pagedRows(build) {
  const rows = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build().range(from, from + PAGE - 1)
    if (error) throw new Error(error.message)
    rows.push(...(data || []))
    if (!data || data.length < PAGE) return rows
  }
}

function chunks(list) {
  const out = []
  for (let i = 0; i < list.length; i += IN_CHUNK) out.push(list.slice(i, i + IN_CHUNK))
  return out
}

// Every WhatsApp template id a sequence graph sends, as strings.
export function graphTemplateIds(graph) {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : []
  const ids = new Set()
  for (const n of nodes) {
    if (n?.type !== 'whatsapp') continue
    const id = n.config?.template_id ?? n.config?.whatsapp_template_id
    if (id) ids.add(String(id))
  }
  return [...ids]
}

// Waiting follow-ups at the studio whose sequence uses this template, each
// with the full set of template ids its graph sends.
async function waitingFollowups(db, template, { wantLiveOnly }) {
  const followups = await pagedRows(() => {
    let q = db.from('pipeline_stage_followups')
      .select('id, sequence_id, whatsapp_template_id, state, want_live')
      .eq('location_id', template.location_id)
      .eq('state', 'awaiting_approval')
    if (wantLiveOnly) q = q.eq('want_live', true)
    return q.order('id', { ascending: true })
  })
  if (followups.length === 0) return []

  const seqIds = [...new Set(followups.map((f) => f.sequence_id).filter(Boolean))]
  const graphs = new Map()
  for (const ids of chunks(seqIds)) {
    const { data, error } = await db.from('email_sequences')
      .select('id, graph, draft_graph')
      .eq('location_id', template.location_id)
      .in('id', ids)
    if (error) throw new Error(error.message)
    for (const s of data || []) graphs.set(s.id, graphTemplateIds(s.draft_graph ?? s.graph))
  }

  const target = String(template.id)
  const out = []
  for (const f of followups) {
    const hasSequence = Boolean(f.sequence_id) && graphs.has(f.sequence_id)
    const templateIds = hasSequence ? graphs.get(f.sequence_id) : []
    const uses = hasSequence ? templateIds.includes(target) : String(f.whatsapp_template_id ?? '') === target
    if (uses) out.push({ ...f, templateIds, hasSequence })
  }
  return out
}

async function publishWaiting(db, template, result) {
  const candidates = (await waitingFollowups(db, template, { wantLiveOnly: true }))
    .filter((f) => f.hasSequence && f.templateIds.length > 0)
  if (candidates.length === 0) return

  // One read of every template these graphs send, at this studio only: a
  // template id from another studio never counts as approved here.
  const allIds = [...new Set(candidates.flatMap((f) => f.templateIds))]
  const approved = new Set()
  for (const ids of chunks(allIds)) {
    const { data, error } = await db.from('whatsapp_templates')
      .select('id, status')
      .eq('location_id', template.location_id)
      .in('id', ids)
    if (error) throw new Error(error.message)
    for (const t of data || []) if (t.status === 'APPROVED') approved.add(String(t.id))
  }

  for (const f of candidates) {
    if (!f.templateIds.every((id) => approved.has(id))) continue

    // The claim's own timestamp: the revert below matches on it, so a failed
    // publish can only undo THIS claim, never a newer one.
    const claimAt = new Date().toISOString()
    const { data: claimed, error: claimErr } = await db.from('pipeline_stage_followups')
      .update({ state: 'live', updated_at: claimAt })
      .eq('id', f.id)
      .eq('location_id', template.location_id)
      .eq('state', 'awaiting_approval')
      .select('id')
    if (claimErr) {
      logError(MODULE, 'live claim failed', { followupId: f.id, templateId: template.id, err: claimErr.message })
      continue
    }
    // 0 rows: the installer or another delivery claimed it and is publishing.
    if (!claimed?.length) continue

    let published
    try {
      published = await publishSequence(db, { sequenceId: f.sequence_id })
    } catch (err) {
      published = { ok: false, error: err?.message || String(err) }
    }
    if (published?.ok) {
      result.published += 1
      continue
    }

    const { data: reverted, error: revertErr } = await db.from('pipeline_stage_followups')
      .update({ state: 'awaiting_approval', updated_at: new Date().toISOString() })
      .eq('id', f.id)
      .eq('location_id', template.location_id)
      .eq('state', 'live')
      .eq('updated_at', claimAt)
      .select('id')
    if (!revertErr && !reverted?.length) {
      // Re-claimed after ours (a reinstall's repair); that claim stands.
      logError(MODULE, 'publish failed; the follow-up was re-claimed meanwhile, left as it is', {
        followupId: f.id, sequenceId: f.sequence_id, templateId: template.id, err: published?.error,
      })
      continue
    }
    if (revertErr) {
      // Stuck: the row says live, the sequence is still a draft, nothing
      // sends. A reinstall of the pack puts it back and re-checks.
      logError(MODULE, 'publish failed and the follow-up could not be put back; it reads live over a draft sequence', {
        followupId: f.id,
        sequenceId: f.sequence_id,
        templateId: template.id,
        err: published?.error,
        revertErr: revertErr.message,
      })
      continue
    }
    logError(MODULE, 'publish failed; follow-up left awaiting approval', {
      followupId: f.id,
      sequenceId: f.sequence_id,
      templateId: template.id,
      err: published?.error,
    })
  }
}

async function rejectWaiting(db, template, result) {
  const matched = await waitingFollowups(db, template, { wantLiveOnly: false })
  if (matched.length === 0) return
  for (const ids of chunks(matched.map((f) => f.id))) {
    const { data, error } = await db.from('pipeline_stage_followups')
      .update({ state: 'rejected', updated_at: new Date().toISOString() })
      .eq('location_id', template.location_id)
      .eq('state', 'awaiting_approval')
      .in('id', ids)
      .select('id')
    if (error) throw new Error(error.message)
    result.rejected += (data || []).length
  }
}

/**
 * @param {object} db service-role client
 * @param {{ id: string, location_id: string }} template the template whose status changed
 * @param {string} status its new stored status
 * @returns {Promise<{ published: number, rejected: number }>} never throws
 */
export async function onTemplateStatusForFollowups(db, template, status) {
  const result = { published: 0, rejected: 0 }
  try {
    if (!template?.id || !template?.location_id) return result
    if (status === 'APPROVED') await publishWaiting(db, template, result)
    else if (REJECT_STATUSES.has(status)) await rejectWaiting(db, template, result)
  } catch (err) {
    logError(MODULE, 'follow-up status hook failed', {
      templateId: template?.id, locationId: template?.location_id, status, err: err?.message,
    })
  }
  return result
}
