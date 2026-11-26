// PILLAR2 — the unified "Sent" history. One list across WhatsApp and email
// sends for the active location (replaces the per-channel list pages, which
// now redirect here). SMS broadcasts left the list when SMS was retired with
// Twilio (TWILIO-RETIRE.1); their rows stay on disk as history. Email
// campaigns joined in Phase 2 and this is the parent every channel detail view
// links back to (COMMSLAYOUT.4).
//
// COMMS-IA.1 — every row now opens a child of THIS route
// (/communications/sent/[channel]/[id]) instead of one of three unrelated URL
// spaces, so the detail views inherit this hub's shell and tab strip.
// COMMS-IA.3 — the label is "Sent", matching the route it has always had.
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { MessageCircle, Mail, Send } from 'lucide-react'
import { sendStatusChip } from './send-status.js'
// REPORT-SOT.2 — the email rows on this list are counted from
// campaign_recipients, not from campaigns.total_*.
import { loadCampaignRecipientStats, campaignDisplayStats, pct } from '@/lib/campaign-display-stats'

export const dynamic = 'force-dynamic'

function fmtDate(iso) {
  if (!iso) return ''
  return new Date(iso).toLocaleString('en-IE', { dateStyle: 'medium', timeStyle: 'short' })
}

const SELECT = 'id, name, status, total_recipients, total_sent, total_failed, created_at, scheduled_at, sent_at'

