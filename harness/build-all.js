export const meta = {
  name: 'build-all',
  description: 'Build all TODO features in dependency order until done or nothing remains buildable',
  phases: [{ title: 'Build' }],
}

phase('Build')

const stopOnBlocked = args && args.stopOnBlocked === true
const retryBlocked = args && args.retryBlocked === true
let completed = 0
const blockedFeatures = []

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

while (true) {
  if (budget.spent() >= tokenCap - 150_000) {
    log(`Near token cap (${budget.spent().toLocaleString()} / ${tokenCap.toLocaleString()}) — stopping.`)
    break
  }

  const result = await workflow({ scriptPath: 'harness/workflow.js' })

  if (!result) {
    log('Inner workflow returned null — aborting.')
    break
  }

  if (result.done) {
    log(`Build complete. ${completed} feature(s) done, ${blockedFeatures.length} blocked.`)
    break
  }

  if (result.success) {
    completed++
    log(`[${completed} done] ${result.feature} PASS`)
  }

  if (result.blocked) {
    blockedFeatures.push(result.feature)
    log(`${result.feature} BLOCKED (${blockedFeatures.length} total blocked)`)
    if (stopOnBlocked) {
      log('stopOnBlocked=true — halting.')
      break
    }
  }
}

const finalBudget = budget.spent()
log(`Total output tokens (budget.spent): ${finalBudget.toLocaleString()} — run complete-build-record.js with task notification data to record true subagentTokens.`)
await agent(
  `Run this exact bash command and report the output:
node harness/write-build-record.js --budget-spent ${finalBudget} --completed ${completed} --blocked '${JSON.stringify(blockedFeatures)}'`,
  { label: 'write-build-record', phase: 'Build' }
)

return { completed, blocked: blockedFeatures, budgetSpent: finalBudget }
