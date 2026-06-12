#!/usr/bin/env node
// CLI: node harness/update-status.js --feature <id> --status <TODO|DONE|BLOCKED>
// Validates the transition, writes atomically, verifies the result.
// Exits non-zero on any failure so agent-reported failures are observable.

'use strict'

const fs = require('fs')
const path = require('path')

// O_EXCL spinlock: prevents TOCTOU corruption when two concurrent callers
// both read features.json, modify their feature, and write back — without a
// lock the second write silently overwrites the first feature's status change.
// Spin up to ~5 seconds before giving up (100 × 50ms). Stale locks from
// SIGKILL'd processes (which bypass process.on('exit')) must be removed manually:
//   rm -f harness/features.json.lock
const LOCK_MAX_RETRIES = 100
function acquireLock(lockPath) {
  for (let i = 0; i < LOCK_MAX_RETRIES; i++) {
    try { fs.closeSync(fs.openSync(lockPath, 'wx')); return }
    catch (e) {
      if (e.code !== 'EEXIST') throw e
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
    }
  }
  throw new Error(`Could not acquire lock ${lockPath} after ${LOCK_MAX_RETRIES} retries. If a previous process was SIGKILL'd, run: rm -f ${lockPath}`)
}
function releaseLock(lockPath) {
  try { fs.unlinkSync(lockPath) } catch (_) {}
}

const VALID_STATUSES = ['TODO', 'DONE', 'BLOCKED']

// Valid transitions: [from][to] = true means allowed
const ALLOWED = {
  TODO:    { DONE: true, BLOCKED: true },
  BLOCKED: { TODO: true },
  DONE:    {},
}

function die(msg) {
  process.stderr.write(`update-status: ${msg}\n`)
  process.exit(1)
}

const args = process.argv.slice(2)
let featureId = null
let newStatus = null

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--feature') featureId = args[++i]
  else if (args[i] === '--status') newStatus = args[++i]
}

if (!featureId) die('--feature <id> is required')
if (!newStatus) die('--status <TODO|DONE|BLOCKED> is required')
if (!VALID_STATUSES.includes(newStatus)) die(`invalid status "${newStatus}"; must be one of ${VALID_STATUSES.join(', ')}`)

const featuresPath = path.join(process.cwd(), 'harness', 'features.json')
const lockPath = featuresPath + '.lock'

acquireLock(lockPath)
// process.exit() (called by die()) bypasses finally blocks in Node.js.
// Register a process-exit handler to guarantee lock release even on die().
process.on('exit', () => releaseLock(lockPath))
try {
  let data
  try {
    data = JSON.parse(fs.readFileSync(featuresPath, 'utf8'))
  } catch (e) {
    die(`could not read ${featuresPath}: ${e.message}`)
  }

  const feature = data.find(f => f.id === featureId)
  if (!feature) die(`feature "${featureId}" not found in features.json`)

  const currentStatus = feature.status

  if (currentStatus === newStatus) {
    die(`feature "${featureId}" is already ${currentStatus}`)
  }

  if (!ALLOWED[currentStatus] || !ALLOWED[currentStatus][newStatus]) {
    die(`cannot transition "${featureId}" from ${currentStatus} → ${newStatus}`)
  }

  // Atomic write: write to .tmp then rename
  const tmpPath = featuresPath + '.tmp'
  feature.status = newStatus
  const serialized = JSON.stringify(data, null, 2) + '\n'
  try {
    fs.writeFileSync(tmpPath, serialized, 'utf8')
    fs.renameSync(tmpPath, featuresPath)
  } catch (e) {
    die(`write failed: ${e.message}`)
  }

  // Verify the write landed
  let verified
  try {
    const readBack = JSON.parse(fs.readFileSync(featuresPath, 'utf8'))
    const f = readBack.find(f => f.id === featureId)
    verified = f && f.status === newStatus
  } catch (e) {
    die(`verification read failed: ${e.message}`)
  }

  if (!verified) die(`verification failed: status did not persist for "${featureId}"`)

  process.stdout.write(`Updated ${featureId}: ${currentStatus} → ${newStatus}\n`)
} finally {
  releaseLock(lockPath)
}
process.exit(0)
