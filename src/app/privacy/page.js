// /privacy — public privacy policy page.
//
// Required by Apple App Store Connect for any iOS submission, and
// linked from the public-facing parts of the CRM (race signup, deposit
// payment) for GDPR compliance. Server-rendered static markup so it
// loads without auth and shows up cleanly to App Review.
//
// Content reflects the actual data flows of the CRM and the Repset iOS
// app: Supabase auth + Postgres, Postmark for email, Twilio for SMS,
// Sensibo for AC control, Apple Push Notification Service via Expo,
// EAS Update for over-the-air JS updates. Don't add anything here that
// the system doesn't actually do — this is the controller's public
// commitment under GDPR.
//
// Section 4 (health and fitness data) exists because the one-app Repset
// release declares Health & Fitness collection in its App Store privacy
// labels (mobile/docs/store-release-one-app.md §3) and App Review
// cross-checks this policy against those labels. Its scope must stay in
// lock-step with the labels: HR (straps in class + HealthKit), workouts
// read from HealthKit, InBody body composition, weight, Strava —
// linked to identity, never tracking, app functionality only.

export const runtime = 'nodejs'

export const metadata = {
  title: 'Privacy policy · UN1T Dublin',
  description:
    'How Champ Fitness Ltd (trading as UN1T Dublin) collects, uses, and protects personal data in the Repset web application and the Repset iOS app.',
}

