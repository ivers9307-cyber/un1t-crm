import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { redirect, notFound } from 'next/navigation'
import WABroadcastEditor from '@/components/WABroadcastEditor'
import { dripWindowStatus } from '@/lib/whatsapp-drip'

export const dynamic = 'force-dynamic'

export default async function EditBroadcastPage(props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) redirect('/login')

  const db = createServerClient()
  const { data: broadcast } = await db.from('whatsapp_broadcasts')
    .select('*, whatsapp_templates(*), whatsapp_broadcast_recipients(*, contacts(name, phone, wa_phone))')
    .eq('id', params.id)
    .single()

  if (!broadcast) notFound()

  const { data: templates } = await db.from('whatsapp_templates')
    .select('*')
    .eq('location_id', user.activeLocation?.id)
    .eq('status', 'APPROVED')
    .order('name')

  // Failed recipients — fetched separately (the embed above is capped at 1000
  // rows for a large drip). Name · number · failure reason, newest first.
  const { data: failedRecipients } = await db.from('whatsapp_broadcast_recipients')
    .select('id, error_message, failed_at, contacts(name, wa_phone, phone)')
    .eq('broadcast_id', params.id)
    .eq('status', 'failed')
    .order('failed_at', { ascending: false })
    .limit(200)
  const { count: failedCount } = await db.from('whatsapp_broadcast_recipients')
    .select('id', { count: 'exact', head: true })
    .eq('broadcast_id', params.id)
    .eq('status', 'failed')

  // Live drip progress — computed at page load from the recipient rows so it never
  // shows the stale per-tick `total_sent` snapshot, plus delivered/read engagement,
  // today's rolling-24h cap usage, and the send-window state. Drip only.
  let dripProgress = null
  if (broadcast.delivery_mode === 'drip') {
    const DISPATCHED = ['sent', 'delivered', 'read']
    const countRecips = async (apply) => {
      const { count } = await apply(
        db.from('whatsapp_broadcast_recipients').select('id', { count: 'exact', head: true }).eq('broadcast_id', params.id)
      )
      return count || 0
    }
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const [dispatched, reached, read, failed, sentToday] = await Promise.all([
      countRecips(q => q.in('status', DISPATCHED)),
      countRecips(q => q.in('status', ['delivered', 'read'])),
      countRecips(q => q.eq('status', 'read')),
      countRecips(q => q.eq('status', 'failed')),
      countRecips(q => q.in('status', DISPATCHED).gt('sent_at', since)),
    ])
    dripProgress = {
      dispatched, reached, read, failed, sentToday,
      window: dripWindowStatus(new Date(), {
        start: broadcast.send_window_start, end: broadcast.send_window_end,
        tz: broadcast.send_window_tz, paused: !!broadcast.paused_at,
      }),
    }
  }

  return (
    <WABroadcastEditor
      broadcast={broadcast}
      templates={templates || []}
      locationId={user.activeLocation?.id}
      userId={user.id}
      failedRecipients={failedRecipients || []}
      failedCount={failedCount || 0}
      dripProgress={dripProgress}
    />
  )
}
