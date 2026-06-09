export const meta = {
  name: 'parking-feature-builder',
  description: 'Builds one parking app feature using the creator/evaluator loop',
  phases: [
    { title: 'Setup',    detail: 'Read spec front matter, select target, assemble context' },
    { title: 'Validate', detail: 'Check spec is well-formed, has test cases, and passes quality lint' },
    { title: 'Baseline', detail: 'Run owning feature tests before mutation to record regression baseline' },
    { title: 'Create',   detail: 'Creator agent writes tests then implementation' },
    { title: 'Verify',   detail: 'Run npm test and npm run typecheck' },
    { title: 'Evaluate', detail: 'Evaluator issues PASS / NEEDS-REVISION / FAIL' },
    { title: 'Update',   detail: 'Write outcome to spec front matter' },
  ],
}

// ─── Schemas ────────────────────────────────────────────────────────────────

const TEST_SCHEMA = {
  type: 'object',
  required: ['testsPassed', 'typecheckPassed', 'testOutput', 'typecheckOutput'],
  properties: {
    // Feature-specific run (new feature's test files only)
    featureTestsPassed:  { type: 'boolean', description: 'True if the new feature\'s own test files all pass; omit if no feature test files' },
    featureTestOutput:   { type: 'string' },
    featurePassedCount:  { type: 'number' },
    featureFailedCount:  { type: 'number' },
    featureTestFailures: { type: 'array', items: { type: 'object', properties: { test: { type: 'string' }, error: { type: 'string' } } } },
    // Full suite run (catches regressions in other features)
    testsPassed:     { type: 'boolean' },
    typecheckPassed: { type: 'boolean' },
    testOutput:      { type: 'string' },
    typecheckOutput: { type: 'string' },
    passedCount:     { type: 'number', description: 'Number of passing tests in full suite' },
    failedCount:     { type: 'number', description: 'Number of failing tests in full suite' },
    testFailures:    { type: 'array', description: 'One entry per failing test in full suite', items: {
      type: 'object',
      properties: {
        test:  { type: 'string', description: 'Full test name / description' },
        error: { type: 'string', description: 'Assertion or thrown error message' },
      },
    }},
    typecheckErrors: { type: 'array', description: 'One entry per TypeScript error line', items: { type: 'string' } },
  },
}

// Formats test results for display in evaluator/reviser prompts.
// Separates feature test failures from regression failures so agents don't conflate them.
function fmtTestResults(r) {
  const hasFeatureRun = r.featureTestsPassed != null
  const regressionOnly = hasFeatureRun && r.featureTestsPassed && !r.testsPassed
  const featureLine = hasFeatureRun
    ? `${r.featureTestsPassed ? 'PASS ✓' : 'FAIL ✗'} (${r.featurePassedCount ?? '?'} passed, ${r.featureFailedCount ?? '?'} failed)`
    : 'skipped (no feature test files)'
  const suiteSuffix = regressionOnly ? '  ← REGRESSION (feature tests pass; failure is in another feature\'s tests)' : ''
  const lines = [
    `Feature tests: ${featureLine}`,
    `Full suite:    ${r.testsPassed ? 'PASS ✓' : 'FAIL ✗'} (${r.passedCount ?? '?'} passed, ${r.failedCount ?? '?'} failed)${suiteSuffix}`,
    `Typecheck:     ${r.typecheckPassed ? 'PASS ✓' : 'FAIL ✗'}`,
  ]
  if (r.featureTestFailures && r.featureTestFailures.length > 0) {
    lines.push('\nFEATURE TEST FAILURES:')
    r.featureTestFailures.forEach(f => lines.push(`  ✗ ${f.test}\n    ${f.error}`))
  }
  if (r.testFailures && r.testFailures.length > 0) {
    lines.push(regressionOnly
      ? '\nREGRESSION FAILURES (in another feature\'s tests — the new feature is not the cause):'
      : '\nFULL SUITE FAILURES:')
    r.testFailures.forEach(f => lines.push(`  ✗ ${f.test}\n    ${f.error}`))
  }
  if (r.typecheckErrors && r.typecheckErrors.length > 0) {
    lines.push('\nTYPECHECK ERRORS:')
    r.typecheckErrors.forEach(e => lines.push(`  ${e}`))
  }
  return lines.join('\n')
}

// When a mutation feature's revision introduces a regression, attribute it clearly.
// Returns empty string if: no baseline was recorded, baseline already failed, or no regression occurred.
function fmtRegressionAttribution(baseline, currentResult, owningFiles) {
  if (!baseline || !baseline.passed || currentResult.testsPassed) return ''
  const lines = [
    '\n=== REGRESSION ATTRIBUTION ===',
    `Owning test files: ${owningFiles.join(', ')}`,
    `Before your changes: PASS ✓ (${baseline.passedCount} passed)`,
    `After your changes:  FAIL ✗ (${currentResult.failedCount ?? '?'} failed)`,
    '',
    'These tests passed before this feature ran and fail after. The regression is in what you added.',
    'Fix only your new additions. Do NOT touch the existing code that was already passing.',
  ]
  if (currentResult.testFailures && currentResult.testFailures.length > 0) {
    lines.push('\nNow-failing tests:')
    currentResult.testFailures.forEach(f => lines.push(`  ✗ ${f.test}\n    ${f.error}`))
  }
  return lines.join('\n')
}

// Strips sections from contextContent whose file paths overlap with outputFiles.
// Output files are already provided fresh in the "CURRENT IMPLEMENTATION" block of the
// Reviser prompt, so keeping a stale copy in the context block would give the Reviser
// two contradictory versions of the same file. This deduplication ensures each file
// appears in exactly one place — the fresh writtenFiles block wins.
function filterContextForReviser(contextContent, outputFiles) {
  if (!contextContent || outputFiles.length === 0) return contextContent
  const outputSet = new Set(outputFiles)
  // Split on section headers: "=== FILE: <path> ==="
  const sections = contextContent.split(/(=== FILE: [^\n]+ ===)/)
  const kept = []
  let i = 0
  while (i < sections.length) {
    const header = sections[i]
    const headerMatch = header.match(/^=== FILE: (.+?) ===/)
    if (!headerMatch) {
      // Leading text before the first header (e.g. "(no context files)")
      kept.push(header)
      i++
      continue
    }
    const filePath = headerMatch[1].trim()
    const body = sections[i + 1] ?? ''
    if (!outputSet.has(filePath)) {
      kept.push(header)
      kept.push(body)
    }
    i += 2
  }
  const result = kept.join('')
  return result.trim() || '(all context files are covered by the current implementation block)'
}

