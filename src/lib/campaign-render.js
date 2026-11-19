// renderCampaignEmail — the one way a campaign email is turned into what a
// person receives (CAMPAIGNRENDER.1).
//
// The real send (campaign-sender.js), the agent's test email
// (campaign-test-email.js) and the editor's "send test" route each used to
// do these steps themselves, and they drifted: the editor's test had no
// unsubscribe footer, no view-in-browser link and no preheader, so it did
// not show what recipients get. The steps, in order:
//   1. merge tags into the body (applyMergeTags, with the caller's extras);
//   2. the unsubscribe footer, on the broadcast stream when there is a link;
//   3. the plain-text part, from the body BEFORE the inbox chrome below;
//   4. the view-in-browser link, on the broadcast stream when there is a URL;
//   5. the hidden preheader (preview text, merge tags applied), first in the body.
// The subject gets the same extras as the body.

import { applyMergeTags, appendUnsubscribeFooter } from '@/lib/postmark'
import { prependViewInBrowserLink } from '@/lib/campaign-web-view'
import { injectPreheader, htmlToPlainText } from '@/lib/email-content'

/**
 * @param {object} args
 * @param {{ html_content?: string|null, preview_text?: string|null }} args.campaign
 * @param {string} args.subject  the subject before merge tags (an A/B variant, or the campaign's)
 * @param {object} args.contact  the person, as applyMergeTags reads one
 * @param {{ location_name?: string, company_name?: string, unsubscribe_url?: string|null, preference_url?: string|null, zone?: string }} args.extras
 * @param {boolean} args.broadcast  the marketing stream (footer and view-in-browser link)
 * @param {string|null} [args.viewUrl]  the hosted copy's URL
 * @param {object|null} [args.emailCopy]  the studio's email wording (fetchLocationEmailCopy)
 * @returns {{ html: string, text: string, subject: string }}
 */
export function renderCampaignEmail({ campaign, subject, contact, extras, broadcast, viewUrl = null, emailCopy = null }) {
  const merged = applyMergeTags(campaign.html_content, contact, extras)
  const unsubscribeUrl = extras.unsubscribe_url || null
  const withFooter = broadcast && unsubscribeUrl ? appendUnsubscribeFooter(merged, unsubscribeUrl) : merged
  const text = htmlToPlainText(withFooter)
  const withWebView = broadcast && viewUrl ? prependViewInBrowserLink(withFooter, viewUrl, emailCopy) : withFooter
  const previewText = campaign.preview_text
    ? applyMergeTags(campaign.preview_text, contact, {
      location_name: extras.location_name || '', company_name: extras.company_name || '', zone: extras.zone,
    })
    : null
  const html = previewText ? injectPreheader(withWebView, previewText) : withWebView
  return { html, text, subject: applyMergeTags(subject || '', contact, extras) }
}
