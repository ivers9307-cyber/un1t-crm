// Unsaved-changes guard for the host portal (HOSTPORTAL.2). A form marks
// itself unsaved with setUnsaved(true); portal links ask confirmLeave() before
// navigating. State is module-level (one tab, one page at a time) and safe to
// import on the server: nothing touches window until confirmLeave() runs.

let unsaved = false

export function setUnsaved(flag) {
  unsaved = Boolean(flag)
}

export function hasUnsaved() {
  return unsaved
}

export function confirmLeave() {
  if (!unsaved) return true
  if (typeof window === 'undefined') return true
  const leave = window.confirm('You have unsaved changes. Leave without saving?')
  if (leave) unsaved = false
  return leave
}
