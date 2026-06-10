// MOB-UI.2 — shared mobile UI primitives.
//   import { Button, Card, Screen, Field } from '../../components/ui'
// New screens compose these instead of hand-rolling Pressables, headers,
// loading/empty states, and (critically) accessibility props. Pure
// styling logic + tests live in ../../lib/ui-styles.js.
export { default as Button } from './Button.jsx'
export { default as Card } from './Card.jsx'
export { default as Screen } from './Screen.jsx'
export { default as Field } from './Field.jsx'
export { default as Modal } from './Modal.jsx'
export { default as DataTable } from './DataTable.jsx'
export * from '../../lib/ui-styles.js'
