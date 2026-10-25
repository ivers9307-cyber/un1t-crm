// Escape a value for interpolation into HTML text or a quoted attribute.
// Same body as the private helper in notify.js; kept separate so other
// modules can share it without touching that file.
export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}
