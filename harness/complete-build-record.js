#!/usr/bin/env node
// Patches the most recent partial:true entry in build-runs.jsonl with the true
// token count from the task notification. Run this after every build-all
// workflow notification arrives.
//
// Usage:
//   node harness/complete-build-record.js \
//     --task-id   <workflow task id>  \
//     --subagent-tokens <n>           \
//     --agent-count     <n>           \
//     --duration-ms     <n>
//
// If no partial entry exists, appends a new complete record instead.

import { readFileSync, writeFileSync, existsSync } from 'fs'
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
const patch = {
  taskId:         a['task-id']          ?? null,
  subagentTokens: Number(a['subagent-tokens'] ?? 0),
  agentCount:     Number(a['agent-count']     ?? 0),
  durationMs:     Number(a['duration-ms']     ?? 0),
  partial:        false,
}

if (!existsSync(RUNS_FILE)) {
  // No existing file — write a standalone complete record
  const record = { date: new Date().toISOString(), completed: 0, blocked: [], budgetSpent: 0, ...patch }
  writeFileSync(RUNS_FILE, JSON.stringify(record) + '\n', 'utf8')
  console.log(`[complete-build-record] Created new entry for task ${patch.taskId}`)
  process.exit(0)
}

const lines = readFileSync(RUNS_FILE, 'utf8').trimEnd().split('\n').filter(Boolean)

// Find last partial entry
let lastPartialIdx = -1
for (let i = lines.length - 1; i >= 0; i--) {
  try {
    const rec = JSON.parse(lines[i])
    if (rec.partial === true) { lastPartialIdx = i; break }
  } catch { /* skip malformed lines */ }
}

if (lastPartialIdx === -1) {
  // No partial entry — append a new complete record
  const record = { date: new Date().toISOString(), completed: 0, blocked: [], budgetSpent: 0, ...patch }
  writeFileSync(RUNS_FILE, lines.join('\n') + '\n' + JSON.stringify(record) + '\n', 'utf8')
  console.log(`[complete-build-record] No partial entry found — appended new record for task ${patch.taskId}`)
  process.exit(0)
}

// Patch the partial entry
const existing = JSON.parse(lines[lastPartialIdx])
lines[lastPartialIdx] = JSON.stringify({ ...existing, ...patch })
writeFileSync(RUNS_FILE, lines.join('\n') + '\n', 'utf8')
console.log(`[complete-build-record] Patched partial entry with taskId=${patch.taskId}, subagentTokens=${patch.subagentTokens.toLocaleString()}, agentCount=${patch.agentCount}, durationMs=${patch.durationMs.toLocaleString()}`)
