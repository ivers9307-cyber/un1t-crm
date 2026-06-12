// BRIEFING.1 — renders the daily morning-briefing email from the
// "Needs attention" feed rows (shared/today-feed.js shapes). Pure:
// (rows, opts) → { subject, html } — no IO, mirroring the
// churn-radar-digest.js convention (the cron fetches + sends).
//
// Recipients see the same triage list the Today page shows, minus the
// approvals row (the approvals registry is per-user scoped; the
// location-level briefing has no viewer to scope by — see
// fetchLocationTodayFeed in today-feed-data.js).

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * @param {Array}  rows  assembleTodayFeed() output
 * @param {object} opts  { locationName, dateLabel, appUrl }
 * @returns {{ subject: string, html: string }}
 */
export function buildMorningBriefingEmail(rows, opts = {}) {
  const { locationName = '', dateLabel = '', appUrl = '' } = opts
  const list = Array.isArray(rows) ? rows : []

  // Subject: location + the first two rows as "N label" fragments,
  // lowercased so it reads as a sentence ("2 open issues, 4 high-risk
  // members"). All-clear gets an explicit calm subject.
  const fragments = list.slice(0, 2).map((r) => `${r.count} ${String(r.label).toLowerCase()}`)
  const subject = list.length === 0
    ? `Morning briefing — ${locationName}: all clear`
    : `Morning briefing — ${locationName}: ${fragments.join(', ')}${list.length > 2 ? ', …' : ''}`

  const rowHtml = list.map((r) => {
    const items = (r.items || [])
      .map((it) => esc(it.sublabel ? `${it.label} (${it.sublabel})` : it.label))
      .join(' · ')
    const sub = [r.detail ? esc(r.detail) : null, items || null].filter(Boolean).join(' — ')
    return `
      <tr>
        <td style="padding:10px 0;border-bottom:1px solid #e5e7eb;">
          <a href="${appUrl}${r.href}" style="color:#111827;text-decoration:none;font-weight:600;">
            ${esc(r.label)}
            <span style="display:inline-block;min-width:20px;padding:1px 7px;margin-left:6px;border-radius:999px;background:#111827;color:#ffffff;font-size:12px;font-weight:600;">${Number(r.count) || 0}</span>
          </a>
          ${sub ? `<div style="margin-top:3px;color:#64748b;font-size:13px;">${sub}</div>` : ''}
          <div style="margin-top:3px;"><a href="${appUrl}${r.href}" style="color:#4f46e5;font-size:13px;">Open &rarr;</a></div>
        </td>
      </tr>`
  }).join('')

  const body = list.length === 0
    ? `<p style="color:#64748b;font-size:14px;">Nothing needs attention this morning — all clear. Enjoy the quiet.</p>`
    : `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rowHtml}</table>`

  const html = `
  <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;">
    <h2 style="margin:0 0 2px;font-size:18px;color:#111827;">Morning briefing — ${esc(locationName)}</h2>
    <p style="margin:0 0 16px;color:#64748b;font-size:13px;">${esc(dateLabel)}</p>
    ${body}
    <p style="margin:18px 0 0;color:#94a3b8;font-size:12px;">
      The live view is always on <a href="${appUrl}/dashboard/today" style="color:#4f46e5;">your Today dashboard</a>.
      This briefing goes to the same recipients as the Monday radar digest.
    </p>
  </div>`

  return { subject, html }
}
