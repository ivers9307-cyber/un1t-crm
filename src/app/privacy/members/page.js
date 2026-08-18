// /privacy/members — public, member- and visitor-facing privacy policy.
//
// Distinct from /privacy, which is the internal CRM + Repset iOS
// app policy (App Store review requirement, controller "UN1T Dublin
// Ltd"). THIS page is the member/website policy for the public
// marketing site (un1tdublin.com → /welcome): Glofox membership,
// lead capture & advertising, cookies/analytics, and CCTV. The
// /welcome SiteFooter "Privacy" link points here.
//
// Controller named here is Champ Fitness Ltd (trading as UN1T
// Dublin), per operator instruction 2026-06-19. RECONCILED 2026-07-19
// (SAAS4-W0.2): Richard settled Champ Fitness Ltd as the single legal
// entity across ALL legal pages (/privacy, /privacy/authority-requests,
// /terms updated to match). tests/legal-entity-consistency.test.js
// pins the consistency.
//
// Server-rendered markup so it loads without auth.
//
// SAAS4-C2 — tenant-aware: when the request Host resolves to a tenant
// org (tenant_domains, SAAS-8) whose legal identity is configured
// (org_settings legal fields, mig 425), this path renders the
// TENANT's templated notice — they are the controller of their
// members' data; Champ Fitness Ltd appears only as the platform
// processor. Every other case (platform hostnames, unconfigured
// tenants, resolution errors) renders the Champ Fitness copy below,
// byte-identical to pre-C2. Dynamic because the output depends on the
// Host header.

import { headers } from 'next/headers'
import { getTenantPrivacyEntity } from '@/lib/tenant-privacy'
import TenantPrivacyNotice from '@/components/TenantPrivacyNotice'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const metadata = {
  title: 'Privacy policy',
  description:
    'How this studio collects, uses, and protects the personal data of members, leads, and website visitors under GDPR and Irish data protection law.',
}

export default async function MemberPrivacyPolicy() {
  const host = (await headers()).get('host') || ''
  const entity = await getTenantPrivacyEntity(host.split(':')[0].toLowerCase())
  if (entity) return <TenantPrivacyNotice entity={entity} />
  return <PlatformMemberPrivacyPolicy />
}