// Marks a feature BLOCKED, writes its stuck-reason file, and optionally appends metrics.
// metricsRecord: pre-built JSON string to append to metrics.jsonl (omit for early exits).
// label: optional suffix appended to agent label (e.g. 'lint' → 'finalize-blocked-lint').
// Returns the standard { blocked: true, feature, reason, ...extra } result object.
async function blockFeature(featureId, stuckContent, { metricsRecord = null, label = '', phase, reason, ...returnExtra }) {
  const labelSuffix = label ? `-${label}` : ''
  const stuckPath = `harness/stuck/${featureId}_stuck_reason.md`
  const metricsCmd = metricsRecord
    ? `node harness/finalize-run.js --feature ${featureId} --status BLOCKED --write-metrics <<'METRICS_EOF'
${metricsRecord}
METRICS_EOF`
    : `node harness/finalize-run.js --feature ${featureId} --status BLOCKED`
  await agent(
    `Run these commands in sequence in the project root:

${metricsCmd}

mkdir -p harness/stuck
cat > ${stuckPath} <<'STUCK_CONTENT_END'
${stuckContent}
STUCK_CONTENT_END`,
    { label: `finalize-blocked${labelSuffix}`, phase }
  )
  return { blocked: true, feature: featureId, reason, ...returnExtra }
}

const FILE_HASHES_SCHEMA = {
  type: 'object',
  required: ['hashes'],
  properties: { hashes: { type: 'string' } },
}

const VERDICT_SCHEMA = {
  type: 'object',
  required: ['result', 'brief', 'failures'],
  properties: {
    result:   { type: 'string', enum: ['PASS', 'NEEDS-REVISION', 'FAIL'] },
    brief:    { type: 'string' },
    failures: { type: 'array', items: { type: 'string' } },
  },
}

const PRE_EVAL_VALIDATION_SCHEMA = {
  type: 'object',
  required: ['passed', 'output'],
  properties: {
    passed: { type: 'boolean' },
    output: { type: 'string' },
  },
}

const FRONT_MATTER_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    required: ['id', 'name', 'status', 'order', 'depends_on', 'context_files', 'output_files'],
    properties: {
      id:                { type: 'string' },
      name:              { type: 'string' },
      status:            { type: 'string' },
      order:             { type: 'number' },
      depends_on:        { type: 'array', items: { type: 'string' } },
      context_files:     { type: 'array', items: { type: 'string' } },
      output_files:      { type: 'array', items: { type: 'string' } },
      post_build_command: { type: 'string' },
      pre_eval_command:   { type: 'string' },
      run_tests:          { type: 'boolean' },
    },
  },
}

const BASELINE_SCHEMA = {
  type: 'object',
  required: ['passed', 'passedCount', 'failedCount'],
  properties: {
    passed:       { type: 'boolean' },
    passedCount:  { type: 'number' },
    failedCount:  { type: 'number' },
    testFailures: { type: 'array', items: {
      type: 'object',
      properties: {
        test:  { type: 'string' },
        error: { type: 'string' },
      },
    }},
  },
}

const STATIC_READS_SCHEMA = {
  type: 'object',
  required: ['claudeMd', 'featureSpec'],
  properties: {
    claudeMd:    { type: 'string' },
    featureSpec: { type: 'string' },
  },
}

const PREFLIGHT_SCHEMA = {
  type: 'object',
  required: ['verdict', 'issues'],
  properties: {
    verdict: { type: 'string', enum: ['PASS', 'WARN', 'BLOCK'] },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        required: ['severity', 'text'],
        properties: {
          severity: { type: 'string', enum: ['ERROR', 'WARNING'] },
          text:     { type: 'string' },
        },
      },
    },
  },
}

// ─── Prompt templates (embedded) ────────────────────────────────────────────
// These are static across all features. Embedding them eliminates 3 agent reads
// per run. To change agent persona or output format, edit these strings.

const CREATOR_TEMPLATE = `# Creator Agent Instructions

You are implementing ONE feature. Your only output is the files listed under EXPECTED OUTPUT FILES. Write each file in the correct format for its extension (.ts, .html, .css, .yml, .md, .json, etc.). Do not produce explanatory prose, markdown summaries, or any text output — only write the files.

---

## Your process — follow this order exactly

1. **Read the feature spec** — understand the module contract, function signatures, behavioral contracts, and test list before writing a single line.
2. **Read CLAUDE.md** (provided under PROJECT PROCESS AND CONSTRAINTS) — it contains the hard constraints and architecture rules for this project. They are non-negotiable.
3. **Write tests first** — one test per Given/When/Then in the spec. Tests must be written before the implementation exists. Do not skip this step. (Skip this step for discovery features that produce documentation, not code.)
4. **Write the implementation** — make the tests pass. Do not change the tests to make a broken implementation pass.
5. **Write all files to disk** using the Write or Edit tools.

---

## What you receive below

1. **PROJECT PROCESS AND CONSTRAINTS (CLAUDE.md)** — the authoritative rules for this project. Read this before anything else.
2. **The feature spec** (from FEATURES.md) — what to build.
3. **Context files** — existing source files you must understand before writing.

Read all three carefully before writing a single line.`

