# Responsive Mobile Primitive Library Implementation Plan (Cycle 1, Plan B of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the five responsive mobile UI primitives the dense admin surfaces need — Modal, DataTable, Form/FormField, Tabs, and SplitView — each responsive to phone vs tablet by construction, so later feature plans (Staff & Access, the waves) compose them instead of hand-rolling layout.

**Architecture:** Follows the repo's established split exactly: **pure, vitest-tested className/decision logic** lives in `mobile/lib/ui-styles.js` (extended) and `mobile/lib/form-validation.js` (new); the **thin RN shells** live in `mobile/components/ui/*.jsx` and call that logic. Responsive behavior is keyed off an `isTablet` boolean (the shells get it from the existing `useIsTablet()` hook and pass it to the pure functions), so every layout decision is unit-testable without a React Native renderer. Tokens are the intent-based `un1t-*` Tailwind names. Where web already has a counterpart (`Modal`, `Table`), prop names mirror web for parity.

**Tech Stack:** JavaScript (no TypeScript), React Native + NativeWind (`className`), Zod (Form validation), Vitest (Node env — pure logic only; RN shells aren't rendered in tests, they're verified by `check:mobile-imports` + the final gate). Existing conventions: `mobile/lib/ui-styles.js` (className builders with `Object.freeze` maps + fallback-to-default + `.filter(Boolean).join(' ')`), `mobile/lib/tablet-breakpoint.js` (`TABLET_BREAKPOINT_PT=700`, `MASTER_PANE_WIDTH_PT=360`, `isTabletWidth`), `mobile/components/ui/Field.jsx` (render-prop + accessibility), `mobile/components/ui/index.js` (barrel).

**Plan scope note:** Plan B of cycle 1. Independent of Plan A (the SDK rails) — these primitives don't use the SDK — so this branches off `main`. Plan C (Staff & Access Management) depends on BOTH A and B; it will branch off `main` after A and B merge (or stack on them).

**Branch:** `mobile-parity-primitives` (off `main`). Each task commits; open the PR after Task 6.

**Reference before starting:** read `mobile/lib/ui-styles.js`, `mobile/lib/tablet-breakpoint.js`, `mobile/components/ui/Field.jsx`, `mobile/components/ui/index.js`, and `mobile/components/TabletConstrained.jsx` to match the exact conventions. RN shells must mirror `Field.jsx`'s style (NativeWind `className`, accessibility props, concise).

---

## File structure

| File | Responsibility | Action |
|---|---|---|
| `mobile/lib/ui-styles.js` | Pure className builders + responsive decisions for all 5 primitives | Modify (extend) |
| `mobile/lib/ui-styles.test.js` | Tests for the new className builders/decisions | Modify (extend) |
| `mobile/lib/form-validation.js` | `collectZodErrors(schema, values)` — pure Zod→per-field-error map | Create |
| `mobile/lib/form-validation.test.js` | Tests for the validation helper | Create |
| `mobile/components/ui/Modal.jsx` | Responsive modal shell (sheet on phone, dialog on tablet) | Create |
| `mobile/components/ui/DataTable.jsx` | Responsive list shell (cards on phone, table on tablet) | Create |
| `mobile/components/ui/Form.jsx` | Form context (values/errors/setValue/submit) | Create |
| `mobile/components/ui/FormField.jsx` | Field bound to Form context by `name` | Create |
| `mobile/components/ui/Tabs.jsx` | Responsive tab strip shell | Create |
| `mobile/components/ui/SplitView.jsx` | Master-detail shell (side-by-side tablet, single-pane phone) | Create |
| `mobile/components/ui/index.js` | Barrel — export each new primitive | Modify (extend per task) |

---

## Task 1: Modal primitive

Responsive: bottom-sheet on phone, centered dialog on tablet. Mirrors web `Modal` props (`open`, `onClose`, `title`, `footer`, `dismissable`, `children`).

**Files:** Modify `mobile/lib/ui-styles.js`, `mobile/lib/ui-styles.test.js`; Create `mobile/components/ui/Modal.jsx`; Modify `mobile/components/ui/index.js`.

- [ ] **Step 1: Write the failing tests**

