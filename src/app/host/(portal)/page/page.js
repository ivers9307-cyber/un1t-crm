// Host "Your page" (HOSTPORTAL.1): edit the public /h/[slug] page. Server
// page reads the slug, tenant base url, signup count and copy, then hands
// plain data to the client component (never a function).

import { redirect } from 'next/navigation'
import { getCurrentHost } from '@/lib/host-auth'
import { createServerClient } from '@/lib/supabase'
import { ensureHostSlug } from '@/lib/hosts'
import { resolveCustomerBaseUrl } from '@/lib/tenant-host'
import { hostPageExtras } from '@/lib/host-page-extras'
import { logWarn } from '@/lib/log'
import HostYourPage from '@/components/host/HostYourPage'
import { HOST_H1, HOST_HINT } from '@/components/host/host-ui'

export const dynamic = 'force-dynamic'

export default async function HostYourPageRoute() {
  const session = await getCurrentHost()
  if (!session) redirect('/host/login')

  const db = createServerClient()
  let signupUrl = null
  let joinUrl = null
  let signupCount = null
  let signupCopy = null
  try {
    const { data: hostRow, error: hostErr } = await db
      .from('event_hosts')
      .select('id, name, slug, list_headline, list_blurb, list_button_label, list_success_message, hero_image_url, accent_hex, events_headline, events_blurb, anchor_location_id, about_text, photos, testimonials, show_past_events, show_ratings')
      .eq('id', session.host.id)
      .maybeSingle()
    if (hostErr) throw hostErr
    if (hostRow) {
      const slug = await ensureHostSlug(db, hostRow)
      // The signup page lives on the tenant host of the host's ANCHOR
      // location (NULL anchor → the resolver floors to the CRM host).
      // Origin-only, so a misconfigured env var can't poison the link.
      const baseUrl = new URL(await resolveCustomerBaseUrl(db, hostRow.anchor_location_id)).origin
      signupUrl = `${baseUrl}/h/${slug}`
      joinUrl = `${signupUrl}/join`
      // A failed count only hides the signup line (null); the editor stays.
      const { count, error: countErr } = await db
        .from('host_contacts')
        .select('*', { count: 'exact', head: true })
        .eq('host_id', session.host.id)
        .eq('source', 'mailing_list')
      if (countErr) logWarn('host-page', 'signup count failed', { err: countErr })
      signupCount = countErr ? null : (count ?? 0)
      const { photos, testimonials } = hostPageExtras(hostRow)
      signupCopy = {
        list_headline: hostRow.list_headline,
        list_blurb: hostRow.list_blurb,
        list_button_label: hostRow.list_button_label,
        list_success_message: hostRow.list_success_message,
        events_headline: hostRow.events_headline,
        events_blurb: hostRow.events_blurb,
        hero_image_url: hostRow.hero_image_url,
        accent_hex: hostRow.accent_hex,
        // The page extras, re-validated so a bad row never breaks the editor.
        about_text: hostRow.about_text,
        photos,
        testimonials,
        show_past_events: hostRow.show_past_events !== false,
        show_ratings: hostRow.show_ratings !== false,
      }
    }
  } catch (e) {
    logWarn('host-page', 'your page degraded', { err: e })
    signupUrl = null
  }

  return (
    <div>
      <h1 className={HOST_H1}>Your page</h1>
      {signupUrl ? (
        <div className="mt-6">
          <HostYourPage url={signupUrl} joinUrl={joinUrl} signupCount={signupCount} copyValues={signupCopy} />
        </div>
      ) : (
        <p className={`mt-6 ${HOST_HINT}`}>Your page is unavailable right now.</p>
      )}
    </div>
  )
}
