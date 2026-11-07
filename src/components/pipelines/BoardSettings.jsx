'use client'

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { Button, Card, Loading, Modal } from '@/components/ui'
import { RECIPES } from '@shared/pipelines/recipes.js'
import {
  initialWizardState, wizardReducer, stateFromBoard, settingsConfig, stepErrors,
  packForBoardStage, packBodies, previewTemplate,
} from '@/lib/pipeline-wizard'
import { ENTRY_TYPES_BY_MODULE } from '@shared/pipelines/offer-config.js'
import NameOfferStep from './wizard/NameOfferStep'
import EntryStep from './wizard/EntryStep'
import StagesStep from './wizard/StagesStep'
import FollowupsStep from './wizard/FollowupsStep'
import MiaNotesStep from './wizard/MiaNotesStep'
import BoardLaunchPanel from './BoardLaunchPanel'
import BoardReport from './BoardReport'
import { boardStatus, followupChip, placementCadence, HEALTH_UNREAD_NOTICE } from './BoardList'

export const SWITCH_OFF_NOTE = 'Switch the board off to change this.'
export const REPLACE_CONFIRM = 'The current message stops now. The new wording starts once Meta approves it, usually within a few hours.'
// The server's words (src/lib/pipeline-boards.js LEGACY_BOARD_ERROR), copied
// because a client bundle must not import that server module.
export const LEGACY_NOTICE = "This board is built in code and can't be changed here."
export const WORDING_UNKNOWN_NOTE = "The current wording couldn't be read. Try again later before changing it."
export const OLD_WORDING_UNKNOWN_NOTE = "The old wording couldn't be read, so this starts from the standard wording."
export const REJECTED_NOTE = 'Meta rejected this wording. Change it to try again.'
export const TURN_OFF_CONFIRM = 'While the board is off, nobody new is placed and people already on it stay where they are, with no messages. When you turn it back on, people who qualified in the meantime are placed without messages. Follow-ups already on their way stop the next time they check the board, and turning it back on does not restart them.'
// PIPEBUILD.5o — a follow-up's template text is filled in when it is sent to
// Meta, so a later change to the offer name, sign-off or offer length does not
// reach it on its own.
export const FILLED_IN_NOTE = 'These messages were filled in when they were sent to Meta. If you change the offer name, sign-off or offer length, change the wording of each message too.'
// RAILS.1 — installing afresh is owner work; the server refuses it too.
export const OWNER_ONLY_INSTALL_NOTE = 'Only an owner can install this follow-up. Ask an owner, or change the wording once it is set up.'
export const OWNER_ONLY_REJECTED_NOTE = 'Meta rejected this wording. Ask an owner to install it again.'
// RAILS.2 — switching off retires the sequence and a later install goes back to Meta.
export const FOLLOWUP_OFF_CONFIRM = 'This stops the follow-up for everyone now, including people part-way through it, and retires its sequence. Switching it on again sends the message to WhatsApp for approval again, which can take hours.'
export const START_FROM_STANDARD = 'Start from the standard wording'
// RAILS.4 — keyed by the board's placement cadence (placementCadence).
export const BASELINE_NOTE = {
  nightly: 'Switching a board on never messages people who already qualify. They are placed that night without any messages; only people who qualify after that get the follow-ups.',
  hourly: 'Switching a board on never messages people who already qualify. They are placed within the hour without any messages; only people who qualify after that get the follow-ups.',
}

// The board's own sections: their checks decide whether Save may go.
const BOARD_STEPS = ['Name and offer', 'Who enters', 'Stages', 'Notes for Mia']
// Follow-up states a message is going out from (or about to): new wording
// replaces them, after a confirm.
const SENDING = new Set(['live', 'awaiting_approval'])
const STOPPABLE = new Set(['live', 'awaiting_approval', 'draft', 'rejected'])
// Install (as it stands) only where nothing was refused: a rejected row's
// wording is changed first, never resent.
const INSTALLABLE = new Set(['off', 'draft'])
// No row, or a spent one: installing it is a fresh install, owner work.
const OWNER_ONLY_INSTALL = new Set(['rejected', 'off'])
const isOwnerOnlyInstall = (row) => !row || OWNER_ONLY_INSTALL.has(row.state)