Append to `mobile/lib/ui-styles.test.js`:

```js
import {
  modalOverlayClasses, modalContainerClasses, modalPanelClasses,
} from './ui-styles.js'

describe('modal classes', () => {
  it('overlay dims the full screen', () => {
    expect(modalOverlayClasses()).toContain('bg-black/50')
    expect(modalOverlayClasses()).toContain('flex-1')
  })
  it('tablet centers the panel; phone anchors it to the bottom', () => {
    expect(modalContainerClasses({ isTablet: true })).toContain('justify-center')
    expect(modalContainerClasses({ isTablet: false })).toContain('justify-end')
  })
  it('tablet panel is a rounded card with a max width; phone panel is a top-rounded sheet', () => {
    const tablet = modalPanelClasses({ isTablet: true })
    const phone = modalPanelClasses({ isTablet: false })
    expect(tablet).toContain('rounded-2xl')
    expect(tablet).toContain('max-w-lg')
    expect(phone).toContain('rounded-t-2xl')
    expect(phone).not.toContain('max-w-lg')
  })
  it('uses un1t tokens and never emits undefined', () => {
    expect(modalPanelClasses({ isTablet: false })).not.toContain('undefined')
    expect(modalPanelClasses()).toContain('bg-white')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run mobile/lib/ui-styles.test.js`
Expected: FAIL — the three `modal*` functions are not exported.

- [ ] **Step 3: Implement the pure classes**

Append to `mobile/lib/ui-styles.js`:

```js
// ── Modal ──────────────────────────────────────────────────────────
// Responsive: bottom-sheet on phone, centered dialog on tablet. The
// shell (components/ui/Modal.jsx) reads useIsTablet() and passes the
// boolean here so the layout decision stays unit-testable.
export function modalOverlayClasses() {
  return 'flex-1 bg-black/50'
}
export function modalContainerClasses({ isTablet = false } = {}) {
  return isTablet ? 'flex-1 items-center justify-center p-6' : 'flex-1 justify-end'
}
export function modalPanelClasses({ isTablet = false } = {}) {
  return isTablet
    ? 'w-full max-w-lg rounded-2xl bg-white p-5'
    : 'w-full rounded-t-2xl bg-white p-5 pb-8'
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run mobile/lib/ui-styles.test.js`
Expected: PASS.

- [ ] **Step 5: Write the RN shell**

Create `mobile/components/ui/Modal.jsx`:

```js
// MOB-UI.3 — Modal primitive (RN). Responsive: bottom-sheet on phone,
// centered dialog on tablet. Mirrors the web Modal props (open,
// onClose, title, footer, dismissable). Backdrop press closes when
// dismissable; layout logic is unit-tested in ../../lib/ui-styles.js.
import { Modal as RNModal, View, Text, Pressable } from 'react-native'
import { useIsTablet } from '../../lib/use-is-tablet'
import { modalOverlayClasses, modalContainerClasses, modalPanelClasses } from '../../lib/ui-styles.js'

/**
 * @param {object} props
 * @param {boolean} props.open
 * @param {()=>void} props.onClose
 * @param {React.ReactNode} [props.title]
 * @param {React.ReactNode} [props.footer]  action row rendered under the body
 * @param {boolean} [props.dismissable]     default true; false disables backdrop close
 * @param {React.ReactNode} props.children
 */
export default function Modal({ open, onClose, title, footer, dismissable = true, children }) {
  const isTablet = useIsTablet()
  return (
    <RNModal visible={open} transparent animationType="fade" onRequestClose={() => dismissable && onClose?.()}>
      <Pressable className={`${modalOverlayClasses()} ${modalContainerClasses({ isTablet })}`} onPress={() => dismissable && onClose?.()}>
        {/* Inner Pressable swallows taps so pressing the panel doesn't close. */}
        <Pressable className={modalPanelClasses({ isTablet })} onPress={() => {}}>
          {title != null && <Text className="mb-3 text-lg font-semibold text-un1t-text">{title}</Text>}
          {children}
          {footer != null && <View className="mt-4 flex-row justify-end gap-2">{footer}</View>}
        </Pressable>
      </Pressable>
    </RNModal>
  )
}
```

