export const meta = {
  name: 'parking-feature-builder',
  description: 'Builds one parking app feature using the creator/evaluator loop',
  phases: [
    { title: 'Setup',    detail: 'Read spec front matter, select target, assemble context' },
    { title: 'Validate', detail: 'Check spec is well-formed and has test cases' },
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

const VERDICT_SCHEMA = {
  type: 'object',
  required: ['result', 'brief', 'failures'],
  properties: {
    result:   { type: 'string', enum: ['PASS', 'NEEDS-REVISION', 'FAIL'] },
    brief:    { type: 'string' },
    failures: { type: 'array', items: { type: 'string' } },
  },
}

const FILE_CHECK_SCHEMA = {
  type: 'object',
  required: ['allPresent', 'missing'],
  properties: {
    allPresent: { type: 'boolean' },
    missing:    { type: 'array', items: { type: 'string' } },
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
    await parallel([
      () => agent(
        `Run these two commands in the project root:
node -e "const fs=require('fs'),p='harness/features.json',d=JSON.parse(fs.readFileSync(p,'utf8'));const f=d.find(f=>f.id==='${targetId}');if(!f)throw new Error('Feature not found');f.status='BLOCKED';fs.writeFileSync(p,JSON.stringify(d,null,2)+'\\n');"
node -e "const d=JSON.parse(require('fs').readFileSync('harness/features.json','utf8'));const f=d.find(f=>f.id==='${targetId}');if(!f||f.status!=='BLOCKED')throw new Error('Verification failed: '+f?.status);console.log('Verified '+f.id+' = '+f.status);"`,
        { label: 'mark-blocked-invalid-spec', phase: 'Validate' }
      ),
      () => agent(
        `Write to harness/stuck/${targetId}_stuck_reason.md (create file, overwrite if exists):\n${blockedSpecStuck}`,
        { label: 'write-stuck-invalid-spec', phase: 'Validate' }
      ),
    ])
    return { blocked: true, feature: targetId, reason: 'Spec validation failed: ' + specValidation.issues.join('; ') }
  }
  log('Spec valid ✓')
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

await agent(
  `${CREATOR_TEMPLATE}

=== PROJECT PROCESS AND CONSTRAINTS (CLAUDE.md) ===
${agentMd}

=== FEATURE SPEC ===
${featureSpec}

=== CONTEXT FILES ===
${contextContent}

=== EXPECTED OUTPUT FILES ===
You must write all of these files to disk:
${outputFiles.join('\n')}

Begin now. Write tests first, then implementation. Write every file using the Write or Edit tool.
Do not produce any prose output — only write the files listed above.`,
  { label: `creator:${targetId}`, phase: 'Create' }
)

const fileCheck = await agent(
  `Check whether each of these files exists on disk. Run \`ls <file>\` for each one.

Files to check:
${outputFiles.join('\n')}

Return allPresent: true only if every file exists. List the path of any missing file in the missing array.`,
  { schema: FILE_CHECK_SCHEMA, label: `file-check:${targetId}`, phase: 'Create' }
)

if (!fileCheck.allPresent) {
  log(`⚠ Creator did not write expected files: ${fileCheck.missing.join(', ')}`)
}

// ─── Phase 2.5: Pre-Eval Validation (discovery features with pre_eval_command) ─

let preEvalResult = null

if (preEvalCommand && fileCheck.allPresent) {
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
} else if (preEvalCommand && !fileCheck.allPresent) {
  preEvalResult = { passed: false, output: `Skipped — required output files missing: ${fileCheck.missing.join(', ')}` }
}

// ─── Phase 3: Verify ────────────────────────────────────────────────────────

phase('Verify')

let testResult

if (!runTests) {
  log(`Discovery feature — skipping npm test and typecheck`)
  testResult = { featureTestsPassed: null, testsPassed: true, typecheckPassed: true, testOutput: 'skipped (discovery feature)', typecheckOutput: 'skipped (discovery feature)' }
} else if (!fileCheck.allPresent) {
  log(`Skipping tests — creator did not write: ${fileCheck.missing.join(', ')}`)
  testResult = {
    featureTestsPassed: null,
    testsPassed: false,
    typecheckPassed: false,
    testOutput: `Skipped — creator did not write expected output files: ${fileCheck.missing.join(', ')}`,
    typecheckOutput: `Skipped — creator did not write expected output files: ${fileCheck.missing.join(', ')}`,
  }
} else {
  testResult = await agent(
    `Run the parking app test suite in the project root (directory containing package.json, not harness/).

Run these steps in order:
1. test -d node_modules || npm install
${featureTestFiles.length > 0
  ? `2. npx vitest run ${featureTestFiles.join(' ')}
   (Feature tests only — isolates whether this feature's own implementation is correct)
3. npm test
   (Full suite — catches regressions in other features)
4. npm run typecheck`
  : `2. npm test
3. npm run typecheck`}

Return:
- featureTestsPassed: ${featureTestFiles.length > 0 ? 'true if step 2 exits code 0' : 'omit this field (no feature test files for this feature)'}
- featureTestOutput: ${featureTestFiles.length > 0 ? 'full stdout+stderr of step 2' : 'omit'}
- featurePassedCount / featureFailedCount: ${featureTestFiles.length > 0 ? 'parsed from step 2' : 'omit'}
- featureTestFailures: ${featureTestFiles.length > 0 ? '[{test, error}] for each failure in step 2' : 'omit'}
- testsPassed: true if npm test exits code 0
- testOutput: full stdout+stderr of npm test
- passedCount / failedCount: parsed from npm test output
- testFailures: [{test, error}] for each failure in npm test
- typecheckPassed: true if typecheck exits code 0
- typecheckOutput: full stdout+stderr of typecheck
- typecheckErrors: one string per TypeScript error (file + line + message)`,
    { schema: TEST_SCHEMA, label: `verify:${targetId}`, phase: 'Verify' }
  )
  log(`Feature: ${testResult.featureTestsPassed == null ? 'n/a' : testResult.featureTestsPassed ? 'PASS ✓' : 'FAIL ✗'} | Suite: ${testResult.testsPassed ? 'PASS ✓' : 'FAIL ✗'} | Typecheck: ${testResult.typecheckPassed ? 'PASS ✓' : 'FAIL ✗'}`)
  log(`Tokens spent: ${budget.spent().toLocaleString()}`)
}
metricTestRuns.push({ revision: 0, featureTestsPassed: testResult.featureTestsPassed ?? null, featurePassed: testResult.featurePassedCount ?? null, featureFailed: testResult.featureFailedCount ?? null, passed: testResult.passedCount ?? null, failed: testResult.failedCount ?? null, typecheckPassed: testResult.typecheckPassed })

// ─── Phase 4: Evaluate ──────────────────────────────────────────────────────

phase('Evaluate')

let verdict = null
let revision = 0
const MAX_REVISIONS = 2

const READ_FILES_PROMPT = `Read the following files and return their contents concatenated.
Format each file as:
=== FILE: <path> ===
<full file contents>

If a file does not exist, write:
=== FILE: <path> === MISSING

Files to read:
${outputFiles.join('\n')}`

// Read what the Creator wrote — before the loop so revisions only re-read after actually changing files
let writtenFiles = await agent(
  READ_FILES_PROMPT,
  { label: `read-output:${targetId}:initial`, phase: 'Evaluate' }
)

while (revision <= MAX_REVISIONS) {

  const evaluatorPrompt = !runTests
    ? `${EVALUATOR_TEMPLATE}

=== PROJECT PROCESS AND CONSTRAINTS (CLAUDE.md) ===
${agentMd}

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
${agentMd}

=== FEATURE SPEC ===
${featureSpec}

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
${contextContent}

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
      `Run the parking app test suite in the project root (directory containing package.json, not harness/).

Run these steps in order:
${featureTestFiles.length > 0
  ? `1. npx vitest run ${featureTestFiles.join(' ')}
   (Feature tests only)
2. npm test
   (Full suite)
3. npm run typecheck`
  : `1. npm test
2. npm run typecheck`}

Return the same fields as the initial verify run:
- featureTestsPassed / featureTestOutput / featurePassedCount / featureFailedCount / featureTestFailures ${featureTestFiles.length > 0 ? '(from step 1)' : '(omit — no feature test files)'}
- testsPassed / testOutput / passedCount / failedCount / testFailures (from npm test)
- typecheckPassed / typecheckOutput / typecheckErrors (from typecheck)`,
      { schema: TEST_SCHEMA, label: `reverify:${targetId}:r${revision}`, phase: 'Evaluate' }
    )
    log(`Re-verify r${revision}: Feature ${testResult.featureTestsPassed == null ? 'n/a' : testResult.featureTestsPassed ? 'PASS ✓' : 'FAIL ✗'} | Suite ${testResult.testsPassed ? 'PASS ✓' : 'FAIL ✗'} | Typecheck ${testResult.typecheckPassed ? 'PASS ✓' : 'FAIL ✗'}`)
  }
  metricTestRuns.push({ revision, featureTestsPassed: testResult.featureTestsPassed ?? null, featurePassed: testResult.featurePassedCount ?? null, featureFailed: testResult.featureFailedCount ?? null, passed: testResult.passedCount ?? null, failed: testResult.failedCount ?? null, typecheckPassed: testResult.typecheckPassed })

  // Re-read what the Reviser wrote — feeds the next iteration's evaluator
  writtenFiles = await agent(
    READ_FILES_PROMPT,
    { label: `read-output:${targetId}:r${revision}`, phase: 'Evaluate' }
  )
}

log(`Tokens spent: ${budget.spent().toLocaleString()}`)

// ─── Phase 5: Update State ──────────────────────────────────────────────────

phase('Update')

const metricsRecord = JSON.stringify({
  feature:          targetId,
  name:             targetName,
  verdict:          verdict ? verdict.result : 'BLOCKED',
  revisions:        revision,
  tokenCost:        budget.spent() - tokensAtStart,
  evaluatorVerdicts: metricVerdicts,
  testRuns:         metricTestRuns,
  failures:         metricFailures,
})
await agent(
  `Append this line to the file harness/metrics.jsonl (create it if it does not exist):
${metricsRecord}

The file holds one JSON object per line. Do not modify existing lines — only append the new line followed by a newline character.`,
  { label: 'write-metrics', phase: 'Update' }
)

if (verdict && verdict.result === 'PASS') {
  await agent(
    `Run these two commands in the project root:
node -e "const fs=require('fs'),p='harness/features.json',d=JSON.parse(fs.readFileSync(p,'utf8'));const f=d.find(f=>f.id==='${targetId}');if(!f)throw new Error('Feature not found');f.status='DONE';fs.writeFileSync(p,JSON.stringify(d,null,2)+'\\n');"
node -e "const d=JSON.parse(require('fs').readFileSync('harness/features.json','utf8'));const f=d.find(f=>f.id==='${targetId}');if(!f||f.status!=='DONE')throw new Error('Verification failed: '+f?.status);console.log('Verified '+f.id+' = '+f.status);"`,
    { label: 'mark-done', phase: 'Update' }
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
  const failReason = verdict ? verdict.brief : 'No verdict produced'
  const failures = verdict && verdict.failures && verdict.failures.length > 0
    ? verdict.failures.map(f => `- ${f}`).join('\n')
    : '(none listed)'

  const stuckFileContent = [
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
  await parallel([
    () => agent(
      `Run these two commands in the project root:
node -e "const fs=require('fs'),p='harness/features.json',d=JSON.parse(fs.readFileSync(p,'utf8'));const f=d.find(f=>f.id==='${targetId}');if(!f)throw new Error('Feature not found');f.status='BLOCKED';fs.writeFileSync(p,JSON.stringify(d,null,2)+'\\n');"
node -e "const d=JSON.parse(require('fs').readFileSync('harness/features.json','utf8'));const f=d.find(f=>f.id==='${targetId}');if(!f||f.status!=='BLOCKED')throw new Error('Verification failed: '+f?.status);console.log('Verified '+f.id+' = '+f.status);"`,
      { label: 'mark-blocked', phase: 'Update' }
    ),
    () => agent(
      `Write to harness/stuck/${targetId}_stuck_reason.md (create file, overwrite if exists):\n${stuckFileContent}`,
      { label: 'write-stuck', phase: 'Update' }
    ),
  ])
  log(`✗ ${targetId} BLOCKED after ${revision} revision(s) — see harness/stuck/${targetId}_stuck_reason.md`)
  log(`  Reason: ${failReason}`)
  log(`Tokens used this run: ${budget.spent().toLocaleString()}`)
  return { blocked: true, feature: targetId, revisions: revision, reason: failReason }
}