const EVALUATOR_TEMPLATE = `# Evaluator Agent Instructions

You are an independent evaluator. You did not write the code you are reviewing and you have not seen the creator's reasoning — only the output files and the test results. Your job is to issue one verdict: \`PASS\`, \`NEEDS-REVISION\`, or \`FAIL\`.

You are the quality gate. Be strict. A feature that silently ignores a spec requirement is a \`FAIL\`, not a \`PASS\`.

---

## Verdict definitions

**PASS** — All of the following are true:
- Every Given/When/Then test case in the spec has a corresponding test (for code features) or the documentation is complete (for discovery features)
- For TypeScript features: \`npm test\` passed (all tests green) and \`npm run typecheck\` passed (zero TypeScript errors in \`.ts\` files)
- All project hard constraints from CLAUDE.md are met for the relevant file types
- No spec requirement is silently omitted
- All expected output files exist

**NEEDS-REVISION** — Tests pass and typecheck passes, but one or more of:
- A minor spec requirement is incomplete or subtly wrong
- A hard constraint is technically met but the implementation is fragile
- A test exists but tests the wrong thing (wrong assertion, wrong input)
- A documentation file exists but is incomplete or vague

**FAIL** — One or more of:
- \`npm test\` failed (any test red) — for TypeScript features only
- \`npm run typecheck\` failed (any \`.ts\` error) — for TypeScript features only
- A project hard constraint from CLAUDE.md is violated
- A Given/When/Then case from the spec has no test at all (missing, not just weak)
- An expected output file is missing entirely
- A documentation feature is missing key required information from the spec

---

## Hard constraints to check

Apply these based on the file types present in the output. Do not penalize a \`.css\`, \`.html\`, or \`.md\` file for TypeScript rules.

**TypeScript files (\`.ts\`) — always check:**
1. No \`as any\` casts anywhere
2. No \`!\` non-null assertion operator anywhere
3. All exported symbols use named exports — no default exports
4. All additional constraints documented in CLAUDE.md for the relevant file types and modules

**Non-TypeScript files — check against the spec's stated requirements:**
- \`.html\`: required elements, IDs, attributes, and script tags are present
- \`.css\`: required selectors and layout rules are present
- \`.yml\`: valid syntax and required keys/structure per spec
- \`.md\`: all required sections and information are present and non-trivially stated

---

## How to evaluate

1. Read the project constraints in CLAUDE.md (provided above)
2. Read every output file listed under \`=== IMPLEMENTATION ===\`
3. Identify which file types are present and apply the appropriate constraints
4. Check each Given/When/Then in the spec — does a test or documented fact exist for it?
5. Review the test output (if provided) — are failures from missing implementation or wrong tests?
6. If typecheck failed, identify which \`.ts\` error relates to which CLAUDE.md constraint

---

## Output format

Your verdict must be structured output with three fields:

- \`result\`: exactly one of \`"PASS"\`, \`"NEEDS-REVISION"\`, or \`"FAIL"\`
- \`brief\`: one to three sentences summarizing the verdict. If PASS, state what was verified. If NEEDS-REVISION or FAIL, state exactly what is wrong.
- \`failures\`: array of strings, one per failing item. Empty array if PASS. Each string names the spec item or constraint that failed and why.

Be specific. "Tests fail" is not useful. "F-03.6: no test for the radiusMeters = 0 edge case" is useful.`

const REVISER_TEMPLATE = `# Reviser Agent Instructions

You are a Reviser agent. The Creator wrote an implementation that the Evaluator rejected. Your job is to patch exactly what failed — no more, no less.

You are a surgeon, not a rewriter. The existing code is your starting point; fix what broke and leave everything else alone.

---

## Rules

1. **Patch, don't rewrite** — Change only what the evaluator flagged. If the overall structure is sound, preserve it. Do not rewrite from scratch unless the implementation is fundamentally wrong.
2. **Never break passing tests** — Do not modify a test that is currently green. If a passing test appears to conflict with a fix, re-read the spec; the spec is authoritative.
3. **All CLAUDE.md constraints still apply** — No \`as any\`, no \`!\` non-null assertions, named exports only, and all module-specific rules documented under Hard constraints.
4. **Write changed files to disk** — Use Write or Edit tools. No prose output.

---

## What you receive

1. **PROJECT PROCESS AND CONSTRAINTS (CLAUDE.md)** — hard constraints and architecture rules. Non-negotiable.
2. **CONTEXT FILES** — the same source files the Creator read; use these to understand the types and APIs your patch must conform to.
3. **CURRENT IMPLEMENTATION** — the files currently on disk. Patch these.
4. **EVALUATOR VERDICT** — the specific failures you must fix.
5. **TEST RESULTS** — failing test names and error messages; typecheck errors with file and line.
6. **AUTHORITATIVE FEATURE SPEC** — use this to verify your fix is correct, not just "not failing".`

const SPEC_LINTER_TEMPLATE = `# Spec Quality Linter

You are a pre-flight linter. Read the feature spec and CLAUDE.md constraints below and return a structured verdict.

## Your job

Check the spec for problems that will predictably cause the Creator to fail or require revision. Be pragmatic — flag real structural gaps, not stylistic preferences.

## BLOCK conditions (severity: ERROR — return verdict: "BLOCK" if any apply)

1. An exported function named in the spec has no TypeScript signature (parameter names, types, return type all missing).
2. A THEN clause contains only vague language with no concrete expected value — e.g. "should return a valid result", "truthy", "non-null", "something sensible". A concrete value is a specific type, literal, array shape, or named constant.
3. The spec explicitly requires something that CLAUDE.md prohibits for this module type — e.g. calling \`new Date()\` inside a pure logic module (\`shared/parking-logic.ts\`), accessing \`localStorage\` at module scope in \`shared/storage.ts\`, or importing \`L.*\` (Leaflet) outside \`app/map.ts\`.
4. The number of Given/When/Then test cases is fewer than the number of exported functions described in the spec (some exported functions have no test coverage at all).

## WARN conditions (severity: WARNING — return verdict: "WARN" if any apply but none are BLOCK)

1. A behavioral description mentions an edge case that has no corresponding Given/When/Then test.
2. Tests involve time-sensitive logic but don't reference fixture constants (e.g. \`NOW_STABLE\`, \`NOW_AFTER_EXPIRED\`, \`FETCH_TIME\`) — instead using literal dates or calling \`new Date()\` in test assertions.
3. This is a mutation feature (output_files includes a file already owned by another feature) but the spec does not state what existing behavior is preserved vs changed.
4. A function's behavioral description is ambiguous enough that two different, reasonable implementations could both claim to satisfy it.

## Output rules

- Return \`"PASS"\` with empty issues array if none of the above apply.
- Return \`"WARN"\` with WARNING-severity issues if only warnings triggered.
- Return \`"BLOCK"\` with ERROR-severity issues (include any WARNINGs too) if any BLOCK condition triggered.
- Be specific in issue text: name the function, the test case, or the exact clause that is problematic.`