export default function PrivacyPolicy() {
  return (
    <div className="min-h-screen bg-white text-gray-900">
      <div className="mx-auto max-w-3xl px-6 py-12">
        <header className="mb-10">
          <h1 className="text-3xl font-bold tracking-tight">Privacy policy</h1>
          <p className="mt-2 text-sm text-gray-500">
            Last updated 18 August 2026
          </p>
        </header>

        <section className="prose prose-gray max-w-none">
          <p>
            This policy explains how Champ Fitness Ltd, trading as UN1T
            Dublin (&ldquo;we&rdquo;,
            &ldquo;us&rdquo;) handles personal data when you use the Repset
            web application at <strong>crm.repset.ie</strong> and the
            <strong> Repset</strong> iOS application (formerly &ldquo;CF
            Studio&rdquo;) (collectively, the
            &ldquo;Service&rdquo;). We are the data controller for the
            Service under the EU General Data Protection Regulation and
            the Irish Data Protection Act 2018.
          </p>

          <h2 className="text-xl font-semibold mt-8 mb-3">1. Who this applies to</h2>
          <p>
            The Service is an internal operations tool used by UN1T Dublin
            staff and authorised contractors. It is not a consumer-facing
            product. If you are not a UN1T staff member, contractor, or a
            person whose contact details have been entered into our CRM by a
            staff member (for example because you booked a class, attended an
            event, or contacted us), this policy is unlikely to apply to you.
          </p>

          <h2 className="text-xl font-semibold mt-8 mb-3">2. What data we process</h2>
          <p>
            For staff and contractors who sign in to the Service, we process:
          </p>
          <ul className="list-disc pl-6 space-y-1">
            <li>name, email address, and (for contractors) employment type</li>
            <li>role assignments, location memberships, and feature permissions</li>
            <li>shift schedules, time-off requests, swap requests, and clock-in adjustments</li>
            <li>uploaded invoice PDFs and the metadata of those invoices</li>
            <li>device push notification tokens once you grant permission</li>
            <li>audit logs of significant actions (sign-ins, role changes, data exports, master &ldquo;view as user&rdquo; sessions)</li>
          </ul>
          <p className="mt-4">For members of the public whose details have been entered into the CRM, we may process:</p>
          <ul className="list-disc pl-6 space-y-1">
            <li>name, email, phone number, and any tags or notes a staff member has added</li>
            <li>booking, event, race, and class history</li>
            <li>WhatsApp, SMS, and email message history with UN1T</li>
            <li>marketing preferences and subscription/unsubscribe state</li>
            <li>payment records (for deposits or race entries) — never card numbers themselves</li>
          </ul>

          <h2 className="text-xl font-semibold mt-8 mb-3">3. What we do NOT process</h2>
          <ul className="list-disc pl-6 space-y-1">
            <li>full credit or debit card numbers — payments are handled by Revolut Business; we only see the last four digits and a token</li>
            <li>health, fitness, or biometric data — except what a member voluntarily tells a coach (kept only as plain notes) and, for members who opt in to the member side of the Repset app, the health and fitness data described in section 4</li>
            <li>device contacts, photos other than ones you explicitly attach to invoices, location/GPS coordinates, microphone or camera audio</li>
            <li>advertising identifiers — the iOS app does not use IDFA or any cross-app tracking</li>
          </ul>

          <h2 className="text-xl font-semibold mt-8 mb-3">4. Health and fitness data (member app)</h2>
          <p>
            Members who use the member side of the Repset app can choose to
            share health and fitness data with us. Nothing in this section
            happens unless the member takes that step themselves. Depending
            on what a member connects, we process:
          </p>
          <ul className="list-disc pl-6 space-y-1">
            <li><strong>heart-rate readings from a chest strap</strong> worn during a class, captured by the in-studio receiver while the class runs</li>
            <li><strong>workouts and heart-rate data read from Apple Health</strong> — only after the member grants permission on their own device; the app can also write a summary of a completed session back to Apple Health</li>
            <li><strong>body-composition scan results</strong> from an InBody scan taken at the studio, shared into the member&rsquo;s coaching record</li>
            <li><strong>body weight</strong>, entered during profile setup or read from Apple Health, used to estimate calories for a session</li>
            <li><strong>activities imported from Strava</strong>, where a member connects their own Strava account</li>
          </ul>
          <p className="mt-4">
            We use this data solely to provide the app to the member:
            scoring their training sessions (effort points and heart-rate
            zones), showing their progress trends, counting them into gym
            challenges, and supporting coaching they have asked for. It is{' '}
            <strong>never used for advertising, never sold, and never used
            to track anyone across other apps or websites</strong>, and it
            is not read on the staff side of the app.
          </p>
          <p>
            The member sees their own data. Studio coaches can see
            summary-level statistics (for example a session&rsquo;s effort
            score) in order to coach the member. Raw heart-rate data is
            never shown to other members. Health and fitness data is
            deleted with the rest of a member&rsquo;s data on request — see
            our <a className="underline" href="/account-deletion">account
            and data deletion page</a>.
          </p>

          <h2 className="text-xl font-semibold mt-8 mb-3">5. Why we process it (lawful basis)</h2>
          <ul className="list-disc pl-6 space-y-1">
            <li><strong>Contract.</strong> To provide rosters, payroll, scheduling, and contractor invoicing to staff who have an employment or service agreement with us.</li>
            <li><strong>Legitimate interest.</strong> To run our gym safely and efficiently — e.g. to send a coach the schedule of classes they&rsquo;re assigned to coach.</li>
            <li><strong>Consent.</strong> For marketing emails, SMS, and WhatsApp messages — withdraw at any time using the unsubscribe link in any message — and, as explicit consent under Article 9 GDPR, for the health and fitness data described in section 4, which is collected only when a member connects a data source themselves and can be stopped at any time by disconnecting it.</li>
            <li><strong>Legal obligation.</strong> Tax records, payroll records, and similar are kept for the periods required by Irish revenue and employment law.</li>
          </ul>

          <h2 className="text-xl font-semibold mt-8 mb-3">6. Who we share it with (sub-processors)</h2>
          <p>
            The Service relies on the following sub-processors. Each has a Data Processing Agreement
            in place with us. The maintained register, including regions and safeguards, is published
            at <a className="underline" href="/legal/subprocessors">/legal/subprocessors</a>.
          </p>
          <ul className="list-disc pl-6 space-y-1">
            <li><strong>Supabase</strong> — primary database, file storage, and authentication. Region: EU (Ireland).</li>
            <li><strong>Vercel</strong> — hosts the web application. Region: EU.</li>
            <li><strong>Postmark</strong> — transactional and marketing email delivery.</li>
            <li><strong>Meta Platforms</strong> — WhatsApp Cloud API and Instagram messaging; delivers WhatsApp and Instagram conversations with contacts.</li>
            <li><strong>Twilio</strong> — SMS delivery.</li>
            <li><strong>Glofox</strong> — gym membership and booking platform; member records, bookings, and attendance sync between Glofox and the CRM.</li>
            <li><strong>Revolut Business</strong> — payment processing for deposits and race entries.</li>
            <li><strong>Stripe</strong> — payment processing for event tickets.</li>
            <li><strong>Upstash</strong> — message-queue infrastructure; briefly carries webhook and job payloads between our systems.</li>
            <li><strong>Xero</strong> — accounting; contractor invoices are forwarded to a unique Xero bills-by-email address after approval.</li>
            <li><strong>Sensibo</strong> — controls in-studio AC units; receives a location identifier and the requested set-point.</li>
            <li><strong>Apple Push Notification Service</strong> and <strong>Expo</strong> — deliver push notifications to staff iPhones.</li>
            <li><strong>Anthropic</strong> — provides the AI assistant used by some staff features. Conversations are sent transiently to Anthropic&rsquo;s API and are not used to train models.</li>
            <li><strong>UniFi (Ubiquiti)</strong> — door access at studio sites; we send a door-unlock command and store the result.</li>
          </ul>

          <h2 className="text-xl font-semibold mt-8 mb-3">7. International transfers</h2>
          <p>
            Most processing happens within the EU. Some sub-processors (Postmark, Meta, Twilio, Stripe, Upstash, Anthropic, Apple, Expo) are based in the United States and may process data there. Where this happens we rely on the European Commission&rsquo;s Standard Contractual Clauses or, where applicable, the EU-US Data Privacy Framework.
          </p>

          <h2 className="text-xl font-semibold mt-8 mb-3">8. How long we keep it</h2>
          <ul className="list-disc pl-6 space-y-1">
            <li>Active staff and contractor accounts: while your engagement with us continues, plus the periods required by Irish employment and tax law.</li>
            <li>Contact records (members of the public): until you ask us to delete them or for a maximum of seven years from the last interaction, whichever is earlier.</li>
            <li>Message history (email, SMS, WhatsApp): up to seven years for compliance and dispute resolution.</li>
            <li>Audit logs: six years.</li>
            <li>Payment records: as required by Irish revenue law (currently six years).</li>
            <li>Push notification tokens: removed automatically when a device is wiped, an app is uninstalled, or after 90 days of inactivity.</li>
          </ul>

          <h2 className="text-xl font-semibold mt-8 mb-3">9. Mobile-app specifics</h2>
          <p>
            The Repset iOS app (bundle ID <code>com.un1tdublin.crm</code>) stores its session token and a small impersonation flag (used by master accounts to debug what another staff member sees) inside the iOS Keychain via Apple&rsquo;s SecureStore. It does not write to iCloud, the camera roll, contacts, or any other shared system store. The app uses Expo&rsquo;s over-the-air update channel to ship JavaScript updates between native releases; only the app bundle is downloaded — no personal data is sent during update checks.
          </p>

          <h2 className="text-xl font-semibold mt-8 mb-3">10. Your rights</h2>
          <p>You have the right to:</p>
          <ul className="list-disc pl-6 space-y-1">
            <li>access the personal data we hold about you</li>
            <li>have it corrected if it is inaccurate</li>
            <li>have it erased (subject to legal retention obligations)</li>
            <li>object to processing or restrict it</li>
            <li>receive a portable copy of data you have provided to us</li>
            <li>withdraw consent for marketing at any time</li>
            <li>complain to the Irish Data Protection Commission (<a className="underline" href="https://www.dataprotection.ie">dataprotection.ie</a>)</li>
          </ul>

          <h2 className="text-xl font-semibold mt-8 mb-3">11. Security</h2>
          <p>
            Access is gated by Supabase Row-Level Security policies and per-location permission checks. Staff sign in with email and password; we do not store passwords ourselves — they live inside Supabase&rsquo;s authentication service. Master account actions are logged and reviewable in our internal audit log. Backups are encrypted at rest in the EU.
          </p>

          <h2 className="text-xl font-semibold mt-8 mb-3">12. Government and public-authority requests</h2>
          <p>
            When a public authority (such as a police force, court, regulator, or government body) asks us to disclose personal data, we review the legality of the request, disclose only the minimum necessary, challenge requests we consider unlawful, and document each one. Our full{' '}
            <a className="underline" href="/privacy/authority-requests">Government &amp; public authority data request policy</a>{' '}
            explains this process.
          </p>

          <h2 className="text-xl font-semibold mt-8 mb-3">13. Changes to this policy</h2>
          <p>
            If we change this policy in a way that materially affects how we use your data, we&rsquo;ll update the &ldquo;Last updated&rdquo; date at the top and, where appropriate, notify staff or contacts directly. Older versions are available on request.
          </p>

          <h2 className="text-xl font-semibold mt-8 mb-3">14. Contact</h2>
          <p>
            For privacy questions or to exercise any of the rights above:
          </p>
          <p>
            <strong>Champ Fitness Ltd</strong> (trading as UN1T Dublin)<br />
            First Floor Unit, Stillorgan Village Centre,<br />
            Lower Kilmacud Road, Dublin, A94 AC67<br />
            Email: <a className="underline" href="mailto:privacy@un1tdublin.com">privacy@un1tdublin.com</a>
          </p>
        </section>
      </div>
    </div>
  )
}
