#!/usr/bin/env node
// harness/report.js — metrics dashboard for the feature build harness
// Usage:
//   node harness/report.js                  full report
//   node harness/report.js --feature F-03   drill into one feature
//   node harness/report.js --failures       failure analysis only

const fs = require("fs");
const path = require("path");

const METRICS_PATH = path.join(__dirname, "metrics.jsonl");
const FEATURES_PATH = path.join(__dirname, "features.json");
const STOPWORDS = new Set([
  "the","and","for","not","that","this","with","from","are","was","has",
  "have","had","but","its","will","been","were","they","them","their",
  "when","each","does","must","into","also","than","then","only","both",
  "which","where","would","could","should","there","these","those","some",
  "more","very","your","file","code","test","type","func","line","call",
]);

// ── CLI args ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const featureFilter = (() => {
  const i = args.indexOf("--feature");
  return i !== -1 ? args[i + 1] : null;
})();
const failuresOnly = args.includes("--failures");

// ── Load data ────────────────────────────────────────────────────────────────

function loadMetrics() {
  if (!fs.existsSync(METRICS_PATH)) return [];
  return fs.readFileSync(METRICS_PATH, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line, i) => {
      try { return JSON.parse(line); }
      catch { process.stderr.write(`Warning: bad JSON on line ${i + 1}\n`); return null; }
    })
    .filter(Boolean);
}

function loadFeatures() {
  if (!fs.existsSync(FEATURES_PATH)) return [];
  try { return JSON.parse(fs.readFileSync(FEATURES_PATH, "utf8")); }
  catch { return []; }
}

// ── Formatting helpers ────────────────────────────────────────────────────────

const VERDICT_COLOR = { PASS: "\x1b[32m", BLOCKED: "\x1b[31m", FAIL: "\x1b[31m", "NEEDS-REVISION": "\x1b[33m" };
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";

function col(verdict) { return (VERDICT_COLOR[verdict] || "") + verdict + RESET; }
function bold(s) { return BOLD + s + RESET; }
function dim(s) { return DIM + s + RESET; }

function fmtNum(n) {
  if (n == null || isNaN(n)) return "—";
  return n.toLocaleString("en-US");
}

function bar(count, max, width = 10) {
  const filled = max === 0 ? 0 : Math.round((count / max) * width);
  return "█".repeat(filled).padEnd(width);
}

function hr(char = "─", width = 72) { return char.repeat(width); }