- [ ] **Step 6: Add to the barrel**

In `mobile/components/ui/index.js`, add after the existing `export { default as Field } ...` line:

```js
export { default as Modal } from './Modal.jsx'
```

- [ ] **Step 7: Verify imports resolve + commit**

Run: `npm run check:mobile-imports`
Expected: clean (exit 0).

```bash
git add mobile/lib/ui-styles.js mobile/lib/ui-styles.test.js mobile/components/ui/Modal.jsx mobile/components/ui/index.js
git commit -m "PRIM.1 — responsive Modal primitive (sheet on phone, dialog on tablet)"
```

---

## Task 2: DataTable primitive

Responsive: stacked cards on phone, columnar table on tablet. Takes a `columns` config + `data`.

**Files:** Modify `mobile/lib/ui-styles.js`, `mobile/lib/ui-styles.test.js`; Create `mobile/components/ui/DataTable.jsx`; Modify `mobile/components/ui/index.js`.

- [ ] **Step 1: Write the failing tests**

Append to `mobile/lib/ui-styles.test.js`:

```js
import {
  dataTableMode, tableHeaderClasses, tableRowClasses,
  tableHeaderTextClasses, tableCellTextClasses,
  dataCardClasses, dataCardLabelClasses, dataCardValueClasses,
} from './ui-styles.js'

describe('data table classes', () => {
  it('mode is table on tablet, cards on phone', () => {
    expect(dataTableMode(true)).toBe('table')
    expect(dataTableMode(false)).toBe('cards')
  })
  it('header + rows use un1t tokens and a bottom border', () => {
    expect(tableHeaderClasses()).toContain('border-b')
    expect(tableHeaderClasses()).toContain('border-un1t-border')
    expect(tableRowClasses()).toContain('border-un1t-border')
  })
  it('pressable rows get an active background; non-pressable do not', () => {
    expect(tableRowClasses({ pressable: true })).toContain('active:bg-un1t-surface')
    expect(tableRowClasses({ pressable: false })).not.toContain('active:bg-un1t-surface')
  })
  it('header text is uppercase muted; cell text is normal', () => {
    expect(tableHeaderTextClasses()).toContain('uppercase')
    expect(tableHeaderTextClasses()).toContain('un1t-subtle')
    expect(tableCellTextClasses()).toContain('un1t-text')
  })
  it('phone card has label + value styles and no undefined', () => {
    expect(dataCardClasses()).toContain('rounded-2xl')
    expect(dataCardLabelClasses()).toContain('un1t-subtle')
    expect(dataCardValueClasses()).toContain('un1t-text')
    expect(tableRowClasses({ pressable: true })).not.toContain('undefined')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run mobile/lib/ui-styles.test.js`
Expected: FAIL — the `dataTable`/`table*`/`dataCard*` functions are not exported.

- [ ] **Step 3: Implement the pure classes**

Append to `mobile/lib/ui-styles.js`:

```js
// ── DataTable ──────────────────────────────────────────────────────
// Responsive: columnar table on tablet, stacked label/value cards on
// phone. dataTableMode() is the decision; the rest are className
// builders. The shell renders a FlatList either way.
export function dataTableMode(isTablet) {
  return isTablet ? 'table' : 'cards'
}
export function tableHeaderClasses() {
  return 'flex-row border-b border-un1t-border bg-un1t-surface px-3 py-2'
}
export function tableRowClasses({ pressable = false } = {}) {
  return ['flex-row items-center border-b border-un1t-border px-3 py-3', pressable ? 'active:bg-un1t-surface' : '']
    .filter(Boolean).join(' ')
}
export function tableHeaderTextClasses() {
  return 'text-xs font-semibold uppercase text-un1t-subtle'
}
export function tableCellTextClasses() {
  return 'text-sm text-un1t-text'
}
export function dataCardClasses() {
  return 'mb-2 rounded-2xl border border-un1t-border bg-white p-4'
}
export function dataCardLabelClasses() {
  return 'text-xs text-un1t-subtle'
}
export function dataCardValueClasses() {
  return 'text-sm text-un1t-text'
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run mobile/lib/ui-styles.test.js`
Expected: PASS.

- [ ] **Step 5: Write the RN shell**

