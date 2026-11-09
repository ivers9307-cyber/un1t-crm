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
  // A yes does not clear the flag: the page may stay (a new tab, the tab the
  // host is already on, a failed action). The form clears it on save and on
  // unmount, and an action that really leaves clears it on success.
  return window.confirm('You have unsaved changes. Leave without saving?')
}
