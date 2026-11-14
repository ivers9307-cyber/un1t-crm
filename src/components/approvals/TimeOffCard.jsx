'use client'

// APPROVALSQ.4 — a time-off request decided on /approvals. Approving never
// touches the roster; when the route's answer carries `clashes` (shifts the
// person is still rostered for inside the leave) the card asks, and only
// unassigns on an explicit press of "Unassign them". Same wording and ids as the
// Time Off page and the phone (leaveClashPrompt).
import { useRef, useState } from 'react'
import { Button } from '@/components/ui'
import { leaveClashPrompt } from '@shared/time-off'
import { unassignLeaveClashes } from '@/lib/approvals/team-actions'
import TeamDecideCard from './TeamDecideCard'

function ClashStep({ requestId, name, prompt }) {
  const [phase, setPhase] = useState('ask') // 'ask' | 'kept' | 'done'
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [message, setMessage] = useState(null)
  const inFlight = useRef(false)
  const count = prompt.assignmentIds.length

  async function unassign() {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError(null)
    try {
      const r = await unassignLeaveClashes(requestId, prompt.assignmentIds)
      if (!r?.ok) { setError(r?.error || 'The shifts were not changed.'); return }
      const removed = (r.data?.removed?.length || 0) + (r.data?.already_removed?.length || 0)
      const skipped = r.data?.skipped?.length || 0
      setMessage(
        `Unassigned from ${removed} shift${removed === 1 ? '' : 's'}.` +
        (skipped ? ` ${skipped} at a studio you don't manage ${skipped === 1 ? 'was' : 'were'} left on the roster.` : ''),
      )
      setPhase('done')
    } catch (e) {
      setError(e?.message || 'Network error. Please try again.')
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  if (phase === 'kept') return null
  if (phase === 'done') return <div className="w-full text-sm rounded-md px-3 py-2 bg-green-500/10 text-green-700">{message}</div>
  return (
    <div className="w-full space-y-2">
      <div className="text-sm rounded-md px-3 py-2 bg-amber-500/10 text-amber-700 space-y-1">
        <div>{`${name} is still rostered for ${count} shift${count === 1 ? '' : 's'} in this leave.`}</div>
        <div className="text-xs whitespace-pre-line">{prompt.message.split('\n').slice(1).join('\n')}</div>
      </div>
      {error && <div className="text-sm rounded-md px-3 py-2 bg-red-500/10 text-red-700">{error}</div>}
      <div className="flex gap-2 flex-wrap">
        <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => setPhase('kept')}>Keep them rostered</Button>
        <Button type="button" size="sm" variant="primary" loading={busy} disabled={busy} onClick={unassign}>Unassign them</Button>
      </div>
    </div>
  )
}

export default function TimeOffCard({ item, ...rest }) {
  return (
    <TeamDecideCard
      item={item}
      providerKey="time_off"
      {...rest}
      afterApprove={(result) => {
        const prompt = leaveClashPrompt(result?.body?.clashes)
        if (prompt) {
          const name = result?.body?.data?.profiles?.full_name || item.title
          return <ClashStep requestId={item.id} name={name} prompt={prompt} />
        }
        const err = result?.body?.clashes_error
        return err ? <div className="w-full text-sm rounded-md px-3 py-2 bg-amber-500/10 text-amber-700">{`${err}.`}</div> : null
      }}
    />
  )
}