Create `mobile/components/ui/DataTable.jsx`:

```js
// MOB-UI.3 — DataTable primitive (RN). Responsive: columnar table on
// tablet, stacked label/value cards on phone. Same `columns` + `data`
// API both ways; the phone card lists each column as label: value.
// Mode + classes are unit-tested in ../../lib/ui-styles.js.
import { View, Text, Pressable, FlatList } from 'react-native'
import { useIsTablet } from '../../lib/use-is-tablet'
import {
  dataTableMode, tableHeaderClasses, tableRowClasses,
  tableHeaderTextClasses, tableCellTextClasses,
  dataCardClasses, dataCardLabelClasses, dataCardValueClasses,
} from '../../lib/ui-styles.js'

/**
 * @param {object} props
 * @param {{ key: string, label: string, flex?: number, render?: (row:object)=>React.ReactNode }[]} props.columns
 * @param {object[]} props.data
 * @param {(row:object)=>string} props.keyExtractor
 * @param {(row:object)=>void} [props.onRowPress]
 * @param {React.ReactNode} [props.empty]   rendered when data is empty
 */
export default function DataTable({ columns, data, keyExtractor, onRowPress, empty = null }) {
  const isTablet = useIsTablet()
  const mode = dataTableMode(isTablet)

  function cell(col, row) {
    return col.render ? col.render(row) : <Text className={tableCellTextClasses()}>{String(row[col.key] ?? '')}</Text>
  }

  if (mode === 'table') {
    return (
      <View>
        <View className={tableHeaderClasses()}>
          {columns.map(col => (
            <View key={col.key} style={{ flex: col.flex ?? 1 }}>
              <Text className={tableHeaderTextClasses()}>{col.label}</Text>
            </View>
          ))}
        </View>
        <FlatList
          data={data}
          keyExtractor={keyExtractor}
          ListEmptyComponent={empty}
          renderItem={({ item }) => (
            <Pressable className={tableRowClasses({ pressable: !!onRowPress })} onPress={() => onRowPress?.(item)}>
              {columns.map(col => (
                <View key={col.key} style={{ flex: col.flex ?? 1 }}>{cell(col, item)}</View>
              ))}
            </Pressable>
          )}
        />
      </View>
    )
  }

  // phone: stacked cards
  return (
    <FlatList
      data={data}
      keyExtractor={keyExtractor}
      ListEmptyComponent={empty}
      renderItem={({ item }) => (
        <Pressable className={dataCardClasses()} onPress={() => onRowPress?.(item)}>
          {columns.map(col => (
            <View key={col.key} className="mb-1 flex-row justify-between">
              <Text className={dataCardLabelClasses()}>{col.label}</Text>
              <View className="ml-2 flex-1 items-end">{cell(col, item)}</View>
            </View>
          ))}
        </Pressable>
      )}
    />
  )
}
```

- [ ] **Step 6: Add to the barrel**

In `mobile/components/ui/index.js`, add:

```js
export { default as DataTable } from './DataTable.jsx'
```

- [ ] **Step 7: Verify imports resolve + commit**

Run: `npm run check:mobile-imports`
Expected: clean.

```bash
git add mobile/lib/ui-styles.js mobile/lib/ui-styles.test.js mobile/components/ui/DataTable.jsx mobile/components/ui/index.js
git commit -m "PRIM.2 — responsive DataTable primitive (cards on phone, table on tablet)"
```

---

## Task 3: Form + FormField primitives

A lightweight Form context holding `values`/`errors`, with validation against a Zod schema on submit; FormField binds the existing `Field` to the context by `name`.

**Files:** Create `mobile/lib/form-validation.js`, `mobile/lib/form-validation.test.js`; Create `mobile/components/ui/Form.jsx`, `mobile/components/ui/FormField.jsx`; Modify `mobile/components/ui/index.js`.

- [ ] **Step 1: Write the failing test**

