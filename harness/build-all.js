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
    `Run this command in the project root:
node -e "const fs=require('fs'),p='harness/features.json',d=JSON.parse(fs.readFileSync(p,'utf8'));const blocked=d.filter(f=>f.status==='BLOCKED');blocked.forEach(f=>{f.status='TODO';const sp='harness/stuck/'+f.id+'_stuck_reason.md';if(fs.existsSync(sp)){fs.unlinkSync(sp);}});fs.writeFileSync(p,JSON.stringify(d,null,2)+'\\n');console.log('Reset '+blocked.length+' feature(s): '+blocked.map(f=>f.id).join(', '));"`,
    { label: 'retry-blocked-reset', phase: 'Build' }
  )
}

// Default 5M output-token cap; override per-run with args: { maxTokens: N }
const budgetCap = (args && args.maxTokens) || 5_000_000

while (true) {
  // Hard stop when the accumulated output token count hits the cap
  if (budgetCap && budget.spent() >= budgetCap) {
    log(`Token cap reached (${budget.spent().toLocaleString()} / ${budgetCap.toLocaleString()}) — stopping.`)
    break
  }
  // Guard for +Nk prompt directive: stop before starting a new feature if < 50k remain
  if (budget.total && budget.remaining() < 50_000) {
    log(`Low budget (${Math.round(budget.remaining() / 1000)}k remaining) — stopping before next feature.`)
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

return { completed, blocked: blockedFeatures }
