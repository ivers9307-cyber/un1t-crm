#!/usr/bin/env node
// DBTYPES.1 — type-check the files that opted in with a `// @ts-check` line.
//
// Everything else stays plain JavaScript: other files are read only for the
// types they export, and errors in them are not reported. In a checked file
// every parameter needs a type, so a `db` cannot quietly be `any`.
//
// supabase-js does not raise a compile error for a bad .select() string: the
// result type becomes an error message, which only bites if the rows are used.
// So this also inspects each .select() call and fails on that message. That is
// the phantom-column bug, caught at the call.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { findSelectErrors, missingProofs, optedIn } from './lib/check-types-core.mjs'

execFileSync(process.execPath, ['scripts/generate-db-types.mjs', '--check'], { stdio: 'inherit' })

const listed = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', 'src', 'shared'], { encoding: 'utf8', maxBuffer: 1 << 26 }).split('\n')
const files = listed.filter((f) => /\.jsx?$/.test(f) && fs.existsSync(f) && optedIn(fs.readFileSync(f, 'utf8')))
if (files.length === 0) { console.log('✓ types: no file has opted in'); process.exit(0) }

const { config } = ts.readConfigFile('tsconfig.check.json', ts.sys.readFile)
const { options } = ts.parseJsonConfigFileContent(config, ts.sys, process.cwd())
// The self-test: a file of known mistakes that must keep being caught. If a
// library upgrade or a type change blinds this check, the check fails.
const PROOF = 'scripts/fixtures/db-types-must-fail.js'
const program = ts.createProgram([...files, PROOF, 'supabase/schema/database.d.ts'], options)
const wanted = new Set(files.map((f) => path.resolve(f)))
const problems = []
const proofHits = []
const where = (sf, pos) => {
  const { line, character } = sf.getLineAndCharacterOfPosition(pos)
  return `${path.relative(process.cwd(), sf.fileName)}:${line + 1}:${character + 1}`
}
const report = (isProof, line) => (isProof ? proofHits : problems).push(line)
for (const sf of program.getSourceFiles()) {
  const isProof = path.resolve(sf.fileName) === path.resolve(PROOF)
  if (!isProof && !wanted.has(path.resolve(sf.fileName))) continue
  for (const d of [...program.getSyntacticDiagnostics(sf), ...program.getSemanticDiagnostics(sf)]) {
    report(isProof, `${where(sf, d.start ?? 0)} ${ts.flattenDiagnosticMessageText(d.messageText, '\n').split('\n')[0]}`)
  }
  for (const e of findSelectErrors(ts, program.getTypeChecker(), sf)) report(isProof, `${where(sf, e.pos)} ${e.message}`)
}
for (const m of missingProofs(proofHits)) problems.push(`${PROOF}: this known mistake is no longer caught: ${m}`)
if (problems.length === 0) { console.log(`✓ types: ${files.length} file(s) checked against the database types`); process.exit(0) }
for (const p of problems) console.error(p)
console.error(`✗ types: ${problems.length} problem(s) in the ${files.length} checked file(s)`)
process.exit(1)
