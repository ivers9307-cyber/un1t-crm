// Pure paging for the rolling TV leaderboard. pageIndex wraps; size is rows/page.
export function pageSlice(items, pageIndex, size) {
  const list = items || []
  const pages = Math.max(1, Math.ceil(list.length / size))
  const p = ((pageIndex % pages) + pages) % pages
  return { rows: list.slice(p * size, p * size + size), page: p, pages }
}