Create `mobile/lib/form-validation.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { collectZodErrors } from './form-validation.js'

const Schema = z.object({
  name: z.string().min(1, 'Name is required'),
  age: z.number().int().min(0, 'Age must be ≥ 0'),
})

describe('collectZodErrors', () => {
  it('returns an empty object when the values are valid', () => {
    expect(collectZodErrors(Schema, { name: 'Ada', age: 30 })).toEqual({})
  })
  it('maps each failing field to its first message, keyed by dotted path', () => {
    const errs = collectZodErrors(Schema, { name: '', age: -1 })
    expect(errs.name).toBe('Name is required')
    expect(errs.age).toBe('Age must be ≥ 0')
  })
  it('keeps only the first error per field', () => {
    const S = z.object({ x: z.string().min(3, 'too short').regex(/^a/, 'must start with a') })
    const errs = collectZodErrors(S, { x: '' })
    expect(Object.keys(errs)).toEqual(['x'])
  })
  it('handles nested paths with a dotted key', () => {
    const S = z.object({ profile: z.object({ email: z.string().email('bad email') }) })
    const errs = collectZodErrors(S, { profile: { email: 'nope' } })
    expect(errs['profile.email']).toBe('bad email')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run mobile/lib/form-validation.test.js`
Expected: FAIL — Cannot find module './form-validation.js'.

- [ ] **Step 3: Implement the validation helper**

Create `mobile/lib/form-validation.js`:

```js
// MOB-UI.3 — pure form-validation helper shared by the Form primitive.
// Maps a Zod safeParse failure to a { 'dotted.path': firstMessage } map
// that FormField reads by `name`. Kept RN-free so it runs under vitest.
// Mirrors the issue-mapping shape used by src/lib/validate.js on web.

/**
 * @param {import('zod').ZodType} schema
 * @param {unknown} values
 * @returns {Record<string,string>} field path → first error message ({} if valid)
 */
export function collectZodErrors(schema, values) {
  const parsed = schema.safeParse(values)
  if (parsed.success) return {}
  const errors = {}
  for (const issue of parsed.error.issues) {
    const key = issue.path.join('.')
    if (!(key in errors)) errors[key] = issue.message // first error per field wins
  }
  return errors
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run mobile/lib/form-validation.test.js`
Expected: PASS (4 cases).

- [ ] **Step 5: Write the Form context shell**

Create `mobile/components/ui/Form.jsx`:

```js
// MOB-UI.3 — Form primitive (RN). Holds values + errors in context;
// validates against a Zod schema on submit via collectZodErrors. Child
// FormFields read/write by `name`. Validation messages match web
// (same Zod schemas from shared/schemas → same strings).
import { createContext, useContext, useState, useCallback } from 'react'
import { collectZodErrors } from '../../lib/form-validation.js'

const FormContext = createContext(null)

export function useForm() {
  const ctx = useContext(FormContext)
  if (!ctx) throw new Error('useForm must be used inside <Form>')
  return ctx
}

/**
 * @param {object} props
 * @param {object} props.initialValues
 * @param {import('zod').ZodType} props.schema
 * @param {(values:object)=>void|Promise<void>} props.onSubmit  called only when valid
 * @param {(form:{ values, errors, setValue, submit })=>React.ReactNode} props.children
 *   render-prop so the caller can wire its own submit button.
 */
export default function Form({ initialValues, schema, onSubmit, children }) {
  const [values, setValues] = useState(initialValues || {})
  const [errors, setErrors] = useState({})

  const setValue = useCallback((name, value) => {
    setValues(prev => ({ ...prev, [name]: value }))
  }, [])

  const submit = useCallback(async () => {
    const errs = collectZodErrors(schema, values)
    setErrors(errs)
    if (Object.keys(errs).length === 0) await onSubmit?.(values)
  }, [schema, values, onSubmit])

  return (
    <FormContext.Provider value={{ values, errors, setValue, submit }}>
      {typeof children === 'function' ? children({ values, errors, setValue, submit }) : children}
    </FormContext.Provider>
  )
}
```

- [ ] **Step 6: Write the FormField shell**

Create `mobile/components/ui/FormField.jsx`:

