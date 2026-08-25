// /terms — public Terms of Service for the UN1T Dublin website and
// the Repset platform. Linked as the Terms of Service URL on the Meta app
// (WhatsApp Tech Provider) and available from the public site.
//
// Standalone server-rendered markup so it loads without auth. Unlike
// the /privacy pages this is a top-level route, so it must be in the
// public allowlist in THREE places: src/proxy.js publicPaths,
// src/lib/brands.js allowedPaths (un1t-marketing), and
// src/components/AppShell.jsx PUBLIC_PATHS. All three are done.
//
// Honest, general-purpose terms for a small operator. Not a
// substitute for solicitor-reviewed terms; UN1T should have these
// checked under Irish law before relying on them.

export const runtime = 'nodejs'

export const metadata = {
  title: 'Terms of Service · Repset',
  description:
    'The terms on which Champ Fitness Ltd (trading as UN1T Dublin) provides its website, booking pages, member communications, and the Repset platform.',
}

export default function TermsOfService() {
  return (
    <div className="min-h-screen bg-white text-gray-900">
      <div className="mx-auto max-w-3xl px-6 py-12">
        <header className="mb-10">
          <h1 className="text-3xl font-bold tracking-tight">Terms of Service</h1>
          <p className="mt-2 text-sm text-gray-500">Last updated 18 August 2026</p>
        </header>

        <section className="prose prose-gray max-w-none">
          <p>
            These terms govern your use of the websites, booking pages, member
            communications, and the Repset software platform provided by Champ
            Fitness Ltd, trading as UN1T Dublin
            (&ldquo;UN1T&rdquo;, &ldquo;we&rdquo;, &ldquo;us&rdquo;),
            including <strong>un1tdublin.com</strong> and{' '}
            <strong>crm.repset.ie</strong> (together, the
            &ldquo;Service&rdquo;). By using the Service you agree to these
            terms. If you do not agree, please do not use the Service.
          </p>

          <h2 className="text-xl font-semibold mt-8 mb-3">1. Who we are</h2>
          <p>
            Champ Fitness Ltd, trading as UN1T Dublin, is a company
            registered in Ireland. We operate the
            UN1T fitness studios, and we build and operate Repset, the
            software platform used to run them —
            including class bookings, member communications, and related
            business tools. You can contact us at{' '}
            <a className="underline" href="mailto:hello@un1tdublin.com">hello@un1tdublin.com</a>.
          </p>

          <h2 className="text-xl font-semibold mt-8 mb-3">2. The Service</h2>
          <p>
            The Service includes our public website and studio pages, online
            booking and payment pages, messages we send you (by email, SMS, or
            WhatsApp) where you have asked to hear from us or have an active
            relationship with us, and — for staff and authorised business
            customers — the Repset platform used to operate the business. Some
            parts of the Service are only available to signed-in staff or to
            business customers who have entered into a separate agreement with
            us.
          </p>

          <h2 className="text-xl font-semibold mt-8 mb-3">3. Accounts</h2>
          <p>
            If you are given an account to access the platform, you are
            responsible for keeping your login details secure and for activity
            under your account. Tell us promptly if you believe your account
            has been compromised. We may suspend or remove access that is being
            misused or that poses a security risk.
          </p>

          <h2 className="text-xl font-semibold mt-8 mb-3">4. Acceptable use</h2>
          <p>You agree not to:</p>
          <ul className="list-disc pl-6 space-y-1">
            <li>use the Service unlawfully or to break any applicable regulation;</li>
            <li>attempt to gain unauthorised access to the Service, other accounts, or our systems;</li>
            <li>interfere with or disrupt the Service, or introduce malicious code;</li>
            <li>use the Service to send unsolicited messages or spam, or to harass others;</li>
            <li>copy, scrape, or resell the Service or its content without our permission.</li>
          </ul>

          <h2 className="text-xl font-semibold mt-8 mb-3">5. Bookings, memberships, and payments</h2>
          <p>
            Where you book a class, buy a membership, or pay a deposit through
            the Service, that transaction may be handled by a third-party
            provider (for example our membership or payment processor) and may
            be subject to that provider&rsquo;s terms as well as any specific
            terms shown to you at the time of purchase. Prices, schedules, and
            availability can change. Refund and cancellation terms are those
            shown at the point of purchase or set out in your membership
            agreement.
          </p>

          <h2 className="text-xl font-semibold mt-8 mb-3">6. Messages you receive</h2>
          <p>
            We send transactional messages (such as booking confirmations and
            reminders) where you have an active relationship with us, and
            marketing messages only where you have opted in. You can opt out of
            marketing messages at any time using the unsubscribe or
            stop instructions in the message, or by contacting us. How we
            handle your personal data is described in our{' '}
            <a className="underline" href="/privacy">privacy policy</a>.
          </p>

          <h2 className="text-xl font-semibold mt-8 mb-3">7. Third-party services</h2>
          <p>
            The Service relies on third-party providers (for example for
            hosting, email, SMS, WhatsApp messaging, payments, and accounting).
            Your use of features provided through those third parties may also
            be subject to their terms, and we are not responsible for the acts
            or omissions of third parties outside our reasonable control.
          </p>

          <h2 className="text-xl font-semibold mt-8 mb-3">8. Intellectual property</h2>
          <p>
            The Service and its content (excluding your own content and
            third-party content) are owned by us or our licensors. We grant you
            a limited, non-exclusive, non-transferable right to use the Service
            for its intended purpose. You may not use our name, logo, or
            branding without our prior written permission.
          </p>

          <h2 className="text-xl font-semibold mt-8 mb-3">9. Availability and disclaimers</h2>
          <p>
            We aim to keep the Service available and accurate, but we provide it
            &ldquo;as is&rdquo; and do not guarantee that it will always be
            uninterrupted, error-free, or fit for a particular purpose. Fitness
            activities carry inherent risks; nothing in the Service is medical
            advice, and you should take appropriate advice before starting any
            exercise programme.
          </p>

          <h2 className="text-xl font-semibold mt-8 mb-3">10. Liability</h2>
          <p>
            Nothing in these terms limits liability that cannot be limited by
            law (including for death or personal injury caused by negligence, or
            for fraud). Subject to that, we are not liable for indirect or
            consequential loss, and our total liability arising out of the
            Service is limited to the amount you paid us, if any, for the
            relevant service in the twelve months before the claim.
          </p>

          <h2 className="text-xl font-semibold mt-8 mb-3">11. Changes to these terms</h2>
          <p>
            We may update these terms from time to time. If we make a material
            change we will update the &ldquo;Last updated&rdquo; date above and,
            where appropriate, tell you directly. Continued use of the Service
            after a change means you accept the updated terms.
          </p>

          <h2 className="text-xl font-semibold mt-8 mb-3">12. Governing law</h2>
          <p>
            These terms are governed by the laws of Ireland, and the courts of
            Ireland have exclusive jurisdiction over any dispute arising from
            them.
          </p>

          <h2 className="text-xl font-semibold mt-8 mb-3">13. Contact</h2>
          <p>
            <strong>Champ Fitness Ltd</strong> (trading as UN1T Dublin)
            <br />
            First Floor Unit, Stillorgan Village Centre,
            Lower Kilmacud Road, Dublin, A94 AC67
            <br />
            Email: <a className="underline" href="mailto:hello@un1tdublin.com">hello@un1tdublin.com</a>
            <br />
            For privacy questions: <a className="underline" href="mailto:privacy@un1tdublin.com">privacy@un1tdublin.com</a>
          </p>
        </section>
      </div>
    </div>
  )
}
