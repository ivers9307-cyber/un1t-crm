// Client-side conversation search over the already-loaded queue.
// The caller builds the haystack from what the row actually shows
// (display name + last-message preview), so this stays a pure string match.
export function matchesSearch(haystack, query) {
  const q = (query || '').trim().toLowerCase();
  if (!q) return true;
  return String(haystack || '').toLowerCase().includes(q);
}
