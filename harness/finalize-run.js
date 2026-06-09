#!/usr/bin/env node
// CLI: node harness/finalize-run.js --feature <id> [--status <STATUS>] [--cleanup-stuck] [--write-metrics]
//
// --feature <id>      required: feature ID (e.g. F-03)
// --status <STATUS>   update features.json via update-status.js (DONE | BLOCKED | TODO)
// --cleanup-stuck     delete harness/stuck/<id>_stuck_reason.md if it exists
// --write-metrics     read one JSON line from stdin and append to harness/metrics.jsonl
//
// Exits non-zero on any failure so calling agents can detect errors.

'use strict'

const fs   = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

function die(msg) {
  process.stderr.write(`finalize-run: ${msg}\n`)
  process.exit(1)
}

const argv = process.argv.slice(2)
let featureId    = null
let status       = null
let cleanupStuck = false
let writeMetrics = false

for (let i = 0; i < argv.length; i++) {
  if      (argv[i] === '--feature')       featureId = argv[++i]
  else if (argv[i] === '--status')        status = argv[++i]
  else if (argv[i] === '--cleanup-stuck') cleanupStuck = true
  else if (argv[i] === '--write-metrics') writeMetrics = true
}

if (!featureId) die('--feature <id> is required')

// 1. Append metrics line from stdin to metrics.jsonl
if (writeMetrics) {
  const metricsLine = fs.readFileSync(0, 'utf8').trim()
  if (!metricsLine) die('--write-metrics: stdin was empty')
  const metricsPath = path.join(process.cwd(), 'harness', 'metrics.jsonl')
  fs.appendFileSync(metricsPath, metricsLine + '\n', 'utf8')
  process.stdout.write(`metrics: appended 1 record to ${path.basename(metricsPath)}\n`)
}

// 2. Update feature status (delegates to update-status.js for transition validation)
if (status) {
  execFileSync('node', ['harness/update-status.js', '--feature', featureId, '--status', status], {
    stdio: 'inherit',
    cwd: process.cwd(),
  })
}

// 3. Delete stuck file if present
if (cleanupStuck) {
  const stuckPath = path.join(process.cwd(), 'harness', 'stuck', `${featureId}_stuck_reason.md`)
  try {
    fs.unlinkSync(stuckPath)
    process.stdout.write(`cleanup: deleted ${path.basename(stuckPath)}\n`)
  } catch (e) {
    if (e.code !== 'ENOENT') throw e
    process.stdout.write(`cleanup: no stuck file for ${featureId}\n`)
  }
}