// ─── Phase 1: Setup ─────────────────────────────────────────────────────────

phase('Setup')

const requestedFeature = args && args.feature ? String(args.feature) : null

// Step 1: Read all spec front matter (one agent call)
const allFrontMatter = await agent(
  `Read the file harness/features.json and return its parsed contents as a JSON array. Return only the JSON array, no prose.`,
  { schema: FRONT_MATTER_SCHEMA, label: 'read-features-json', phase: 'Setup' }
)

// Step 2: Select target feature — pure JS, deterministic
const features = [...allFrontMatter].sort((a, b) => (a.order || 999) - (b.order || 999))

let target
if (requestedFeature) {
  target = features.find(f => f.id === requestedFeature)
  if (!target) {
    log(`Feature ${requestedFeature} not found in specs/`)
    return { done: true, reason: `Feature ${requestedFeature} not found in specs/` }
  }
  const unmetDeps = (target.depends_on || []).filter(depId => {
    const dep = features.find(f => f.id === depId)
    return !dep || dep.status !== 'DONE'
  })
  if (unmetDeps.length > 0) {
    log(`Blocked: unmet dependencies: ${unmetDeps.join(', ')}`)
    return { done: true, reason: `Unmet deps: ${unmetDeps.join(', ')}` }
  }
  if (args && args.retry === true && target.status === 'BLOCKED') {
    log(`Retrying BLOCKED feature ${target.id} — resetting to TODO`)
    await agent(
      `Run: node harness/finalize-run.js --feature ${target.id} --status TODO --cleanup-stuck`,
      { label: `retry-reset:${target.id}`, phase: 'Setup' }
    )
  }
} else {
  target = features.find(f => {
    if (f.status !== 'TODO') return false
    return (f.depends_on || []).every(depId => {
      const dep = features.find(d => d.id === depId)
      return dep && dep.status === 'DONE'
    })
  })
  if (!target) {
    log('No buildable features found. All done or all blocked.')
    return { done: true, reason: 'No buildable features found' }
  }
}

// Step 3: Extract scalar fields from target — pure JS
const targetId         = target.id
const targetName       = target.name
const outputFiles      = target.output_files || []
const postBuildCommand = target.post_build_command || null
const preEvalCommand   = target.pre_eval_command   || null
const runTests         = target.run_tests !== false
const contextFilePaths = target.context_files || []

log(`Target: ${targetId} — ${targetName}`)
log(`Output files expected: ${outputFiles.join(', ')}`)
log(`Tokens spent: ${budget.spent().toLocaleString()}`)

const featureTestFiles = outputFiles.filter(f => f.startsWith('tests/'))

// Detect mutation features: output files this feature modifies that were already written by a DONE feature.
// Pure JS — no agent call needed.
const mutatedFiles = outputFiles.filter(file =>
  features.some(f => f.status === 'DONE' && (f.output_files || []).includes(file))
)
// Find the test files owned by the features that first wrote those files.
const owningTestFiles = []
for (const mutatedFile of mutatedFiles) {
  const owner = features.find(f => f.status === 'DONE' && (f.output_files || []).includes(mutatedFile))
  if (owner) {
    for (const tf of (owner.output_files || []).filter(f => f.startsWith('tests/'))) {
      if (!owningTestFiles.includes(tf)) owningTestFiles.push(tf)
    }
  }
}
const isMutationFeature = mutatedFiles.length > 0 && owningTestFiles.length > 0

const tokensAtStart    = budget.spent()
const metricVerdicts   = []   // e.g. ["FAIL", "NEEDS-REVISION", "PASS"]
const metricTestRuns   = []   // {revision, passed, failed, typecheckPassed} per test run
const metricFailures   = []   // all evaluator failure strings, accumulated

// Step 4: Read CLAUDE.md + spec in one structured call; context files in parallel.
// Prompt templates are embedded constants above — no agent reads needed for them.
const [staticReads, contextContent] = await parallel([
  () => agent(
    `Read two files and return their exact full contents — do not summarize or paraphrase either.
File 1: CLAUDE.md → return as the "claudeMd" field.
File 2: specs/${targetId}.md → return as the "featureSpec" field.`,
    { schema: STATIC_READS_SCHEMA, label: `read-static:${targetId}`, phase: 'Setup' }
  ),
  () => contextFilePaths.length > 0
    ? agent(
        `Read the following files and concatenate their contents.
Format each file as:
=== FILE: <path> ===
<full file contents>

If a file does not exist yet, write:
=== FILE: <path> === (FILE NOT YET CREATED)

Files to read:
${contextFilePaths.join('\n')}`,
        { label: `read-context:${targetId}`, phase: 'Setup' }
      )
    : Promise.resolve('(no context files for this feature)'),
])
const featureSpec = staticReads.featureSpec
const agentMd     = staticReads.claudeMd

// Filtered views of CLAUDE.md for agents that only need specific sections.
// The spec linter and evaluator don't need the pipeline description, dependency
// tables, or context-to-load table — only the constraints they enforce.
const _hcStart          = agentMd.indexOf('\n## Hard constraints')
const _hcEnd            = agentMd.indexOf('\n## ', _hcStart + 1)
const hardConstraintsOnly = agentMd.slice(_hcStart, _hcEnd)

// Evaluator also gets Known gotchas — needed to correctly judge feature-specific
// implementation choices (e.g. F-01.9's Webflow CSS selectors).
const _gotchasStart = agentMd.indexOf('\n## Known gotchas')
const _gotchasEnd   = agentMd.indexOf('\n## ', _gotchasStart + 1)
const evalMd        = hardConstraintsOnly + agentMd.slice(_gotchasStart, _gotchasEnd)

// ─── Phase 1.5: Validate Spec ───────────────────────────────────────────────

phase('Validate')

