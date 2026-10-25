// UN1TREAD.3 — the source → adapter table, in its own module so that
// state-for-page.js (which index.js imports) can ask "does this source read
// member counts?" without an import cycle. index.js re-exports it.
import { glofoxReads } from './glofox'
import { noneReads } from './none'
import { un1tOnlineReads } from './un1t-online'

export const READS_BY_SOURCE = Object.freeze({ glofox: glofoxReads, none: noneReads, un1t_online: un1tOnlineReads })