function table(rows, cols) {
  // cols: [{header, key, width, align}]
  const lines = [];
  const headerRow = cols.map(c => bold(c.header.padEnd(c.width))).join("  ");
  lines.push(headerRow);
  lines.push(dim(cols.map(c => "─".repeat(c.width)).join("  ")));
  for (const row of rows) {
    const cells = cols.map(c => {
      const val = String(row[c.key] ?? "");
      const plain = val.replace(/\x1b\[[0-9;]*m/g, ""); // strip ANSI for width calc
      const pad = Math.max(0, c.width - plain.length);
      return c.align === "right" ? " ".repeat(pad) + val : val + " ".repeat(pad);
    });
    lines.push(cells.join("  "));
  }
  return lines.join("\n");
}

// ── Analysis ──────────────────────────────────────────────────────────────────

function groupByFeature(records) {
  const map = new Map();
  for (const r of records) {
    if (!map.has(r.feature)) map.set(r.feature, []);
    map.get(r.feature).push(r);
  }
  return map;
}

function latest(runs) { return runs[runs.length - 1]; }

function wordFrequency(failures) {
  const freq = new Map();
  for (const str of failures) {
    const words = str.toLowerCase().replace(/[^a-z0-9_]/g, " ").split(/\s+/);
    for (const w of words) {
      if (w.length < 5) continue;
      if (STOPWORDS.has(w)) continue;
      freq.set(w, (freq.get(w) || 0) + 1);
    }
  }
  return [...freq.entries()].sort((a, b) => b[1] - a[1]);
}

// ── Sections ──────────────────────────────────────────────────────────────────

function printSummary(byFeature) {
  let pass = 0, blocked = 0, fail = 0, needsRev = 0, totalRevisions = 0, totalTokens = 0;
  const revBuckets = [0, 0, 0];

  for (const [, runs] of byFeature) {
    const r = latest(runs);
    if (r.verdict === "PASS") pass++;
    else if (r.verdict === "BLOCKED") blocked++;
    else if (r.verdict === "FAIL") fail++;
    else if (r.verdict === "NEEDS-REVISION") needsRev++;
    totalRevisions += r.revisions ?? 0;
    totalTokens += r.tokenCost ?? 0;
    const bucket = Math.min(r.revisions ?? 0, 2);
    revBuckets[bucket]++;
  }

  const total = byFeature.size;
  const avgRevisions = total ? (totalRevisions / total).toFixed(1) : "—";
  const avgTokens = total ? Math.round(totalTokens / total) : 0;

  console.log();
  console.log(bold("═══ Harness Metrics Report ═══"));
  console.log();
  console.log(
    `Features: ${bold(total)} total  │  ` +
    `${col("PASS")} ${pass}  ${col("BLOCKED")} ${blocked}  ${col("FAIL")} ${fail}  ` +
    (needsRev ? `${col("NEEDS-REVISION")} ${needsRev}  ` : "") +
    `pass-rate ${total ? Math.round((pass / total) * 100) : 0}%`
  );
  console.log(
    `Revisions: avg ${bold(avgRevisions)}  │  ` +
    `0-rev ${revBuckets[0]}  1-rev ${revBuckets[1]}  2-rev ${revBuckets[2]}`
  );
  console.log(
    `Tokens:    total ${bold(fmtNum(totalTokens))}  │  avg ${fmtNum(avgTokens)}/feature`
  );
}

function printFeatureTable(byFeature, featuresMeta) {
  const metaById = new Map(featuresMeta.map(f => [f.id, f]));

  const rows = [...byFeature.entries()]
    .map(([id, runs]) => {
      const r = latest(runs);
      const retry = runs.length > 1 ? dim(`[+${runs.length - 1}]`) : "";
      const meta = metaById.get(id);
      return {
        id: id + (retry ? " " + retry : ""),
        name: (meta ? meta.name : r.name ?? "").substring(0, 28),
        verdict: col(r.verdict ?? "—"),
        revisions: String(r.revisions ?? 0),
        tokens: fmtNum(r.tokenCost),
        preflight: r.preflight_verdict ?? "—",
        _revisions: r.revisions ?? 0,
        _tokens: r.tokenCost ?? 0,
      };
    })
    .sort((a, b) => b._revisions - a._revisions || b._tokens - a._tokens);

  console.log();
  console.log(bold(hr()));
  console.log(bold("Feature Results"));
  console.log(dim(hr()));
  console.log(table(rows, [
    { header: "ID",        key: "id",        width: 14 },
    { header: "Name",      key: "name",      width: 28 },
    { header: "Verdict",   key: "verdict",   width: 18 },
    { header: "Rev",       key: "revisions", width: 4,  align: "right" },
    { header: "Tokens",    key: "tokens",    width: 10, align: "right" },
    { header: "Preflight", key: "preflight", width: 9  },
  ]));
}

function printFailureAnalysis(byFeature) {
  const allFailures = [];
  let featuresWithFailures = 0;

  for (const [, runs] of byFeature) {
    const r = latest(runs);
    if (r.failures && r.failures.length > 0) {
      allFailures.push(...r.failures);
      featuresWithFailures++;
    }
  }

  console.log();
  console.log(bold(hr()));
  console.log(bold("Failure Analysis"));
  console.log(dim(hr()));

  if (allFailures.length === 0) {
    console.log(dim("  No failures recorded."));
    return;
  }

  console.log(`  ${featuresWithFailures} feature(s) with evaluator failures — ${allFailures.length} total failure strings\n`);

  // Raw failures per feature
  for (const [id, runs] of byFeature) {
    const r = latest(runs);
    if (!r.failures || r.failures.length === 0) continue;
    console.log(`  ${bold(id)} (${r.verdict}, ${r.revisions} rev):`);
    for (const f of r.failures) {
      console.log(`    ${dim("•")} ${f.substring(0, 100)}${f.length > 100 ? "…" : ""}`);
    }
    console.log();
  }

  // Word frequency
  const freq = wordFrequency(allFailures);
  if (freq.length === 0) return;

  const top = freq.slice(0, 20);
  const maxCount = top[0][1];

  console.log(bold("  Top failure terms:"));
  for (const [word, count] of top) {
    const b = bar(count, maxCount, 12);
    console.log(`  ${word.padEnd(18)} ${b}  ${count}`);
  }
}

function printPreflightCorrelation(byFeature) {
  const buckets = {};

  for (const [, runs] of byFeature) {
    const r = latest(runs);
    const pf = r.preflight_verdict ?? "n/a";
    if (!buckets[pf]) buckets[pf] = { pass: 0, blocked: 0, fail: 0, other: 0, total: 0 };
    buckets[pf].total++;
    if (r.verdict === "PASS") buckets[pf].pass++;
    else if (r.verdict === "BLOCKED") buckets[pf].blocked++;
    else if (r.verdict === "FAIL") buckets[pf].fail++;
    else buckets[pf].other++;
  }

  console.log();
  console.log(bold(hr()));
  console.log(bold("Preflight → Outcome Correlation"));
  console.log(dim(hr()));

  const order = ["PASS", "WARN", "BLOCK", "skipped", "n/a"];
  const present = [...new Set([...order, ...Object.keys(buckets)])].filter(k => buckets[k]);

  for (const pf of present) {
    const b = buckets[pf];
    const passRate = b.total ? Math.round((b.pass / b.total) * 100) : 0;
    console.log(
      `  Preflight ${bold(pf.padEnd(8))}  →  ` +
      `${col("PASS")} ${String(b.pass).padStart(2)}  ` +
      `${col("BLOCKED")} ${String(b.blocked).padStart(2)}  ` +
      (b.fail ? `${col("FAIL")} ${String(b.fail).padStart(2)}  ` : "") +
      `(${passRate}% pass rate, n=${b.total})`
    );
  }
}

function printMultiRunFeatures(byFeature) {
  const multi = [...byFeature.entries()].filter(([, runs]) => runs.length > 1);
  if (multi.length === 0) return;

  console.log();
  console.log(bold(hr()));
  console.log(bold("Reset / Retry History"));
  console.log(dim(hr()));

  for (const [id, runs] of multi) {
    console.log(`  ${bold(id)} — ${runs.length} runs:`);
    for (let i = 0; i < runs.length; i++) {
      const r = runs[i];
      const tag = i === runs.length - 1 ? " (latest)" : "";
      console.log(
        `    run ${i + 1}: ${col(r.verdict ?? "?")}  ` +
        `${r.revisions} rev  ${fmtNum(r.tokenCost)} tokens${tag}`
      );
    }
  }
}

function printFeatureDrill(byFeature, id) {
  const runs = byFeature.get(id);
  if (!runs) {
    console.log(`No metrics found for feature "${id}".`);
    return;
  }

  console.log();
  console.log(bold(`═══ Feature Drill: ${id} ═══`));

  for (let ri = 0; ri < runs.length; ri++) {
    const r = runs[ri];
    console.log();
    console.log(bold(`Run ${ri + 1} of ${runs.length}`));
    console.log(`  Name:       ${r.name}`);
    console.log(`  Verdict:    ${col(r.verdict ?? "—")}`);
    console.log(`  Revisions:  ${r.revisions}`);
    console.log(`  Tokens:     ${fmtNum(r.tokenCost)}`);
    console.log(`  Preflight:  ${r.preflight_verdict ?? "—"}`);
    if (r.preflight_issues && r.preflight_issues.length) {
      for (const iss of r.preflight_issues) {
        console.log(`    ${dim(iss.severity)}: ${iss.text}`);
      }
    }
    console.log(`  Evaluator verdicts: ${(r.evaluatorVerdicts ?? []).join(" → ") || "—"}`);

    if (r.testRuns && r.testRuns.length) {
      console.log(`  Test runs:`);
      for (const t of r.testRuns) {
        const ft = t.featureTestsPassed == null ? "—" : t.featureTestsPassed ? "✓" : "✗";
        const full = t.typecheckPassed ? "✓ typecheck" : "✗ typecheck";
        console.log(
          `    rev ${t.revision}: feature ${ft} (${t.featurePassed ?? "?"}/${(t.featurePassed ?? 0) + (t.featureFailed ?? 0)})` +
          `  full suite ${t.passed ?? "?"}/${(t.passed ?? 0) + (t.failed ?? 0)}` +
          `  ${full}`
        );
      }
    }

    if (r.failures && r.failures.length) {
      console.log(`  Failures (${r.failures.length}):`);
      for (const f of r.failures) {
        console.log(`    ${dim("•")} ${f}`);
      }
    }
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

const records = loadMetrics();

if (records.length === 0) {
  console.log("No metrics recorded yet. Run the harness to generate data.");
  process.exit(0);
}

const byFeature = groupByFeature(records);
const featuresMeta = loadFeatures();

if (featureFilter) {
  printFeatureDrill(byFeature, featureFilter);
} else if (failuresOnly) {
  printFailureAnalysis(byFeature);
} else {
  printSummary(byFeature);
  printFeatureTable(byFeature, featuresMeta);
  printFailureAnalysis(byFeature);
  printPreflightCorrelation(byFeature);
  printMultiRunFeatures(byFeature);
}

console.log();