```js
// MOB-UI.3 — FormField primitive (RN). Binds the Field primitive to the
// Form context by `name`: renders the label/error from context and a
// TextInput wired to values[name]. For non-text controls, pass a
// render-prop child receiving { value, onChange, controlProps }.
import { TextInput } from 'react-native'
import Field from './Field.jsx'
import { useForm } from './Form.jsx'

/**
 * @param {object} props
 * @param {string} props.name
 * @param {string} props.label
 * @param {string} [props.hint]
 * @param {boolean} [props.required]
 * @param {object} [props.inputProps]  extra TextInput props (keyboardType, etc.)
 * @param {(api:{ value:any, onChange:(v:any)=>void, controlProps:object })=>React.ReactNode} [props.children]
 *   optional custom control; defaults to a TextInput.
 */
export default function FormField({ name, label, hint, required = false, inputProps, children }) {
  const { values, errors, setValue } = useForm()
  const value = values[name]
  const error = errors[name]
  const onChange = (v) => setValue(name, v)

  return (
    <Field label={label} hint={hint} error={error} required={required} className="mb-3">
      {(controlProps) =>
        typeof children === 'function'
          ? children({ value, onChange, controlProps })
          : (
            <TextInput
              {...controlProps}
              {...inputProps}
              value={value != null ? String(value) : ''}
              onChangeText={onChange}
              className="rounded-xl border border-un1t-border bg-white px-3 py-2 text-un1t-text"
            />
          )
      }
    </Field>
  )
}
```

- [ ] **Step 7: Add to the barrel**

In `mobile/components/ui/index.js`, add:

```js
export { default as Form, useForm } from './Form.jsx'
export { default as FormField } from './FormField.jsx'
```

- [ ] **Step 8: Verify imports resolve + commit**

Run: `npm run check:mobile-imports`
Expected: clean.

```bash
git add mobile/lib/form-validation.js mobile/lib/form-validation.test.js mobile/components/ui/Form.jsx mobile/components/ui/FormField.jsx mobile/components/ui/index.js
git commit -m "PRIM.3 — Form + FormField primitives (Zod-validated, shared schema strings)"
```

---

## Task 4: Tabs primitive

Responsive: horizontally-scrollable strip on phone, inline row on tablet.

**Files:** Modify `mobile/lib/ui-styles.js`, `mobile/lib/ui-styles.test.js`; Create `mobile/components/ui/Tabs.jsx`; Modify `mobile/components/ui/index.js`.

- [ ] **Step 1: Write the failing tests**

Append to `mobile/lib/ui-styles.test.js`:

```js
import { tabItemClasses, tabTextClasses } from './ui-styles.js'

describe('tabs classes', () => {
  it('active tab is filled with the accent; inactive is bordered surface', () => {
    expect(tabItemClasses({ active: true })).toContain('bg-un1t-accent')
    expect(tabItemClasses({ active: false })).toContain('border-un1t-border')
  })
  it('active text is white; inactive text is muted', () => {
    expect(tabTextClasses({ active: true })).toContain('text-white')
    expect(tabTextClasses({ active: false })).toContain('un1t-subtle')
  })
  it('never emits undefined for default args', () => {
    expect(tabItemClasses()).not.toContain('undefined')
    expect(tabTextClasses()).not.toContain('undefined')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run mobile/lib/ui-styles.test.js`
Expected: FAIL — `tabItemClasses`/`tabTextClasses` not exported.

- [ ] **Step 3: Implement the pure classes**

Append to `mobile/lib/ui-styles.js`:

```js
// ── Tabs ───────────────────────────────────────────────────────────
// Pill tabs. Active = filled accent; inactive = bordered surface. The
// shell wraps the row in a horizontal ScrollView on phone (overflow)
// and a plain row on tablet.
export function tabItemClasses({ active = false } = {}) {
  return ['rounded-full px-4 py-2', active ? 'bg-un1t-accent' : 'bg-un1t-surface border border-un1t-border']
    .join(' ')
}
export function tabTextClasses({ active = false } = {}) {
  return ['text-sm font-medium', active ? 'text-white' : 'text-un1t-subtle'].join(' ')
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run mobile/lib/ui-styles.test.js`
Expected: PASS.

- [ ] **Step 5: Write the RN shell**

Create `mobile/components/ui/Tabs.jsx`:

```js
// MOB-UI.3 — Tabs primitive (RN). Pill tabs; horizontally scrollable on
// phone (when they overflow), inline row on tablet. Controlled: parent
// owns `value` and `onChange`. Item/text classes are unit-tested in
// ../../lib/ui-styles.js.
import { View, Text, Pressable, ScrollView } from 'react-native'
import { useIsTablet } from '../../lib/use-is-tablet'
import { tabItemClasses, tabTextClasses } from '../../lib/ui-styles.js'

/**
 * @param {object} props
 * @param {{ key: string, label: string }[]} props.tabs
 * @param {string} props.value          active tab key
 * @param {(key:string)=>void} props.onChange
 */
export default function Tabs({ tabs, value, onChange }) {
  const isTablet = useIsTablet()
  const row = (
    <View className="flex-row gap-2">
      {tabs.map(tab => {
        const active = tab.key === value
        return (
          <Pressable
            key={tab.key}
            className={tabItemClasses({ active })}
            onPress={() => onChange?.(tab.key)}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
          >
            <Text className={tabTextClasses({ active })}>{tab.label}</Text>
          </Pressable>
        )
      })}
    </View>
  )
  // Tablet has room for the full row; phone scrolls horizontally when
  // the tabs overflow the width.
  return isTablet ? row : (
    <ScrollView horizontal showsHorizontalScrollIndicator={false}>{row}</ScrollView>
  )
}
```

- [ ] **Step 6: Add to the barrel**

In `mobile/components/ui/index.js`, add:

```js
export { default as Tabs } from './Tabs.jsx'
```

- [ ] **Step 7: Verify imports resolve + commit**

Run: `npm run check:mobile-imports`
Expected: clean.

```bash
git add mobile/lib/ui-styles.js mobile/lib/ui-styles.test.js mobile/components/ui/Tabs.jsx mobile/components/ui/index.js
git commit -m "PRIM.4 — responsive Tabs primitive (scroll strip on phone, row on tablet)"
```

---

## Task 5: SplitView (master-detail) primitive

Side-by-side master + detail on tablet; single pane (master, or detail when a row is selected) on phone. Uses the existing `MASTER_PANE_WIDTH_PT`.

**Files:** Modify `mobile/lib/ui-styles.js`, `mobile/lib/ui-styles.test.js`; Create `mobile/components/ui/SplitView.jsx`; Modify `mobile/components/ui/index.js`.

- [ ] **Step 1: Write the failing tests**

Append to `mobile/lib/ui-styles.test.js`:

```js
import { splitShowsBothPanes, splitPhonePane, masterPaneClasses } from './ui-styles.js'

describe('split view layout', () => {
  it('shows both panes only on tablet', () => {
    expect(splitShowsBothPanes(true)).toBe(true)
    expect(splitShowsBothPanes(false)).toBe(false)
  })
  it('phone shows detail when a row is selected, else master', () => {
    expect(splitPhonePane(true)).toBe('detail')
    expect(splitPhonePane(false)).toBe('master')
  })
  it('master pane has a right divider', () => {
    expect(masterPaneClasses()).toContain('border-r')
    expect(masterPaneClasses()).toContain('border-un1t-border')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run mobile/lib/ui-styles.test.js`
Expected: FAIL — `splitShowsBothPanes`/`splitPhonePane`/`masterPaneClasses` not exported.

- [ ] **Step 3: Implement the pure logic**

Append to `mobile/lib/ui-styles.js`:

```js
// ── SplitView (master-detail) ──────────────────────────────────────
// Tablet shows both panes side-by-side (master fixed-width via
// MASTER_PANE_WIDTH_PT in the shell, detail flexes). Phone shows one
// pane: detail when a row is selected, otherwise the master list.
export function splitShowsBothPanes(isTablet) {
  return Boolean(isTablet)
}
export function splitPhonePane(hasSelection) {
  return hasSelection ? 'detail' : 'master'
}
export function masterPaneClasses() {
  return 'border-r border-un1t-border'
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run mobile/lib/ui-styles.test.js`
Expected: PASS.

- [ ] **Step 5: Write the RN shell**

Create `mobile/components/ui/SplitView.jsx`:

```js
// MOB-UI.3 — SplitView (master-detail) primitive (RN). Tablet: master
// list (fixed MASTER_PANE_WIDTH_PT) beside a flexing detail pane.
// Phone: a single pane — detail when `hasSelection`, else the master
// list (parent controls selection + a back action). Decision logic is
// unit-tested in ../../lib/ui-styles.js.
import { View } from 'react-native'
import { useIsTablet } from '../../lib/use-is-tablet'
import { MASTER_PANE_WIDTH_PT } from '../../lib/tablet-breakpoint.js'
import { splitShowsBothPanes, splitPhonePane, masterPaneClasses } from '../../lib/ui-styles.js'

/**
 * @param {object} props
 * @param {React.ReactNode} props.master       the list pane
 * @param {React.ReactNode} props.detail       the detail pane
 * @param {boolean} props.hasSelection         phone: show detail when true
 */
export default function SplitView({ master, detail, hasSelection = false }) {
  const isTablet = useIsTablet()

  if (splitShowsBothPanes(isTablet)) {
    return (
      <View className="flex-1 flex-row">
        <View className={masterPaneClasses()} style={{ width: MASTER_PANE_WIDTH_PT }}>{master}</View>
        <View className="flex-1">{detail}</View>
      </View>
    )
  }

  // phone: one pane at a time
  return <View className="flex-1">{splitPhonePane(hasSelection) === 'detail' ? detail : master}</View>
}
```

- [ ] **Step 6: Add to the barrel**

In `mobile/components/ui/index.js`, add:

```js
export { default as SplitView } from './SplitView.jsx'
```

- [ ] **Step 7: Verify imports resolve + commit**

Run: `npm run check:mobile-imports`
Expected: clean.

```bash
git add mobile/lib/ui-styles.js mobile/lib/ui-styles.test.js mobile/components/ui/SplitView.jsx mobile/components/ui/index.js
git commit -m "PRIM.5 — SplitView master-detail primitive (side-by-side tablet, single-pane phone)"
```

---

## Task 6: Full-suite gate + PR

**Files:** none (verification only)

- [ ] **Step 1: Run the full CI mirror**

Run:
```bash
npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports
```
Expected: tests PASS (existing + all new `ui-styles` and `form-validation` cases), lint 0 errors (1 pre-existing warning in `ChooserEditorForm.jsx` is OK), parity clean, mobile-imports clean.

- [ ] **Step 2: Push and open the PR**

```bash
git push -u origin mobile-parity-primitives
```
Open the PR against `main`, title `PRIM — responsive mobile primitive library (cycle 1, plan B)`, body summarising the five primitives, the pure-logic/shell split (pure logic unit-tested, RN shells verified by mobile-imports), that they're additive (no existing screen changed), and that Plan C (Staff & Access) composes them.

---

## Self-review

- **Spec coverage:** Implements the spec's §4 responsive primitive library — Modal, DataTable, Form+FormField, Tabs, SplitView, all phone+tablet responsive via the `isTablet`-keyed pure decisions, on NativeWind + `un1t-*` tokens, mirroring web prop names where a counterpart exists (Modal). §1–§3, §5–§9 are other plans.
- **Placeholder scan:** none — every step has complete code + exact commands.
- **Type/name consistency:** the pure functions (`modalOverlayClasses`/`modalContainerClasses`/`modalPanelClasses`, `dataTableMode`/`table*Classes`/`dataCard*Classes`, `collectZodErrors`, `tabItemClasses`/`tabTextClasses`, `splitShowsBothPanes`/`splitPhonePane`/`masterPaneClasses`) are defined in the same task they're first tested, and the shells import exactly those names. `useForm` is exported from `Form.jsx` and imported by `FormField.jsx`. Barrel exports match the shell default/named exports.
- **Convention match:** pure logic in `mobile/lib/` (vitest), shells in `mobile/components/ui/` (Field.jsx style: `className`, accessibility props, render-props where a control is injected), `Object.freeze`/fallback/`.filter(Boolean).join(' ')` idiom, `un1t-*` tokens, barrel pattern — all match the existing Button/Card/Field/Screen primitives.
- **Testability:** every responsive decision is a pure function tested in vitest; the RN shells (which the Node test env can't render) are thin and verified by `check:mobile-imports` + the final gate, exactly as the existing primitives are.