export default async function SendsHistoryPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  const canWa = hasPermission(user, 'whatsapp')
  const canEmail = hasPermission(user, 'email')
  if (!canWa && !canEmail) redirect('/communications')

  const locationId = user.activeLocation?.id
  const db = createServerClient()
  const rows = []

  if (canWa && locationId) {
    const { data } = await db.from('whatsapp_broadcasts').select(`${SELECT}, delivery_summary, delivery_mode`)
      .eq('location_id', locationId).order('created_at', { ascending: false }).limit(100)
    for (const b of data || []) {
      const row = { ...b, channel: 'whatsapp', detail: `/communications/sent/whatsapp/${b.id}` }
      // An in-flight drip's total_sent is a per-tick snapshot that lags the live
      // "dispatched" (sent+delivered+read) count the detail page shows. Recompute
      // it here so the list and the detail agree. Bounded — only in-flight drips.
      if (b.status === 'sending' && b.delivery_mode === 'drip') {
        const { count } = await db.from('whatsapp_broadcast_recipients')
          .select('id', { count: 'exact', head: true })
          .eq('broadcast_id', b.id)
          .in('status', ['sent', 'delivered', 'read'])
        row.total_sent = count ?? b.total_sent
      }
      rows.push(row)
    }
  }
  if (canEmail && locationId) {
    // campaigns has its own count columns (total_bounced, not total_failed).
    // COMMSFIX.C.5 — last_error (mig 509) is why a campaign is 'failed', or why
    // one still sitting at 'queued' is not moving.
    const { data } = await db.from('campaigns')
      .select('id, name, status, total_recipients, total_sent, total_bounced, created_at, scheduled_at, sent_at, parent_campaign_id, resend_enabled, last_error, created_via')
      .eq('location_id', locationId).order('created_at', { ascending: false }).limit(100)
    // REPORT-SOT.2 — the displayed counts come from campaign_recipients, one
    // RPC for the whole page rather than one per row. The stored counters stay
    // in the select: campaignDisplayStats falls back to them if the RPC fails,
    // so a degraded render is the OLD behaviour rather than a third answer.
    const stats = await loadCampaignRecipientStats(db, (data || []).map((c) => c.id))
    for (const c of data || []) {
      const d = campaignDisplayStats(c, stats)
      rows.push({
        ...c,
        channel: 'email',
        total_recipients: d.recipients,
        total_sent: d.sent,
        total_failed: d.bounced,
        // MKTSHELL.2 — delivered and clicked in the row, so campaigns can be
        // compared without opening each one. Only from campaign_recipients:
        // the select above does not carry the stored delivered/clicked
        // counters, so a counters-fallback render shows a dash, not a zero.
        // `delivered` is null when the count is provably incomplete
        // (REPORT-SOT.3), and that reads as a dash too.
        delivered: d.source === 'recipients' ? d.delivered : null,
        clicked: d.source === 'recipients' ? d.clicked : null,
        click_rate: d.source === 'recipients' ? d.click_rate : null,
        detail: `/communications/sent/email/${c.id}`,
      })
    }
  }
  rows.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())

  return (
    <div>
      <div className="flex items-start justify-between gap-4 mb-5">
        <div>
          <h1 className="text-xl font-semibold text-un1t-text">Sent</h1>
          <p className="text-sm text-un1t-subtle">One-off WhatsApp and email sends at this location.</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {/* NEWEMAIL.1 — the full editor's own way in, blank or from a template. */}
          {canEmail && (
            <Link href="/communications/new-email"
              className="inline-flex items-center gap-1.5 rounded-lg border border-un1t-border px-3 py-2 text-sm font-medium text-un1t-text hover:border-un1t-text/30">
              <Mail size={15} /> New email
            </Link>
          )}
          <Link href="/communications/send"
            className="inline-flex items-center gap-1.5 rounded-lg bg-un1t-text text-un1t-bg px-3 py-2 text-sm font-medium hover:bg-un1t-accent">
            <Send size={15} /> Send a message
          </Link>
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="text-center py-16 border border-dashed border-un1t-border rounded-2xl">
          <Send size={28} className="mx-auto mb-3 text-un1t-subtle" />
          <h2 className="text-base font-semibold text-un1t-text mb-1">Nothing sent from this studio yet</h2>
          <p className="text-sm text-un1t-subtle max-w-md mx-auto">
            Every WhatsApp and email send shows here with who it went to and how it did.{' '}
            <Link href="/communications/send" className="text-un1t-text underline">Send your first message</Link>.
          </p>
        </div>
      ) : (
        <div className="rounded-2xl border border-un1t-border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-un1t-bg/40 text-un1t-subtle text-xs uppercase tracking-wider">
              <tr>
                <th className="text-left font-medium px-4 py-2.5">Message</th>
                <th className="text-left font-medium px-4 py-2.5">Status</th>
                <th className="text-right font-medium px-4 py-2.5">Sent</th>
                <th className="text-right font-medium px-4 py-2.5 hidden lg:table-cell">Delivered</th>
                <th className="text-right font-medium px-4 py-2.5 hidden lg:table-cell">Clicked</th>
                <th className="text-right font-medium px-4 py-2.5 hidden sm:table-cell">When</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => {
                const Icon = r.channel === 'email' ? Mail : MessageCircle
                return (
                  <tr key={`${r.channel}-${r.id}`} className="border-t border-un1t-border hover:bg-un1t-bg/30">
                    <td className="px-4 py-3 max-w-0 w-full">
                      <Link href={r.detail} className="flex items-center gap-2 min-w-0">
                        <Icon size={15} className="text-un1t-subtle shrink-0" />
                        <span className="text-un1t-text truncate">{r.name || 'Untitled'}</span>
                        {/* CAMPAIGN-RESEND — child = a resend campaign; a flagged
                            parent still has its resend pending. */}
                        {r.parent_campaign_id && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-un1t-border/40 text-un1t-subtle shrink-0">Resend</span>
                        )}
                        {/* MCPEMAIL.1 — drafted from Claude through the staff MCP server. */}
                        {r.created_via === 'mcp' && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-violet-500/10 text-violet-700 shrink-0">Made in Claude</span>
                        )}
                        {r.resend_enabled && r.status === 'sent' && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-blue-500/15 text-blue-700 shrink-0">resend scheduled</span>
                        )}
                      </Link>
                    </td>
                    <td className="px-4 py-3">
                      {(() => {
                        const chip = sendStatusChip(r)
                        return (
                          <span
                            title={chip.title}
                            className={`text-[11px] font-medium px-2 py-0.5 rounded-full capitalize ${chip.className}`}
                          >{r.status}</span>
                        )
                      })()}
                    </td>
                    {/* MKTSHELL.3 — one line per campaign: the counts and the date never wrap. */}
                    <td className="px-4 py-3 text-right text-un1t-subtle tabular-nums whitespace-nowrap">
                      {(r.status === 'sent' || r.status === 'sending')
                        ? <>
                            {(r.total_sent || 0).toLocaleString()}
                            {r.total_failed ? <span className="text-rose-700"> · {r.total_failed} failed</span> : null}
                            {(() => {
                              const ds = r.delivery_summary
                              const k = ds && ds.matched != null && ds.reachable != null ? ds.matched - ds.reachable : 0
                              return k > 0 ? <span className="text-amber-700"> · {k} excluded</span> : null
                            })()}
                          </>
                        : '—'}
                    </td>
                    {/* MKTSHELL.2 — email only; WhatsApp rows and anything not yet sent read as a dash. */}
                    <td className="px-4 py-3 text-right text-un1t-subtle hidden lg:table-cell tabular-nums whitespace-nowrap">
                      {r.channel === 'email' && r.status === 'sent' && r.delivered != null
                        ? r.delivered.toLocaleString()
                        : '—'}
                    </td>
                    <td className="px-4 py-3 text-right text-un1t-subtle hidden lg:table-cell tabular-nums whitespace-nowrap">
                      {r.channel === 'email' && r.status === 'sent' && r.clicked != null
                        ? <>{r.clicked.toLocaleString()}{r.click_rate != null ? <span className="text-un1t-subtle/70"> · {pct(r.click_rate)}</span> : null}</>
                        : '—'}
                    </td>
                    <td className="px-4 py-3 text-right text-un1t-subtle hidden sm:table-cell tabular-nums whitespace-nowrap">
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
