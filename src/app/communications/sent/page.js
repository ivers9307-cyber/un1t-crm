// PILLAR2 Phase 1 — unified "Sends" history. One list across SMS + WhatsApp
// one-off sends for the active location (replaces the two per-channel broadcast
// list pages, which now redirect here). Email campaigns join in Phase 2.
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { MessageSquare, MessageCircle, Send } from 'lucide-react'

export const dynamic = 'force-dynamic'

const STATUS_STYLE = {
  draft: 'bg-un1t-border/40 text-un1t-subtle',
  scheduled: 'bg-blue-500/15 text-blue-700',
  sending: 'bg-amber-500/15 text-amber-700',
  sent: 'bg-emerald-500/15 text-emerald-700',
  cancelled: 'bg-rose-500/15 text-rose-700',
}

function fmtDate(iso) {
  if (!iso) return ''
  return new Date(iso).toLocaleString('en-IE', { dateStyle: 'medium', timeStyle: 'short' })
}

const SELECT = 'id, name, status, total_recipients, total_sent, total_failed, created_at, scheduled_at, sent_at'

export default async function SendsHistoryPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  const canSms = hasPermission(user, 'sms')
  const canWa = hasPermission(user, 'whatsapp')
  if (!canSms && !canWa) redirect('/communications')

  const locationId = user.activeLocation?.id
  const db = createServerClient()
  const rows = []

  if (canSms && locationId) {
    const { data } = await db.from('sms_broadcasts').select(SELECT)
      .eq('location_id', locationId).order('created_at', { ascending: false }).limit(100)
    for (const b of data || []) rows.push({ ...b, channel: 'sms', detail: `/communications/sms/broadcasts/${b.id}` })
  }
  if (canWa && locationId) {
    const { data } = await db.from('whatsapp_broadcasts').select(SELECT)
      .eq('location_id', locationId).order('created_at', { ascending: false }).limit(100)
    for (const b of data || []) rows.push({ ...b, channel: 'whatsapp', detail: `/whatsapp/broadcasts/${b.id}` })
  }
  rows.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())

  return (
    <div>
      <div className="flex items-start justify-between gap-4 mb-5">
        <div>
          <Link href="/communications" className="text-xs text-un1t-subtle hover:text-un1t-text">← Communications</Link>
          <h1 className="text-xl font-semibold text-un1t-text mt-1">Sends</h1>
          <p className="text-sm text-un1t-subtle">One-off SMS &amp; WhatsApp sends at this location.</p>
        </div>
        <Link href="/communications/send"
          className="inline-flex items-center gap-1.5 rounded-lg bg-un1t-text text-un1t-bg px-3 py-2 text-sm font-medium hover:bg-un1t-accent shrink-0">
          <Send size={15} /> Send a message
        </Link>
      </div>

      {rows.length === 0 ? (
        <div className="text-center text-sm text-un1t-subtle py-16 border border-dashed border-un1t-border rounded-2xl">
          No sends yet. <Link href="/communications/send" className="text-un1t-text underline">Send your first message</Link>.
        </div>
      ) : (
        <div className="rounded-2xl border border-un1t-border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-un1t-bg/40 text-un1t-subtle text-xs uppercase tracking-wider">
              <tr>
                <th className="text-left font-medium px-4 py-2.5">Message</th>
                <th className="text-left font-medium px-4 py-2.5">Status</th>
                <th className="text-right font-medium px-4 py-2.5">Sent</th>
                <th className="text-right font-medium px-4 py-2.5 hidden sm:table-cell">When</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => {
                const Icon = r.channel === 'sms' ? MessageSquare : MessageCircle
                return (
                  <tr key={`${r.channel}-${r.id}`} className="border-t border-un1t-border hover:bg-un1t-bg/30">
                    <td className="px-4 py-3">
                      <Link href={r.detail} className="flex items-center gap-2 min-w-0">
                        <Icon size={15} className="text-un1t-subtle shrink-0" />
                        <span className="text-un1t-text truncate">{r.name || 'Untitled'}</span>
                      </Link>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`text-[11px] font-medium px-2 py-0.5 rounded-full capitalize ${STATUS_STYLE[r.status] || STATUS_STYLE.draft}`}>{r.status}</span>
                    </td>
                    <td className="px-4 py-3 text-right text-un1t-subtle tabular-nums">
                      {(r.status === 'sent' || r.status === 'sending')
                        ? <>{(r.total_sent || 0).toLocaleString()}{r.total_failed ? <span className="text-rose-700"> · {r.total_failed} failed</span> : null}</>
                        : '—'}
                    </td>
                    <td className="px-4 py-3 text-right text-un1t-subtle hidden sm:table-cell tabular-nums">
                      {r.status === 'scheduled' ? `⏱ ${fmtDate(r.scheduled_at)}` : fmtDate(r.sent_at || r.created_at)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
