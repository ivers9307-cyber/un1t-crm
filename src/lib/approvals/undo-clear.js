// APPROVALSQ.5 — how long after a quiet clear its author may undo it. Lives
// here, not in the route file: a Next.js route file may export only handlers
// and route config, and any other export breaks `next build`. Read by the
// route (the server's judgement) and by the web cards (when to hide Undo).
export const UNDO_CLEAR_WINDOW_MS = 120_000