if (!runTests) {
  log('Discovery feature — skipping spec validation')
} else {
  const issues = []
  if (!featureSpec || featureSpec.trim().length < 50) issues.push('Spec appears empty or truncated')
  if (!/\b(Given|When|Then)\b/i.test(featureSpec))   issues.push('No Given/When/Then test cases found')
  if (outputFiles.length === 0)                        issues.push('No output files listed')
  const specValidation = { valid: issues.length === 0, issues }

  if (!specValidation.valid) {
    specValidation.issues.forEach(i => log(`  ⚠ ${i}`))
    log(`Spec invalid — fix specs/${targetId}.md before retrying ${targetId}`)
    const blockedSpecStuck = `# ${targetId} — Blocked at spec validation\n\n## Reason\nSpec validation failed before the Creator ran.\n\n## Issues\n${specValidation.issues.map(i => `- ${i}`).join('\n')}`
    // Mutate only the target feature's status field — avoids passing the full JSON blob
    // through an agent prompt, which risks reformatting or truncation.
    return await blockFeature(targetId, blockedSpecStuck, {
      label: 'invalid-spec', phase: 'Validate',
      reason: 'Spec validation failed: ' + specValidation.issues.join('; '),
    })
  }
  log('Spec valid ✓')
}

// ─── Phase 1.55: Spec Quality Lint ─────────────────────────────────────────

let preflight = null

if (runTests) {
  const isMutationHint = outputFiles.some(file =>
    features.some(f => f.status === 'DONE' && (f.output_files || []).includes(file))
  )
  const specLinterPayload = `=== OUTPUT FILES ===
${outputFiles.join('\n')}

=== IS MUTATION FEATURE ===
${isMutationHint ? 'Yes — output_files includes at least one file already written by a DONE feature.' : 'No — all output files are new.'}

=== CLAUDE.md CONSTRAINTS ===
${hardConstraintsOnly}

=== FEATURE SPEC ===
${featureSpec}`

  preflight = await agent(
    `${SPEC_LINTER_TEMPLATE}\n\n${specLinterPayload}`,
    { schema: PREFLIGHT_SCHEMA, label: `spec-lint:${targetId}`, phase: 'Validate' }
  )

  if (preflight.verdict === 'BLOCK') {
    const errorList = preflight.issues.map(i => `- [${i.severity}] ${i.text}`).join('\n')
    log(`Spec quality BLOCK — ${preflight.issues.filter(i => i.severity === 'ERROR').length} error(s) found`)
    preflight.issues.filter(i => i.severity === 'ERROR').forEach(i => log(`  ✗ ${i.text}`))
    const blockedLintStuck = `# ${targetId} — Blocked at spec quality lint\n\n## Reason\nSpec quality linter found structural problems before the Creator ran.\n\n## Issues\n${errorList}`
    return await blockFeature(targetId, blockedLintStuck, {
      label: 'lint', phase: 'Validate',
      reason: 'Spec quality lint: ' + preflight.issues.filter(i => i.severity === 'ERROR').map(i => i.text).join('; '),
    })
  }

  if (preflight.verdict === 'WARN') {
    log(`Spec quality WARN — ${preflight.issues.length} warning(s) injected into Creator prompt`)
    preflight.issues.forEach(i => log(`  ⚠ ${i.text}`))
  } else {
    log('Spec quality lint PASS ✓')
  }
}

// ─── Phase 1.6: Mutation Baseline ──────────────────────────────────────────

let baselineResult = null

if (isMutationFeature && runTests) {
  phase('Baseline')
  log(`Mutation feature — modifies: ${mutatedFiles.join(', ')}`)
  log(`Recording baseline for owning tests: ${owningTestFiles.join(', ')}`)
  baselineResult = await agent(
    `Run the following test files in the project root (the directory containing package.json, not harness/):
npx vitest run ${owningTestFiles.join(' ')}

Return results.`,
    { schema: BASELINE_SCHEMA, label: `baseline:${targetId}`, phase: 'Baseline' }
  )
  log(`Baseline: ${baselineResult.passed ? 'PASS ✓' : 'FAIL ✗'} (${baselineResult.passedCount ?? '?'} passed, ${baselineResult.failedCount ?? '?'} failed)`)
  if (!baselineResult.passed) {
    log(`⚠ Owning tests already failing before this feature runs — regression attribution will be suppressed`)
  }
}

// ─── Phase 2: Create ────────────────────────────────────────────────────────

phase('Create')

const preflightNotes = (preflight && preflight.issues && preflight.issues.length > 0)
  ? `\n\n## Pre-flight Spec Notes\nThe spec linter flagged potential ambiguities. Be alert to these when writing tests and implementation:\n${preflight.issues.map(i => `- ${i.text}`).join('\n')}`
  : ''

await agent(
  `${CREATOR_TEMPLATE}

=== PROJECT PROCESS AND CONSTRAINTS (CLAUDE.md) ===
${agentMd}

=== FEATURE SPEC ===
${featureSpec}${preflightNotes}

=== CONTEXT FILES ===
${contextContent}

=== EXPECTED OUTPUT FILES ===
You must write all of these files to disk:
${outputFiles.join('\n')}

Begin now. Write tests first, then implementation. Write every file using the Write or Edit tool.
Do not produce any prose output — only write the files listed above.`,
  { label: `creator:${targetId}`, phase: 'Create' }
)

// Read output files and derive presence in one shot — avoids a separate ls-based file-check agent.
// MISSING markers in the returned string tell us which files the Creator failed to write.
const READ_FILES_PROMPT = `Read the following files and return their contents concatenated.
Format each file as:
=== FILE: <path> ===
<full file contents>

If a file does not exist, write:
=== FILE: <path> === MISSING

Files to read:
${outputFiles.join('\n')}`

let writtenFiles = await agent(
  READ_FILES_PROMPT,
  { label: `read-output:${targetId}:initial`, phase: 'Create' }
)

const missing = outputFiles.filter(f => writtenFiles.includes(`=== FILE: ${f} === MISSING`))
const allPresent = missing.length === 0

if (!allPresent) {
  log(`⚠ Creator did not write expected files: ${missing.join(', ')}`)
}