// The wizard's reducer, plus 'reset' to load a board the server returned.
function settingsReducer(state, action) {
  if (action?.type === 'reset') return action.state
  return wizardReducer(state, action)
}

function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`
  return JSON.stringify(v ?? null)
}

async function call(url, method = 'GET', body) {
  let res
  try {
    res = await fetch(url, {
      method,
      ...(body !== undefined ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
    })
  } catch {
    return { ok: false, status: 0, json: { error: 'Could not reach the server. Try again.' } }
  }
  let json = null
  try { json = await res.json() } catch { /* a non-JSON failure gets the generic message */ }
  return { ok: res.ok && !!json?.success, status: res.status, json: json || {} }
}

function errorText(json, fallback) {
  const issues = Array.isArray(json?.issues) ? json.issues.map((i) => i?.message).filter(Boolean) : []
  return [json?.error || fallback, ...issues].join(' ')
}

function Section({ title, children, note }) {
  return (
    <Card>
      <h2 className="mb-3 text-lg font-semibold text-un1t-text">{title}</h2>
      {note && <p className="mb-3 text-sm text-un1t-subtle">{note}</p>}
      {children}
    </Card>
  )
}

/** "a", "a and b", "a, b and c". */
function listJoin(items) {
  if (items.length <= 1) return items.join('')
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

/**
 * PIPEBUILD.5o — what a saved change did to the values filled into sent
 * follow-ups: the offer name (else the board name), the sign-off, the length.
 */
function filledInChanges(before, after) {
  const offer = (st) => st.offerName.trim() || st.name.trim()
  const out = []
  if (offer(before) !== offer(after)) out.push('offer name')
  if (before.signer.trim() !== after.signer.trim()) out.push('sign-off')
  if (before.durationDays !== after.durationDays) out.push('offer length')
  return out
}

/** The notice after such a save, naming the stages whose follow-up is sending. */
export function staleWordingNotice(labels, stageNames) {
  return `These follow-ups still use the old ${listJoin(labels)}: ${stageNames.join(', ')}. Change their wording to update them.`
}

/** The current row for a stage's pack (UNIQUE (stage_id, pack_key): at most one). */
function rowFor(board, stageId, packKey) {
  return (board.followups || []).find((f) => f.stage_id === stageId && f.pack_key === packKey) || null
}

/**
 * PIPEBUILD.5k — one board's settings (/settings/pipelines/[id]).
 *
 * Reads GET /api/pipelines/[id] (another studio's board is the route's 404)
 * and edits it with the wizard's reducer and step components. Owners, org
 * admins and masters (`can_edit`) change everything; the entry rule, the set
 * of stages, the timings and the priority only while the board is off. Anyone
 * with `can_edit_wording` changes the follow-ups. The routes are the judge;
 * this hides what the flags say the person cannot do.
 *
 * @param {object} props
 * @param {string} props.boardId
 * @param {string} props.locationId   the board's studio
 * @param {string} [props.studioName]
 * @param {string} [props.bookingFlowId]
 * @param {{ iosUrl: string, androidUrl: string }} [props.appLinks]
 */
export default function BoardSettings({ boardId, locationId, studioName = '', bookingFlowId, appLinks }) {
  const studio = useMemo(() => ({ studioName, bookingFlowId, appLinks }), [studioName, bookingFlowId, appLinks])
  const [load, setLoad] = useState({ loading: true, error: null })
  const [board, setBoard] = useState(null)
  const [flags, setFlags] = useState({ canEdit: false, canEditWording: false })
  const [state, dispatch] = useReducer(settingsReducer, studio, initialWizardState)

  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState(null)
  const [saved, setSaved] = useState(false)
  const [showErrors, setShowErrors] = useState(false)
  const [offBusy, setOffBusy] = useState(false)
  const [offError, setOffError] = useState(null)
  const [confirmOff, setConfirmOff] = useState(false)

  const [editing, setEditing] = useState(null)        // { packKey, stageId, before }
  const [confirm, setConfirm] = useState(null)        // { stage, pack }
  const [confirmOffRow, setConfirmOffRow] = useState(null) // { stage, pack }
  const [fuBusy, setFuBusy] = useState(null)          // stage id
  const [fuNotes, setFuNotes] = useState({})          // stage id -> { error?, info? }
  const [stale, setStale] = useState(null)            // { labels, stageIds } after a save changed filled-in values
  const inFlight = useRef(false)

  const recipe = board ? RECIPES[board.recipe_key] : null

  const fetchBoard = useCallback(async () => {
    const { ok, status, json } = await call(`/api/pipelines/${boardId}`)
    if (!ok) {
      return { error: status === 404 ? "This board doesn't exist, or it isn't at your studio." : (json.error || 'Could not load the board.') }
    }
    return { data: json.data }
  }, [boardId])

  const applyBoard = useCallback((data) => {
    setBoard(data.board)
    setFlags({ canEdit: !!data.can_edit, canEditWording: !!data.can_edit_wording })
    if (data.board?.board_type != null) dispatch({ type: 'reset', state: stateFromBoard(data.board, data.board.recipe_key, studio) })
  }, [studio])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const r = await fetchBoard()
      if (cancelled) return
      if (r.error) setLoad({ loading: false, error: r.error })
      else { applyBoard(r.data); setLoad({ loading: false, error: null }) }
    })()
    return () => { cancelled = true }
  }, [fetchBoard, applyBoard])

  // After a follow-up action or a switch on/off: the server's board again,
  // keeping any unsaved board edits; only the touched pack's wording reloads.
  async function refresh(packKey = null) {
    const r = await fetchBoard()
    if (r.error) return
    setBoard(r.data.board)
    setFlags({ canEdit: !!r.data.can_edit, canEditWording: !!r.data.can_edit_wording })
    if (packKey) {
      const fresh = stateFromBoard(r.data.board, r.data.board.recipe_key, studio)
      for (const [ref, body] of Object.entries(fresh.bodies[packKey] || {})) {
        dispatch({ type: 'setBody', packKey, ref, body })
      }
    }
  }

  const baseline = useMemo(
    () => (board && recipe ? stateFromBoard(board, recipe, studio) : null),
    [board, recipe, studio],
  )

  const patch = useMemo(() => {
    if (!baseline) return {}
    const out = {}
    if (state.name.trim() !== baseline.name.trim()) out.name = state.name.trim()
    if (state.priority !== baseline.priority) out.priority = state.priority
    const next = settingsConfig(state, board.config)
    if (stable(next) !== stable(settingsConfig(baseline, board.config))) out.config = next
    return out
  }, [state, baseline, board])
  const dirty = Object.keys(patch).length > 0

  if (load.loading) return <Loading label="Loading the board" />
  if (load.error) return <Card><p className="text-sm text-red-700" role="alert">{load.error}</p></Card>

  const stages = [...(board.stages || [])].sort((a, b) => a.display_order - b.display_order)

  if (board.board_type == null) {
    return (
      <Card>
        <h2 className="text-lg font-semibold text-un1t-text">{board.name}</h2>
        <p className="mt-1 text-sm text-un1t-text">{LEGACY_NOTICE}</p>
        <ul className="mt-3 space-y-1">
          {stages.map((st) => <li key={st.id} className="text-sm text-un1t-text">{st.name}</li>)}
        </ul>
      </Card>
    )
  }

  if (!recipe) {
    return <Card><p className="text-sm text-red-700" role="alert">This board uses a recipe this page doesn&apos;t know.</p></Card>
  }

  const { canEdit, canEditWording } = flags
  const on = !!board.enabled
  const structureLocked = !canEdit || on
  const lockNote = canEdit && on ? SWITCH_OFF_NOTE : null
  const errors = BOARD_STEPS.flatMap((s) => stepErrors(state, s))

  async function save() {
    if (inFlight.current || !dirty) return
    if (errors.length) { setShowErrors(true); return }
    inFlight.current = true
    setSaving(true); setSaveError(null); setSaved(false); setStale(null)
    const changed = filledInChanges(baseline, state)
    try {
      const { ok, json } = await call(`/api/pipelines/${board.id}`, 'PATCH', patch)
      if (!ok) { setSaveError(errorText(json, 'Could not save the board.')); return }
      // The PATCH answers without the follow-ups' wording: read the board again.
      const r = await fetchBoard()
      const fresh = r.data || { board: json.data.board, can_edit: canEdit, can_edit_wording: canEditWording }
      applyBoard(fresh)
      setShowErrors(false); setSaved(true)
      // PIPEBUILD.5o — follow-ups already sent to Meta keep the old values:
      // name every stage whose follow-up is sending (or about to).
      if (changed.length) {
        const freshFollowups = fresh.board?.followups || board.followups || []
        const stageIds = [...(fresh.board?.stages || board.stages || [])]
          .sort((a, b) => a.display_order - b.display_order)
          .filter((st) => freshFollowups.some((f) => f.stage_id === st.id && SENDING.has(f.state)))
          .map((st) => st.id)
        if (stageIds.length) setStale({ labels: changed, stageIds })
      }
    } finally {
      inFlight.current = false
      setSaving(false)
    }
  }

  async function turnOff() {
    if (inFlight.current) return
    inFlight.current = true
    setOffBusy(true); setOffError(null)
    try {
      const { ok, json } = await call(`/api/pipelines/${board.id}/disable`, 'POST')
      if (!ok) { setOffError(json.error || 'Could not switch the board off.'); return }
      setConfirmOff(false)
      await refresh()
    } finally {
      inFlight.current = false
      setOffBusy(false)
    }
  }

  // A stage whose wording was changed (or switched off) no longer carries old values.
  function clearStale(stageId) {
    setStale((cur) => {
      if (!cur) return cur
      const stageIds = cur.stageIds.filter((id) => id !== stageId)
      return stageIds.length ? { ...cur, stageIds } : null
    })
  }

  async function followupAction(stage, pack, action, bodies) {
    if (inFlight.current) return false
    inFlight.current = true
    setFuBusy(stage.id)
    setFuNotes((n) => ({ ...n, [stage.id]: {} }))
    try {
      const { ok, json } = await call(
        `/api/pipelines/${board.id}/followups/${stage.id}`, 'PUT',
        { action, pack_key: pack.key, ...(bodies ? { bodies } : {}) },
      )
      if (!ok) {
        setFuNotes((n) => ({ ...n, [stage.id]: { error: json.error || 'The follow-up could not be changed.' } }))
        return false
      }
      const publishError = json.data?.publish_error
      setFuNotes((n) => ({ ...n, [stage.id]: publishError ? { error: publishError } : {} }))
      await refresh(pack.key)
      return true
    } finally {
      inFlight.current = false
      setFuBusy(null)
    }
  }

  // `fromStandard`: a switched-off follow-up whose wording could not be read
  // starts from the recipe's wording, so nothing half-known is edited.
  function startEditing(stage, pack, fromStandard = false) {
    setEditing({ stageId: stage.id, packKey: pack.key, fromStandard, before: { ...(state.bodies[pack.key] || {}) } })
    if (fromStandard) {
      for (const t of pack.templates) dispatch({ type: 'setBody', packKey: pack.key, ref: t.ref, body: t.body })
    }
  }

  function cancelEditing() {
    if (!editing) return
    for (const [ref, body] of Object.entries(editing.before)) {
      dispatch({ type: 'setBody', packKey: editing.packKey, ref, body })
    }
    setEditing(null)
  }

  // PIPEBUILD.5o — the recipe's own wording, which the preview (and Meta)
  // fills in with the board's current offer name, sign-off and length.
  function startFromStandard(pack) {
    for (const t of pack.templates) dispatch({ type: 'setBody', packKey: pack.key, ref: t.ref, body: t.body })
  }

  async function saveWording(stage, pack, row) {
    if (row && SENDING.has(row.state)) { setConfirm({ stage, pack }); return }
    if (!canEdit && isOwnerOnlyInstall(row)) return
    const done = await followupAction(stage, pack, 'install', packBodies(state, pack.key))
    if (done) { setEditing(null); clearStale(stage.id) }
  }

  async function confirmReplace() {
    if (!confirm) return
    const { stage, pack } = confirm
    const done = await followupAction(stage, pack, 'replace', packBodies(state, pack.key))
    setConfirm(null)
    if (done) { setEditing(null); clearStale(stage.id) }
  }

  async function confirmFollowupOff() {
    if (!confirmOffRow) return
    const { stage, pack } = confirmOffRow
    const done = await followupAction(stage, pack, 'off')
    setConfirmOffRow(null)
    if (done) clearStale(stage.id)
  }

  const staleNames = stale
    ? stale.stageIds.map((id) => (board.stages || []).find((st) => st.id === id)?.name).filter(Boolean)
    : []

  const wordingErrors = (pack) => pack.templates
    .map((t) => previewTemplate(state, pack.key, t.ref).error)
    .filter(Boolean)

  return (
    <div className="space-y-4">
      {!canEdit && (
        <Card>
          <p className="text-sm text-un1t-text">
            {canEditWording
              ? 'Only owners can change this board. You can change its follow-ups.'
              : 'Only owners can change this board.'}
          </p>
        </Card>
      )}

      <Section title="Status">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`rounded-full px-2 py-0.5 text-xs ${on ? 'bg-green-500/10 text-green-700' : 'bg-gray-500/10 text-gray-700'}`}>
            {on ? 'On' : 'Off'}
          </span>
          <span className="text-sm text-un1t-subtle">{boardStatus(board)}</span>
          {canEdit && on && (
            <Button type="button" variant="secondary" size="sm" className="ml-auto" onClick={() => { setOffError(null); setConfirmOff(true) }}>Turn off</Button>
          )}
        </div>
        <p className="mt-2 text-sm text-un1t-subtle">{BASELINE_NOTE[placementCadence(board)]}</p>
      </Section>

      {board.board_type === 'offer' && <BoardReport boardId={boardId} stages={board.stages || []} />}

      {canEdit && !on && (
        <BoardLaunchPanel board={board} followups={board.followups || []} onEnabled={() => refresh()} />
      )}

      <Section title="Name, offer and signer">
        <NameOfferStep state={state} dispatch={dispatch} fields={['name', 'offer', 'signer']} disabled={!canEdit} />
        {canEdit && (
          <p className="mt-2 text-xs text-un1t-subtle">
            {FILLED_IN_NOTE}
          </p>
        )}
      </Section>

      <Section title="Who enters" note={lockNote}>
        <EntryStep state={state} dispatch={dispatch} locationId={locationId} entryTypes={ENTRY_TYPES_BY_MODULE[board.module] || ENTRY_TYPES_BY_MODULE.offer} disabled={structureLocked} />
      </Section>

      <Section title="Stages" note={lockNote ? `${lockNote} Stage names can change any time.` : null}>
        <StagesStep state={state} dispatch={dispatch} structureLocked={on} disabled={!canEdit} />
      </Section>

      <Section title="Timings" note={lockNote}>
        <NameOfferStep state={state} dispatch={dispatch} fields={['days']} disabled={structureLocked} />
      </Section>

      <Section title="Priority" note={lockNote}>
        <NameOfferStep state={state} dispatch={dispatch} fields={['priority']} disabled={structureLocked} />
      </Section>

      <Section title="Notes for Mia">
        <MiaNotesStep state={state} dispatch={dispatch} disabled={!canEdit} />
      </Section>

      {canEdit && (
        <Card>
          {showErrors && errors.length > 0 && (
            <ul className="mb-3 space-y-1" role="alert">
              {errors.map((e) => <li key={e} className="text-sm text-red-700">{e}</li>)}
            </ul>
          )}
          {saveError && <p className="mb-3 text-sm text-red-700" role="alert">{saveError}</p>}
          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" disabled={!dirty} loading={saving} onClick={save}>Save</Button>
            {!dirty && saved && <span className="text-sm text-un1t-subtle">Saved.</span>}
            {dirty && <span className="text-sm text-un1t-subtle">You have unsaved changes.</span>}
          </div>
          {staleNames.length > 0 && (
            <p className="mt-3 text-sm text-amber-700" role="status">{staleWordingNotice(stale.labels, staleNames)}</p>
          )}
        </Card>
      )}

      <Section title="Follow-ups">
        {board.wording_unread && (
          <p className="mb-3 text-sm text-amber-700">Could not read the current wording just now. Reload the page to try again.</p>
        )}
        {board.health_unread && (
          <p className="mb-3 text-sm text-amber-700">{HEALTH_UNREAD_NOTICE}</p>
        )}
        <ul className="space-y-4">
          {stages.map((stage) => {
            const pack = packForBoardStage(recipe, stage)
            const chip = followupChip(board.followups, stage.id)
            const row = pack ? rowFor(board, stage.id, pack.key) : null
            const rowState = row?.state || null
            const isEditing = editing?.stageId === stage.id
            const busy = fuBusy === stage.id
            const note = fuNotes[stage.id] || {}
            // Wording a follow-up sends that could not be read is never
            // replaced by what the editor would show in its place.
            // A switched-off row sends nothing, so it may always take new
            // wording: there it starts from the recipe's instead.
            const unreadable = !!row?.whatsapp_template_id
              && (!!board.wording_unread || (row.wording_missing || []).length > 0)
            const wordingUnknown = unreadable && rowState !== 'off'
            // Install would send standard (or half-standard) wording unseen,
            // so a switched-off row whose wording could not be read goes in
            // only through Change wording, which says it starts from standard.
            const offUnreadable = unreadable && rowState === 'off'
            const canInstall = !row || INSTALLABLE.has(rowState)
            const ownerOnlyInstall = isOwnerOnlyInstall(row)
            const installBlocked = !canEdit && ownerOnlyInstall
            const rejected = rowState === 'rejected'
            const unchanged = isEditing && editing && pack
              && Object.entries(editing.before).every(([ref, body]) => state.bodies[pack.key]?.[ref] === body)
            const wErrors = isEditing && pack ? wordingErrors(pack) : []
            return (
              <li key={stage.id} className="rounded-lg border border-un1t-border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-un1t-text">{stage.name}</span>
                  {pack && <span className={`rounded-full px-2 py-0.5 text-xs ${chip.tone}`}>{chip.label}</span>}
                  {pack && <span className="text-xs text-un1t-subtle">{pack.name}</span>}
                </div>
                {!pack && <p className="mt-1 text-sm text-un1t-subtle">No follow-up for this stage.</p>}
                {pack && !isEditing && (
                  <div className="mt-2 space-y-2">
                    {pack.templates.map((t) => {
                      const text = row?.body_texts?.[t.ref]
                      return text ? (
                        <p key={t.ref} className="whitespace-pre-wrap rounded-md bg-un1t-surface p-2 text-sm text-un1t-text">{text}</p>
                      ) : null
                    })}
                    {row && !row.body_texts && !unreadable && (
                      <p className="text-sm text-un1t-subtle">No wording saved for this follow-up yet.</p>
                    )}
                  </div>
                )}
                {pack && isEditing && (
                  <div className="mt-3 space-y-3">
                    {editing?.fromStandard && <p className="text-sm text-amber-700">{OLD_WORDING_UNKNOWN_NOTE}</p>}
                    <div>
                      <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => startFromStandard(pack)}>
                        {START_FROM_STANDARD}
                      </Button>
                    </div>
                    <FollowupsStep state={state} dispatch={dispatch} packKeys={[pack.key]} />
                    {dirty && <p className="text-sm text-amber-700">Save the board first: the preview and Meta use the saved offer name and sign-off.</p>}
                    <div className="flex flex-wrap gap-2">
                      <Button type="button" size="sm" loading={busy} disabled={installBlocked || wErrors.length > 0 || dirty || (rejected && unchanged)}
                        onClick={() => saveWording(stage, pack, row)}>
                        Save wording
                      </Button>
                      <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={cancelEditing}>Cancel</Button>
                    </div>
                    {installBlocked && <p className="text-sm text-amber-700">{OWNER_ONLY_INSTALL_NOTE}</p>}
                  </div>
                )}
                {pack && rejected && <p className="mt-2 text-sm text-red-700">{canEdit ? REJECTED_NOTE : OWNER_ONLY_REJECTED_NOTE}</p>}
                {pack && wordingUnknown && canEditWording && <p className="mt-2 text-sm text-amber-700">{WORDING_UNKNOWN_NOTE}</p>}
                {note.error && <p className="mt-2 text-sm text-red-700" role="alert">{note.error}</p>}
                {pack && canEditWording && !isEditing && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button type="button" size="sm" variant="secondary" disabled={!!fuBusy || !!editing || wordingUnknown} onClick={() => startEditing(stage, pack, offUnreadable)}>
                      Change wording
                    </Button>
                    {canEdit && row && STOPPABLE.has(rowState) && (
                      <Button type="button" size="sm" variant="secondary" loading={busy} disabled={!!fuBusy && !busy}
                        onClick={() => setConfirmOffRow({ stage, pack })}>
                        Switch off
                      </Button>
                    )}
                    {canInstall && (canEdit || !ownerOnlyInstall) && (
                      <Button type="button" size="sm" loading={busy} disabled={(!!fuBusy && !busy) || dirty || wordingUnknown || offUnreadable}
                        onClick={() => followupAction(stage, pack, 'install', packBodies(state, pack.key))}>
                        Install
                      </Button>
                    )}
                    {rowState === 'awaiting_approval' && (
                      <Button type="button" size="sm" variant="ghost" loading={busy} disabled={!!fuBusy && !busy}
                        onClick={() => followupAction(stage, pack, 'install')}>
                        Publish now if Meta has approved it
                      </Button>
                    )}
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      </Section>

      <Modal
        open={confirmOff}
        onClose={() => { if (!offBusy) setConfirmOff(false) }}
        title="Turn off this board"
        footer={(
          <>
            <Button type="button" variant="secondary" disabled={offBusy} onClick={() => setConfirmOff(false)}>Cancel</Button>
            <Button type="button" loading={offBusy} onClick={turnOff}>Turn off</Button>
          </>
        )}
      >
        <p className="text-sm text-un1t-text">{TURN_OFF_CONFIRM}</p>
        {offError && <p className="mt-2 text-sm text-red-700" role="alert">{offError}</p>}
      </Modal>

      <Modal
        open={!!confirmOffRow}
        onClose={() => { if (!fuBusy) setConfirmOffRow(null) }}
        title="Switch off this follow-up"
        footer={(
          <>
            <Button type="button" variant="secondary" disabled={!!fuBusy} onClick={() => setConfirmOffRow(null)}>Cancel</Button>
            <Button type="button" loading={!!fuBusy} onClick={confirmFollowupOff}>Switch off</Button>
          </>
        )}
      >
        <p className="text-sm text-un1t-text">{FOLLOWUP_OFF_CONFIRM}</p>
      </Modal>

      <Modal
        open={!!confirm}
        onClose={() => { if (!fuBusy) setConfirm(null) }}
        title="Change the wording"
        footer={(
          <>
            <Button type="button" variant="secondary" disabled={!!fuBusy} onClick={() => setConfirm(null)}>Cancel</Button>
            <Button type="button" loading={!!fuBusy} onClick={confirmReplace}>Change wording</Button>
          </>
        )}
      >
        <p className="text-sm text-un1t-text">{REPLACE_CONFIRM}</p>
      </Modal>
    </div>
  )
}
