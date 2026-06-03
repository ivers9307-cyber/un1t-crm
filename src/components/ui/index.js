// UI-FOUND.2 — components/ui barrel.
//
// Shared primitive layer. Import from here:
//   import { Button, Modal, Card, Field, Table, EmptyState, Loading } from '@/components/ui'
//
// Convention (see CLAUDE.md → Coding conventions): new components
// compose these primitives rather than re-implementing buttons,
// modals, cards, tables, labelled fields, empty states, or spinners.
// The pure styling/logic helpers live in ./styles.js and are
// unit-tested in ./styles.test.js.
export { default as Button } from './Button.jsx'
export { default as Modal } from './Modal.jsx'
export { default as Card } from './Card.jsx'
export { default as Field } from './Field.jsx'
export { default as Table } from './Table.jsx'
export { default as EmptyState } from './EmptyState.jsx'
export { default as Loading } from './Loading.jsx'
export * from './styles.js'