// ─── Phase 2.5: Pre-Eval Validation (discovery features with pre_eval_command) ─

let preEvalResult = null

if (preEvalCommand && allPresent) {
  log(`Running pre-eval validation...`)
  preEvalResult = await agent(
    `Run this command in the project root (the directory containing package.json, not harness/):
${preEvalCommand}

Capture the full stdout and stderr combined. Return:
- passed: true if the command exits with code 0, false otherwise
- output: the complete combined stdout+stderr text`,
    { schema: PRE_EVAL_VALIDATION_SCHEMA, label: `pre-eval-validate:${targetId}`, phase: 'Create' }
  )
  log(`Pre-eval validation: ${preEvalResult.passed ? 'PASS ✓' : 'FAIL ✗'} — ${preEvalResult.output.split('\n')[0]}`)
} else if (preEvalCommand && !allPresent) {
  preEvalResult = { passed: false, output: `Skipped — required output files missing: ${missing.join(', ')}` }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function buildVerifyPrompt(featureTestFiles) {
  const hasFeatureTests = featureTestFiles.length > 0
  return `Run the parking app test suite in the project root (directory containing package.json, not harness/).

Run these steps in order:
1. test -d node_modules || npm install
${hasFeatureTests
  ? `2. npx vitest run ${featureTestFiles.join(' ')}
   (Feature tests only — isolates whether this feature's own implementation is correct)
3. npm test
   (Full suite — catches regressions in other features)
4. npm run typecheck`
  : `2. npm test
3. npm run typecheck`}

Return:
- featureTestsPassed: ${hasFeatureTests ? 'true if step 2 exits code 0' : 'omit this field (no feature test files for this feature)'}
- featureTestOutput: ${hasFeatureTests ? 'full stdout+stderr of step 2' : 'omit'}
- featurePassedCount / featureFailedCount: ${hasFeatureTests ? 'parsed from step 2' : 'omit'}
- featureTestFailures: ${hasFeatureTests ? '[{test, error}] for each failure in step 2' : 'omit'}
- testsPassed: true if npm test exits code 0
- testOutput: full stdout+stderr of npm test
- passedCount / failedCount: parsed from npm test output
- testFailures: [{test, error}] for each failure in npm test
- typecheckPassed: true if typecheck exits code 0
- typecheckOutput: full stdout+stderr of typecheck
- typecheckErrors: one string per TypeScript error (file + line + message)`
}

// ─── Phase 3: Verify ────────────────────────────────────────────────────────

phase('Verify')

let testResult

if (!runTests) {
  log(`Discovery feature — skipping npm test and typecheck`)
  testResult = { featureTestsPassed: null, testsPassed: true, typecheckPassed: true, testOutput: 'skipped (discovery feature)', typecheckOutput: 'skipped (discovery feature)' }
} else if (!allPresent) {
  log(`Skipping tests — creator did not write: ${missing.join(', ')}`)
  testResult = {
    featureTestsPassed: null,
    testsPassed: false,
    typecheckPassed: false,
    testOutput: `Skipped — creator did not write expected output files: ${missing.join(', ')}`,
    typecheckOutput: `Skipped — creator did not write expected output files: ${missing.join(', ')}`,
  }
} else {
  testResult = await agent(
    buildVerifyPrompt(featureTestFiles),
    { schema: TEST_SCHEMA, label: `verify:${targetId}`, phase: 'Verify' }
  )
  log(`Feature: ${testResult.featureTestsPassed == null ? 'n/a' : testResult.featureTestsPassed ? 'PASS ✓' : 'FAIL ✗'} | Suite: ${testResult.testsPassed ? 'PASS ✓' : 'FAIL ✗'} | Typecheck: ${testResult.typecheckPassed ? 'PASS ✓' : 'FAIL ✗'}`)
  log(`Tokens spent: ${budget.spent().toLocaleString()}`)
}
// Discovery features with pre_eval_command record preEvalResult (passed/failed binary); pure
// discovery features skip (no test data); test features record the full npm-test counts.
if (!runTests && preEvalCommand) {
  metricTestRuns.push({ revision: 0, featureTestsPassed: null, featurePassedCount: null, featureFailedCount: null, passed: preEvalResult.passed ? 1 : 0, failed: preEvalResult.passed ? 0 : 1, typecheckPassed: null })
} else if (runTests) {
  metricTestRuns.push({ revision: 0, featureTestsPassed: testResult.featureTestsPassed ?? null, featurePassedCount: testResult.featurePassedCount ?? null, featureFailedCount: testResult.featureFailedCount ?? null, passed: testResult.passedCount ?? null, failed: testResult.failedCount ?? null, typecheckPassed: testResult.typecheckPassed })
}

// ─── Phase 4: Evaluate ──────────────────────────────────────────────────────

phase('Evaluate')

let verdict = null
let revision = 0
let noChangeDetected = false
const MAX_REVISIONS = 2

const hashFilesPrompt = `Run in the project root: sha256sum ${outputFiles.join(' ')} 2>/dev/null | sort\nReturn the raw stdout as "hashes".`
let prevHashes = (await agent(
  hashFilesPrompt,
  { schema: FILE_HASHES_SCHEMA, label: `hash-output:${targetId}:initial`, phase: 'Evaluate' }
)).hashes

while (revision <= MAX_REVISIONS) {

  const evaluatorPrompt = !runTests
    ? `${EVALUATOR_TEMPLATE}

=== PROJECT PROCESS AND CONSTRAINTS (CLAUDE.md) ===
${evalMd}

This is a DISCOVERY feature — it produces documentation files, not TypeScript code. There are no tests to run.

=== FEATURE SPEC ===
${featureSpec}

=== OUTPUT FILES ===
${writtenFiles}
${preEvalResult ? `
=== DETERMINISTIC VALIDATION RESULTS ===
${preEvalResult.passed
  ? `PASS ✓ — ${preEvalResult.output}`
  : `FAIL ✗ — Structural validation failed:
${preEvalResult.output}

IMPORTANT: This result is deterministic (not LLM-based). You MUST issue FAIL or NEEDS-REVISION — you may NOT issue PASS while this validation is failing. Add each validation failure to your failures array verbatim.`
}` : ''}

Evaluate whether the documentation is accurate and complete.
PASS if: all required output files exist and contain the information described in the spec${preEvalResult ? ', AND the deterministic validation above passed' : ''}.
FAIL if: any output file is missing, or key required information (e.g. API URL, field names) is absent or clearly wrong${preEvalResult && !preEvalResult.passed ? ', OR the deterministic validation above failed' : ''}.
NEEDS-REVISION if: files exist but information is incomplete or vague.

Issue your verdict now.`
    : `${EVALUATOR_TEMPLATE}

=== PROJECT PROCESS AND CONSTRAINTS (CLAUDE.md) ===
${evalMd}

=== FEATURE SPEC ===
${featureSpec}${preflightNotes ? `\n\n## Pre-flight Spec Notes\nThe spec linter flagged these ambiguities before the creator ran. The creator was aware of them — factor this in before flagging related implementation choices as wrong:\n${preflight.issues.map(i => `- ${i.text}`).join('\n')}` : ''}

=== IMPLEMENTATION ===
${writtenFiles}

=== TEST RESULTS ===
${fmtTestResults(testResult)}

Issue your verdict now.`

  verdict = await agent(
    evaluatorPrompt,
    { schema: VERDICT_SCHEMA, label: `evaluator:${targetId}:r${revision}`, phase: 'Evaluate' }
  )

  log(`Revision ${revision}: ${verdict.result}${verdict.brief ? ' — ' + verdict.brief : ''}`)
  if (verdict.failures && verdict.failures.length > 0) {
    verdict.failures.forEach(f => log(`  ✗ ${f}`))
  }

  metricVerdicts.push(verdict.result)
  if (verdict.failures) metricFailures.push(...verdict.failures)

  if (verdict.result === 'PASS') break
  if (revision >= MAX_REVISIONS) break

  revision++
  log(`Starting revision ${revision}/${MAX_REVISIONS}`)

  // Send the revision back to a creator agent with the specific failure brief
  await agent(
    `${REVISER_TEMPLATE}

=== PROJECT PROCESS AND CONSTRAINTS (CLAUDE.md) ===
${agentMd}

=== CONTEXT FILES ===
${filterContextForReviser(contextContent, outputFiles)}

=== CURRENT IMPLEMENTATION ===
${writtenFiles}

=== EVALUATOR VERDICT ===
VERDICT: ${verdict.result}
SUMMARY: ${verdict.brief}
${verdict.failures && verdict.failures.length > 0
  ? '\nSPECIFIC FAILURES:\n' + verdict.failures.map(f => '- ' + f).join('\n')
  : ''}

=== TEST RESULTS ===
${!runTests && preEvalResult
  ? (preEvalResult.passed
    ? `Structural validation: PASS ✓\n${preEvalResult.output}`
    : `Structural validation: FAIL ✗\n${preEvalResult.output}\n\nFix the above structural failures in your output files.`)
  : fmtTestResults(testResult) + fmtRegressionAttribution(baselineResult, testResult, owningTestFiles)
}

=== AUTHORITATIVE FEATURE SPEC ===
${featureSpec}`,
    { label: `revise:${targetId}:r${revision}`, phase: 'Evaluate' }
  )

  // No-change short-circuit: hash output files to detect Reviser stalls deterministically.
  // Comparing sha256 of on-disk bytes avoids LLM formatting variation that would make
  // a string-equality check non-deterministic. The LLM file-read only runs when hashes
  // confirm something actually changed — saving it on stall.
  const currHashes = (await agent(
    hashFilesPrompt,
    { schema: FILE_HASHES_SCHEMA, label: `hash-check:${targetId}:r${revision}`, phase: 'Evaluate' }
  )).hashes
  if (currHashes === prevHashes) {
    log(`⚠ Reviser r${revision} made no file changes — short-circuiting to BLOCKED`)
    noChangeDetected = true
    break
  }
  prevHashes = currHashes
  writtenFiles = await agent(
    READ_FILES_PROMPT,
    { label: `read-output:${targetId}:r${revision}`, phase: 'Evaluate' }
  )

  // Re-run tests after revision (or re-run pre-eval validation for discovery features)
  if (!runTests && preEvalCommand) {
    preEvalResult = await agent(
      `Run this command in the project root (the directory containing package.json, not harness/):
${preEvalCommand}

Capture the full stdout and stderr combined. Return:
- passed: true if the command exits with code 0, false otherwise
- output: the complete combined stdout+stderr text`,
      { schema: PRE_EVAL_VALIDATION_SCHEMA, label: `pre-eval-revalidate:${targetId}:r${revision}`, phase: 'Evaluate' }
    )
    log(`Re-verify r${revision}: pre-eval ${preEvalResult.passed ? 'PASS ✓' : 'FAIL ✗'} — ${preEvalResult.output.split('\n')[0]}`)
  } else {
    testResult = await agent(
      buildVerifyPrompt(featureTestFiles),
      { schema: TEST_SCHEMA, label: `reverify:${targetId}:r${revision}`, phase: 'Evaluate' }
    )
    log(`Re-verify r${revision}: Feature ${testResult.featureTestsPassed == null ? 'n/a' : testResult.featureTestsPassed ? 'PASS ✓' : 'FAIL ✗'} | Suite ${testResult.testsPassed ? 'PASS ✓' : 'FAIL ✗'} | Typecheck ${testResult.typecheckPassed ? 'PASS ✓' : 'FAIL ✗'}`)
  }
  // Same logic as the initial revision-0 push: discovery+preEvalCommand → preEvalResult;
  // pure discovery → skip; test features → testResult counts.
  if (!runTests && preEvalCommand) {
    metricTestRuns.push({ revision, featureTestsPassed: null, featurePassedCount: null, featureFailedCount: null, passed: preEvalResult.passed ? 1 : 0, failed: preEvalResult.passed ? 0 : 1, typecheckPassed: null })
  } else if (runTests) {
    metricTestRuns.push({ revision, featureTestsPassed: testResult.featureTestsPassed ?? null, featurePassedCount: testResult.featurePassedCount ?? null, featureFailedCount: testResult.featureFailedCount ?? null, passed: testResult.passedCount ?? null, failed: testResult.failedCount ?? null, typecheckPassed: testResult.typecheckPassed })
  }
}

log(`Tokens spent: ${budget.spent().toLocaleString()}`)

// ─── Phase 5: Update State ──────────────────────────────────────────────────

phase('Update')

const metricsRecord = JSON.stringify({
  feature:           targetId,
  name:              targetName,
  verdict:           verdict ? verdict.result : 'BLOCKED',
  revisions:         revision,
  tokenCost:         budget.spent() - tokensAtStart,
  evaluatorVerdicts: metricVerdicts,
  testRuns:          metricTestRuns,
  failures:          metricFailures,
  preflight_verdict: preflight ? preflight.verdict : (runTests ? 'skipped' : 'n/a'),
  preflight_issues:  preflight ? preflight.issues : [],
})
if (verdict && verdict.result === 'PASS') {
  await agent(
    `Run in the project root:
node harness/finalize-run.js --feature ${targetId} --status DONE --cleanup-stuck --write-metrics <<'METRICS_EOF'
${metricsRecord}
METRICS_EOF`,
    { label: 'finalize-run', phase: 'Update' }
  )
  log(`✓ ${targetId} complete and marked DONE`)

  // Run post-build command if this feature has one (e.g., npm install, npm run fetch)
  if (postBuildCommand) {
    log(`Running post-build: ${postBuildCommand}`)
    await agent(
      `Run this command in the project root (the directory containing package.json, not harness/):
${postBuildCommand}

Capture the full output. If it succeeds, report success.
If it fails, report the error — but this does NOT revert the DONE status; it is infrastructure seeding, not part of the feature's correctness verdict.`,
      { label: `post-build:${targetId}`, phase: 'Update' }
    )
    log(`Post-build complete: ${postBuildCommand}`)
  }

  log(`Tokens used this run: ${budget.spent().toLocaleString()}`)
  return { success: true, feature: targetId, revisions: revision }

} else {
  const failures = verdict && verdict.failures && verdict.failures.length > 0
    ? verdict.failures.map(f => `- ${f}`).join('\n')
    : '(none listed)'

  const failReason = noChangeDetected
    ? `Reviser stalled — no file changes detected after revision ${revision}`
    : (verdict ? verdict.brief : 'No verdict produced')

  const stuckFileContent = noChangeDetected
    ? [
        `# ${targetId} — Blocked: Reviser stalled (no file changes)`,
        ``,
        `## What happened`,
        `The Reviser ran on revision ${revision} but made no changes to any output file.`,
        `This typically means the model hallucinated that the code was already correct without patching it.`,
        `Skipped re-verify and re-evaluate to avoid wasting agent calls on unchanged output.`,
        ``,
        `## Last evaluator verdict (before stall)`,
        `**Result:** ${verdict ? verdict.result : 'none'}`,
        `**Summary:** ${verdict ? verdict.brief : '(none)'}`,
        ``,
        `## Specific failures`,
        failures,
      ].join('\n')
    : [
        `# ${targetId} — Stuck after ${revision} revision(s)`,
        ``,
        `## Evaluator verdict`,
        `**Result:** ${verdict ? verdict.result : 'none'}`,
        `**Summary:** ${failReason}`,
        ``,
        `## Specific failures`,
        failures,
        ``,
        `## Last test results`,
        `${testResult.passedCount ?? '?'} passed, ${testResult.failedCount ?? '?'} failed`,
        ``,
        testResult.testFailures && testResult.testFailures.length > 0
          ? testResult.testFailures.map(f => `- **${f.test}**\n  ${f.error}`).join('\n')
          : '(no structured failure data)',
        ``,
        `## Last typecheck errors`,
        testResult.typecheckErrors && testResult.typecheckErrors.length > 0
          ? testResult.typecheckErrors.map(e => `- ${e}`).join('\n')
          : '(none)',
      ].join('\n')

  log(`✗ ${targetId} BLOCKED after ${revision} revision(s) — see harness/stuck/${targetId}_stuck_reason.md`)
  log(`  Reason: ${failReason}`)
  log(`Tokens used this run: ${budget.spent().toLocaleString()}`)
  const blockedResult = await blockFeature(targetId, stuckFileContent, {
    metricsRecord, phase: 'Update', reason: failReason, revisions: revision,
  })
  // Cross-run spec analysis: if this feature has blocked before (≥2 records in metrics.jsonl
  // including the current run), identify repeating failure strings and append targeted hints.
  // Skipped on first-ever block — no prior runs to cross-reference.
  await agent(
    `Read harness/metrics.jsonl. Parse each line as JSON and collect all records where the "feature" field equals "${targetId}".

If fewer than 2 records exist for this feature, do nothing and return immediately.

If 2 or more records exist:
1. Collect the "failures" arrays from every record for this feature.
2. Find failure strings that appear in more than one record (repeating failures).
3. If there are no repeating failures, do nothing and return immediately.
4. Classify each repeating failure as one of:
   - spec_ambiguity: the spec does not clearly define expected behavior for this case
   - constraint_violation: a CLAUDE.md hard constraint is not prominently stated in the spec
   - model_confusion: the model understands the spec but makes a reasoning error (hints cannot fix this)
5. For spec_ambiguity and constraint_violation failures only, append the section below to specs/${targetId}.md.
   Do NOT remove or replace any existing content (including any existing "## Hints for Retry" section).

Section to append (fill in the <...> placeholders with actual content):

## Auto-Analysis (recurring failures)

> Auto-generated after multiple blocked runs. Additive only — does not change spec requirements.

**Failures repeated across runs:** <comma-separated list of the repeating failure strings>

### Suggested spec amendments
<one bullet per spec_ambiguity or constraint_violation failure — each bullet must be a concrete suggestion: quote the ambiguous or missing clause and state exactly what the spec should say instead>

If all repeating failures are model_confusion, note them without a Suggested amendments section.
Do not write this section at all if there are no repeating failures.`,
    { label: `spec-analyze:${targetId}`, phase: 'Update' }
  )
  return blockedResult
}
