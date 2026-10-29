// UN1TWELCOME.1 — the un1t.online app download links and the email HTML built
// from them. Pure (no DB, no server imports) so a browser file can import it.
//
// Where they live: locations.settings.un1t_online.app_links =
//   { ios_url, android_url, heading, body }
// (the Settings, Integrations, un1t.online tab writes them; master only). A
// link counts only when it is a string starting https://; blank copy falls
// back to DEFAULT_APP_SECTION_COPY. Every render helper returns email-safe
// inline-styled HTML and escapes what it interpolates.

import { escapeHtml } from './html-escape'

export const DEFAULT_APP_SECTION_COPY = {
  heading: 'Book your classes in the un1t.online app',
  body: "Download the app and log in with this email address once you've set your password. That's where you'll book and manage every class.",
}

const httpsUrl = (v) => (typeof v === 'string' && v.trim().startsWith('https://') ? v.trim() : null)
const text = (v) => (typeof v === 'string' ? v.trim() : '')

/**
 * @param {any} settings the WHOLE locations.settings object
 * @returns {{ iosUrl: string|null, androidUrl: string|null, heading: string, body: string }}
 */
export function appLinksFrom(settings) {
  const block = settings && typeof settings === 'object' && settings.un1t_online && typeof settings.un1t_online === 'object'
    ? settings.un1t_online
    : {}
  const links = block.app_links && typeof block.app_links === 'object' ? block.app_links : {}
  return {
    iosUrl: httpsUrl(links.ios_url),
    androidUrl: httpsUrl(links.android_url),
    heading: text(links.heading) || DEFAULT_APP_SECTION_COPY.heading,
    body: text(links.body) || DEFAULT_APP_SECTION_COPY.body,
  }
}

const BUTTON_FONT = "'NEXA Bold', 'Arial Black', sans-serif"

function storeButton(href, label) {
  return `<td class="btn" align="center" style="background-color:#000000; padding:15px 12px;">
<a href="${escapeHtml(href)}" style="font-family:${BUTTON_FONT}; font-size:13px; color:#ffffff; text-decoration:none; text-transform:uppercase; letter-spacing:2px; display:inline-block;">${escapeHtml(label)}</a>
</td>`
}

/** The two-button table; a missing link's cell is left out, '' when both are. */
export function renderAppDownloadLinks({ iosUrl, androidUrl } = {}) {
  const cells = []
  if (iosUrl) cells.push(storeButton(iosUrl, 'Download on the App Store'))
  if (androidUrl) cells.push(storeButton(androidUrl, 'Get it on Google Play'))
  if (cells.length === 0) return ''
  const gap = '<td class="gap" width="12" style="font-size:0; line-height:0;">&nbsp;</td>'
  return `<table role="presentation" class="store" width="100%" border="0" cellpadding="0" cellspacing="0">
<tr>
${cells.join(`\n${gap}\n`)}
</tr>
</table>`
}

/** The studio logo image, or the UN1T text wordmark when there is no logo. */
export function renderStudioLogo({ logoUrl, name } = {}) {
  if (logoUrl) {
    return `<img src="${escapeHtml(logoUrl)}" width="200" alt="${escapeHtml(name ?? '')}" style="display:block; width:200px; max-width:60%; height:auto; border:0;">`
  }
  return `<span style="font-family:${BUTTON_FONT}; font-size:32px; color:#000000; letter-spacing:4px; text-transform:uppercase;">UN1T</span>`
}

/** Heading, body and buttons; '' when there is no link to show. */
export function renderAppSection(appLinks) {
  const buttons = renderAppDownloadLinks(appLinks || {})
  if (!buttons) return ''
  const heading = text(appLinks.heading) || DEFAULT_APP_SECTION_COPY.heading
  const body = text(appLinks.body) || DEFAULT_APP_SECTION_COPY.body
  return `<p style="margin:0 0 8px 0; font-family:'Helvetica Neue', Arial, sans-serif; font-size:16px; line-height:1.6; color:#1a1a1a;"><strong>${escapeHtml(heading)}</strong></p>
<p style="margin:0 0 16px 0; font-family:'Helvetica Neue', Arial, sans-serif; font-size:16px; line-height:1.6; color:#1a1a1a;">${escapeHtml(body)}</p>
${buttons}`
}
