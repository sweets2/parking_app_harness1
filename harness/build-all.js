export const meta = {
  name: 'build-all',
  description: 'Build all TODO features in dependency order until done or nothing remains buildable',
  phases: [{ title: 'Build' }],
}

phase('Build')

const stopOnBlocked = args && args.stopOnBlocked === true
const retryBlocked  = args && args.retryBlocked  === true
const maxParallel   = (args && args.maxParallel)  || 3

let completed = 0
const blockedFeatures = []
const specFixAttempts = {}
const MAX_SPEC_FIX_ATTEMPTS = 2

const FRONT_MATTER_SCHEMA = {
  type: 'object',
  required: ['features'],
  properties: {
    features: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'status', 'order', 'depends_on', 'output_files'],
        properties: {
          id:           { type: 'string' },
          name:         { type: 'string' },
          status:       { type: 'string' },
          order:        { type: 'number' },
          depends_on:   { type: 'array', items: { type: 'string' } },
          output_files: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
}

if (retryBlocked) {
  log('retryBlocked=true — resetting all BLOCKED features to TODO...')
  await agent(
    `In the project root, reset all BLOCKED features to TODO using update-status.js.
Steps:
1. Read harness/features.json and collect the ids of all features where status === "BLOCKED".
2. For each id, run: node harness/update-status.js --feature <id> --status TODO
3. For each id, run: rm -f harness/stuck/<id>_stuck_reason.md
Log each command and its output.`,
    { label: 'retry-blocked-reset', phase: 'Build' }
  )
}

// Single token cap: +Nk harness directive > args.maxTokens > 5M default
const tokenCap = budget.total ?? (args && args.maxTokens) ?? 5_000_000

// ── Pre-loop setup ────────────────────────────────────────────────────────────

// Read features.json once; each wave passes this snapshot to child workflows
// so they skip their own read-features-json agent call (§4a shortcut in workflow.js).
let featuresData = await agent(
  'Read harness/features.json and return its parsed contents as a JSON object with a "features" key containing the array. Return only the JSON object, no prose.',
  { schema: FRONT_MATTER_SCHEMA, label: 'read-features-initial', phase: 'Build' }
)
if (!featuresData) {
  log('Failed to read features.json — aborting.')
  return { completed, blocked: blockedFeatures, budgetSpent: budget.spent() }
}
let features = [...featuresData.features].sort((a, b) => (a.order || 999) - (b.order || 999))

// npm install once before any verifiers run — prevents concurrent installs when wave > 1.
await agent(
  'Run: cd generated_app && (test -d node_modules || npm install)\nCapture and report output.',
  { label: 'npm-install', phase: 'Build' }
)

// ── Wave selection ────────────────────────────────────────────────────────────

// Returns up to maxParallel features from the ready queue with no output-file conflicts.
// Greedy: iterate in dependency order, skip any feature whose output_files overlap with
// files already claimed by a feature already in the wave.
function buildWave(features, maxPar) {
  const doneIds = new Set(features.filter(f => f.status === 'DONE').map(f => f.id))
  const ready = features.filter(f =>
    f.status === 'TODO' && (f.depends_on || []).every(d => doneIds.has(d))
  )
  const waveFiles = new Set()
  const wave = []
  for (const f of ready) {
    if ((f.output_files || []).some(file => waveFiles.has(file))) continue
    wave.push(f)
    ;(f.output_files || []).forEach(file => waveFiles.add(file))
    if (wave.length >= maxPar) break
  }
  return wave
}

// ── Main loop ─────────────────────────────────────────────────────────────────

while (true) {
  const wave = buildWave(features, maxParallel)

  if (wave.length === 0) {
    // No ready TODO features — check for fixable blocked specs before halting.
    const fixableBlocked = blockedFeatures.filter(id => (specFixAttempts[id] || 0) < MAX_SPEC_FIX_ATTEMPTS)
    if (fixableBlocked.length > 0 && !stopOnBlocked) {
      log(`No immediately buildable features, but ${fixableBlocked.length} blocked feature(s) may be fixable. Attempting auto spec-fix...`)
      // Fix all fixable blocked features in parallel (each has disjoint spec/stuck files).
      const fixResults = await parallel(
        fixableBlocked.map(featureId => () => {
          const attempts = specFixAttempts[featureId] || 0
          log(`Auto-fixing spec for ${featureId} (attempt ${attempts + 1}/${MAX_SPEC_FIX_ATTEMPTS})...`)
          return agent(
            `A feature spec has quality issues that blocked it before the Creator ran.
Your job: read the stuck reason, fix the spec and features.json entry, then reset the feature to TODO so it can be retried.

Steps:
1. Read harness/stuck/${featureId}_stuck_reason.md — understand each [ERROR] and [WARNING] issue
2. Read specs/${featureId}.md — understand the current spec
3. Read harness/features.json — check the feature's context_files and output_files
4. Read the relevant section of CLAUDE.md (hard constraints)
5. Fix ALL [ERROR] issues:
   - Missing TypeScript signatures → add complete signatures with parameter names and types
   - Vague THEN clauses (no concrete expected value) → replace with specific values, counts, or string literals
   - CLAUDE.md violations (e.g. side effects in app.ts, setInterval in app.ts) → restructure to comply
   - Exported functions with no test coverage → add GIVEN/WHEN/THEN test cases
   - Files referenced in tests but missing from output_files or context_files → update features.json
6. Fix [WARNING] issues where the fix is clear and unambiguous
7. Run: node harness/update-status.js --feature ${featureId} --status TODO
8. Run: rm -f harness/stuck/${featureId}_stuck_reason.md
Return: { featureId: "${featureId}", fixed: true } if you made changes and reset to TODO; { featureId: "${featureId}", fixed: false } if the issues could not be resolved.`,
            {
              label: `spec-fix:${featureId}`,
              phase: 'Build',
              schema: {
                type: 'object',
                required: ['featureId', 'fixed'],
                properties: {
                  featureId: { type: 'string' },
                  fixed: { type: 'boolean' },
                },
              },
            }
          )
        })
      )

      let anyFixed = false
      for (const res of (fixResults || [])) {
        if (!res) continue
        const { featureId, fixed } = res
        specFixAttempts[featureId] = (specFixAttempts[featureId] || 0) + 1
        if (fixed) {
          const idx = blockedFeatures.indexOf(featureId)
          if (idx !== -1) blockedFeatures.splice(idx, 1)
          log(`Spec fixed for ${featureId} — retrying in next wave.`)
          anyFixed = true
        } else {
          log(`Could not auto-fix spec for ${featureId} after attempt ${specFixAttempts[featureId]} — leaving blocked.`)
        }
      }

      if (anyFixed) {
        // Re-read features.json to pick up any TODO resets made by spec-fix agents.
        const refreshed = await agent(
          'Read harness/features.json and return its parsed contents as a JSON object with a "features" key.',
          { schema: FRONT_MATTER_SCHEMA, label: 're-read-after-spec-fix', phase: 'Build' }
        )
        if (refreshed) features = [...refreshed.features].sort((a, b) => (a.order || 999) - (b.order || 999))
        continue
      }
    }

    log(`Build complete. ${completed} feature(s) done, ${blockedFeatures.length} blocked.`)
    break
  }

  // Token budget gate: reserve 300k per wave member (mutation features include baseline + re-run).
  if (budget.spent() >= tokenCap - wave.length * 300_000) {
    log(`Near token cap (${budget.spent().toLocaleString()} / ${tokenCap.toLocaleString()}) — stopping.`)
    break
  }

  log(`Wave: [${wave.map(f => f.id).join(', ')}] (${wave.length} feature${wave.length > 1 ? 's' : ''})`)

  // Dispatch all features in the wave concurrently.
  // Each child workflow receives the current features snapshot (args.features) so it can
  // skip its own read-features-json agent call.
  const waveResults = await parallel(
    wave.map(f => () => workflow({ scriptPath: 'harness/workflow.js' }, { feature: f.id, features }))
  )

  for (const result of (waveResults || [])) {
    if (!result) {
      log('A wave member returned null (agent death) — treating as BLOCKED.')
      continue
    }
    if (result.success) {
      completed++
      log(`[${completed} done] ${result.feature} PASS`)
    }
    if (result.blocked) {
      const featureId = result.feature
      blockedFeatures.push(featureId)
      log(`${featureId} BLOCKED (${blockedFeatures.length} total blocked)`)
      if (stopOnBlocked) {
        log('stopOnBlocked=true — halting.')
        break
      }
    }
    if (result.done) {
      // Inner workflow found no buildable feature — shouldn't happen in wave mode
      // since we selected targets explicitly, but handle gracefully.
      log(`workflow() returned done=true for ${result.feature ?? '(unknown)'} — skipping.`)
    }
  }

  if (stopOnBlocked && blockedFeatures.length > 0) break

  // Re-read features.json after each wave to get ground truth from disk.
  // Guards against silent update-status failures where in-memory state would diverge.
  const refreshed = await agent(
    'Read harness/features.json and return its parsed contents as a JSON object with a "features" key.',
    { schema: FRONT_MATTER_SCHEMA, label: 're-read-post-wave', phase: 'Build' }
  )
  if (refreshed) features = [...refreshed.features].sort((a, b) => (a.order || 999) - (b.order || 999))
}

const finalBudget = budget.spent()
log(`Total output tokens (budget.spent): ${finalBudget.toLocaleString()} — run complete-build-record.js with task notification data to record true subagentTokens.`)
await agent(
  `Run this exact bash command and report the output:
node harness/write-build-record.js --budget-spent ${finalBudget} --completed ${completed} --blocked '${JSON.stringify(blockedFeatures)}'`,
  { label: 'write-build-record', phase: 'Build' }
)

return { completed, blocked: blockedFeatures, budgetSpent: finalBudget }
