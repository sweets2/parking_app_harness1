#!/usr/bin/env node
// Appends a partial build-runs.jsonl entry. Called by build-all.js at the end
// of every run. A companion script (complete-build-record.js) patches the entry
// with true subagentTokens once the task notification arrives.
//
// Usage:
//   node harness/write-build-record.js \
//     --budget-spent <n> \
//     --completed <n> \
//     --blocked '["F-01","F-03"]'

import { appendFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const RUNS_FILE = join(__dirname, 'build-runs.jsonl')

function parseArgs() {
  const args = process.argv.slice(2)
  const result = {}
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i].replace(/^--/, '')
    result[key] = args[i + 1]
  }
  return result
}

const a = parseArgs()
const record = {
  date:        new Date().toISOString(),
  budgetSpent: Number(a['budget-spent'] ?? 0),
  completed:   Number(a['completed'] ?? 0),
  blocked:     JSON.parse(a['blocked'] ?? '[]'),
  partial:     true,
}

appendFileSync(RUNS_FILE, JSON.stringify(record) + '\n', 'utf8')
console.log(`[write-build-record] Appended partial entry to build-runs.jsonl (budgetSpent=${record.budgetSpent.toLocaleString()}, completed=${record.completed}, blocked=${record.blocked.length})`)