function PlatformMemberPrivacyPolicy() {
  return (
    <div className="min-h-screen bg-white text-gray-900">
      <div className="mx-auto max-w-3xl px-6 py-12">
        <header className="mb-10">
          <h1 className="text-3xl font-bold tracking-tight">Privacy policy</h1>
          <p className="mt-2 text-sm text-gray-500">Last updated 18 August 2026</p>
        </header>

        <section className="prose prose-gray max-w-none">
          <p>
            This policy explains how <strong>Champ Fitness Ltd</strong>, trading
            as <strong>UN1T Dublin</strong> (&ldquo;we&rdquo;, &ldquo;us&rdquo;,
            &ldquo;our&rdquo;), collects, uses, stores and protects your personal
            data when you visit our website at <strong>un1tdublin.com</strong>,
            enquire with us, or train at one of our studios. We are the data
            controller for this information under the EU General Data Protection
            Regulation (GDPR) and the Irish Data Protection Act 2018.
          </p>
          <p>
            This is our member- and visitor-facing policy. If you are a UN1T
            staff member or contractor using our internal operations tools, a
            separate <a className="underline" href="/privacy">staff privacy policy</a> applies.
          </p>

          <h2 className="text-xl font-semibold mt-8 mb-3">1. Who we are</h2>
          <p>
            Champ Fitness Ltd operates UN1T Dublin fitness studios and related
            online services in Dublin, Ireland. Our registered address is:
          </p>
          <p>
            First Floor Unit, Stillorgan Village Centre, Lower Kilmacud Road,
            Dublin, A94 AC67, Ireland.
          </p>
          <p>
            For any privacy question, contact us at{' '}
            <a className="underline" href="mailto:privacy@un1tdublin.com">privacy@un1tdublin.com</a>.
          </p>

          <h2 className="text-xl font-semibold mt-8 mb-3">2. Data we collect</h2>
          <ul className="list-disc pl-6 space-y-1">
            <li><strong>Identity &amp; contact:</strong> name, email, phone number, postal address, date of birth, emergency contact.</li>
            <li><strong>Membership:</strong> membership type, class bookings, attendance history, and account preferences.</li>
            <li><strong>Payment:</strong> billing details and transaction records. Card details are handled by our payment provider and are not stored by us.</li>
            <li><strong>Health &amp; fitness:</strong> information you choose to share, such as PAR-Q answers, injuries, or goals (special category data).</li>
            <li><strong>Member app &amp; connected fitness data:</strong> if you use our member app and connect Apple Health, a heart-rate monitor, or Strava, the workout and heart-rate data you authorise (including per-session effort, heart-rate zones and points), any InBody body-composition scan results, and your weight where you provide it.</li>
            <li><strong>Marketing &amp; leads:</strong> enquiry details and messages you send via web forms, WhatsApp, or social media, plus your marketing preferences.</li>
            <li><strong>Technical:</strong> IP address, device and browser type, cookies, and pages visited.</li>
            <li><strong>CCTV:</strong> images captured by cameras in public areas of our premises.</li>
          </ul>
          <p>
            We only collect health information where you provide it and where it
            is needed to keep you safe during training. You may decline to share
            it, though this can limit our ability to tailor sessions safely.
          </p>
          <p>
            <strong>Health and fitness data in the member app.</strong> If you
            use our member app, you can choose to connect health and fitness
            data sources &mdash; none of this happens unless you take that
            step yourself. Depending on what you connect, we collect:
            heart-rate readings from a chest strap you wear during class
            (captured by the studio&rsquo;s receiver while the class runs);
            workouts and heart-rate data read from Apple Health, only after
            you grant permission on your device (the app can also write a
            summary of a completed session back to Apple Health); InBody
            body-composition scan results taken at the studio and shared
            into your coaching; your weight, entered during profile setup or
            read from Apple Health, which we use to estimate calories; and
            activities imported from Strava, if you connect your own Strava
            account.
          </p>
          <p>
            We use this data only to provide the app to you &mdash; to score
            your sessions (effort points and heart-rate zones), show your
            progress and streaks, count you into gym challenges, and support
            any coaching you have asked for. It is <strong>never used for
            advertising, never sold, and never used to track you</strong>{' '}
            across other apps or websites, and it is not read on the staff
            side of the app. You see your own data; your studio&rsquo;s
            coaches can see summary-level statistics (such as a
            session&rsquo;s effort score) in order to coach you, and raw
            heart-rate data is never shown to other members. It is stored in
            our secure systems (hosted in the EU). You can disconnect Apple
            Health or Strava at any time in the app&rsquo;s settings, and
            you can ask us to delete this data with the rest of your data
            &mdash; see our{' '}
            <a className="underline" href="/account-deletion">account and
            data deletion page</a>{' '}
            or use the contact details below.
          </p>

          <h2 className="text-xl font-semibold mt-8 mb-3">3. How we use your data</h2>
          <ul className="list-disc pl-6 space-y-1">
            <li>To set up and manage your membership and class bookings.</li>
            <li>To take payment and manage billing.</li>
            <li>To respond to enquiries and provide support.</li>
            <li>To keep you safe during training and respond to emergencies.</li>
            <li>To send you marketing about classes, offers and events, where permitted.</li>
            <li>To improve our website, services and member experience.</li>
            <li>To protect the security of our premises, members and staff.</li>
            <li>To meet our legal and regulatory obligations.</li>
          </ul>

          <h2 className="text-xl font-semibold mt-8 mb-3">4. Legal bases for processing</h2>
          <ul className="list-disc pl-6 space-y-1">
            <li><strong>Contract:</strong> managing your membership, bookings, and payments.</li>
            <li><strong>Consent:</strong> marketing communications, non-essential cookies, and any health information you share.</li>
            <li><strong>Legitimate interests:</strong> running our studios safely and efficiently, and protecting our premises through CCTV.</li>
            <li><strong>Legal obligation:</strong> accounting, tax, and other records we are required to keep.</li>
          </ul>

          <h2 className="text-xl font-semibold mt-8 mb-3">5. Membership &amp; Glofox</h2>
          <p>
            We use <strong>Glofox</strong> as our membership management platform.
            When you join, book classes, or manage your account, your data is
            processed and stored within Glofox to deliver these services,
            including your contact details, membership status, booking and
            attendance records, and billing information. Glofox acts as a data
            processor on our behalf and is contractually required to protect your
            data and use it only as we instruct. Payment card details are handled
            by PCI-compliant payment processors and are not stored directly by us.
          </p>

          <h2 className="text-xl font-semibold mt-8 mb-3">6. Marketing &amp; leads</h2>
          <p>
            When you submit an enquiry, claim a trial, or contact us through our
            website, social media, or WhatsApp, we use the details you provide to
            follow up with you.
          </p>
          <p>
            We may send you marketing emails and messages about trials, classes,
            offers and events. You can opt out at any time using the unsubscribe
            link in any email, by replying STOP to messages, or by emailing{' '}
            <a className="underline" href="mailto:privacy@un1tdublin.com">privacy@un1tdublin.com</a>.
          </p>
          <p>
            With your consent, we use advertising and conversion tools from{' '}
            <strong>Meta (Facebook/Instagram)</strong>, <strong>Google Ads</strong>{' '}
            and <strong>TikTok</strong> to measure campaign performance and show
            you relevant ads. These tools may set cookies and share limited data
            with the relevant platforms. You can manage them through our cookie
            banner and your browser or ad settings.
          </p>

          <h2 className="text-xl font-semibold mt-8 mb-3">7. Website, cookies &amp; analytics</h2>
          <p>Our website uses cookies and similar technologies that fall into three groups:</p>
          <ul className="list-disc pl-6 space-y-1">
            <li><strong>Essential</strong> — required for the site to work; these cannot be switched off.</li>
            <li><strong>Analytics</strong> — for example Google Analytics, to understand traffic and usage.</li>
            <li><strong>Marketing</strong> — for example Meta, Google and TikTok pixels, used for advertising.</li>
          </ul>
          <p>
            Non-essential cookies are only set with your consent, which you give
            through our cookie banner. You can change or withdraw consent at any
            time through the banner settings or your browser controls.
          </p>

          <h2 className="text-xl font-semibold mt-8 mb-3">8. CCTV &amp; in-gym data</h2>
          <p>
            For the safety and security of our members and staff and to protect
            our property, CCTV cameras operate in public areas of our premises.
            Signage is displayed where CCTV is in use. Cameras are not installed
            in changing areas or toilets. Footage is retained for{' '}
            <strong>60 days</strong> unless it is needed to investigate an
            incident, and is accessed only by authorised personnel or shared with
            An Garda S&iacute;och&aacute;na or other authorities where required by
            law.
          </p>

          <h2 className="text-xl font-semibold mt-8 mb-3">9. Who we share it with</h2>
          <p>
            We do not sell your personal data. We share it only with trusted
            service providers who help us run our business, including Glofox
            (membership management), our payment processors, email and messaging
            platforms, Meta, Google and TikTok (advertising and analytics), our
            telephone provider, and our IT, hosting and automation providers. We
            may also disclose data where required by law, to enforce our terms,
            or to protect the rights, safety or property of UN1T Dublin, our
            members or others.
          </p>
          <p className="mt-3">
            Your name and phone number are held in the contact directory of our
            telephone system (Zoom) so that when you call a studio, our team can
            see who is calling rather than an unrecognised number. This directory
            is visible to staff who use our phone system. It is not used for
            marketing, and you can ask us to remove your details from it at any
            time using the contact details in section 16.
          </p>

          <h2 className="text-xl font-semibold mt-8 mb-3">10. How long we keep it</h2>
          <ul className="list-disc pl-6 space-y-1">
            <li>Membership and booking records: for the duration of your membership plus up to seven years for accounting and legal purposes.</li>
            <li>Marketing leads (no membership): until you opt out or after a period of inactivity.</li>
            <li>CCTV footage: 60 days, unless needed for an incident.</li>
            <li>Website analytics: as set by the relevant tool&rsquo;s retention settings.</li>
          </ul>

          <h2 className="text-xl font-semibold mt-8 mb-3">11. Your rights</h2>
          <p>Under GDPR you have the right to:</p>
          <ul className="list-disc pl-6 space-y-1">
            <li>access the personal data we hold about you</li>
            <li>have inaccurate data corrected</li>
            <li>request erasure of your data, subject to legal retention obligations</li>
            <li>restrict or object to certain processing</li>
            <li>receive a portable copy of data you have provided to us</li>
            <li>withdraw consent at any time where processing is based on consent</li>
          </ul>
          <p>
            To exercise any of these rights, email{' '}
            <a className="underline" href="mailto:privacy@un1tdublin.com">privacy@un1tdublin.com</a>.
            We will respond within one month and may need to verify your identity
            first.
          </p>

          <h2 className="text-xl font-semibold mt-8 mb-3">12. Security</h2>
          <p>
            We use appropriate technical and organisational measures to protect
            your data against unauthorised access, loss or misuse, including
            access controls, encryption in transit where appropriate, and trusted,
            security-vetted providers. No system is completely secure, but we take
            ongoing steps to safeguard your information.
          </p>

          <h2 className="text-xl font-semibold mt-8 mb-3">13. International transfers</h2>
          <p>
            Some of our providers may process data outside the European Economic
            Area. Where this happens, we rely on appropriate safeguards such as
            European Commission adequacy decisions or Standard Contractual Clauses.
          </p>

          <h2 className="text-xl font-semibold mt-8 mb-3">14. Children</h2>
          <p>
            Our services are intended for adults. Where we offer services to
            anyone under 18, we require parental or guardian consent and collect
            only the data necessary to provide those services safely.
          </p>

          <h2 className="text-xl font-semibold mt-8 mb-3">15. Changes to this policy</h2>
          <p>
            We may update this policy from time to time. The &ldquo;Last
            updated&rdquo; date at the top shows the latest version. Significant
            changes will be communicated where appropriate.
          </p>

          <h2 className="text-xl font-semibold mt-8 mb-3">16. Contact &amp; complaints</h2>
          <p>For privacy questions or to exercise your rights:</p>
          <p>
            <strong>Champ Fitness Ltd</strong> (trading as UN1T Dublin)<br />
            First Floor Unit, Stillorgan Village Centre, Lower Kilmacud Road,
            Dublin, A94 AC67<br />
            Email:{' '}
            <a className="underline" href="mailto:privacy@un1tdublin.com">privacy@un1tdublin.com</a>
          </p>
          <p>
            If you are not satisfied with our response, you have the right to
            lodge a complaint with the Irish Data Protection Commission:
            Data Protection Commission, 21 Fitzwilliam Square South, Dublin 2,
            D02 RD28 —{' '}
            <a className="underline" href="https://www.dataprotection.ie">dataprotection.ie</a>.
          </p>
        </section>
      </div>
    </div>
  )
}
