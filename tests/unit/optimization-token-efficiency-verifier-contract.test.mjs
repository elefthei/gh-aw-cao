import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { root, workflow } from "./workflow-contract.helpers.mjs";

test("token efficiency verifier is review-only, one-intervention scoped, and read-only", () => {
  const source = workflow("optimization-token-efficiency-verifier.md");
  const policy = JSON.parse(readFileSync(join(root, ".github", "workflows", "cao.json"), "utf8"));
  const packagePolicy = JSON.parse(readFileSync(join(root, "optimization", "cao.json"), "utf8"));

  assert.match(source, /^name: "AW Optimization \/ Token Efficiency Verifier"$/m);
  assert.match(source, /worker: token-efficiency-verifier/);
  assert.match(source, /uses: shared\/activity-cache\.md/);
  assert.match(source, /GH_AW_SAFE_OUTPUT_MODE: \$\{\{ inputs\.safe_output_mode \|\| 'review' \}\}/);
  assert.match(source, /authoritative-applied-implementation-required/);
  assert.match(source, /recommendationDisposition == "applied"/);
  assert.match(source, /implementationCompletedAt/);
  assert.match(source, /token-efficiency-verification-claim/);
  assert.match(source, /retention-days: 90/);
  assert.match(source, /evidence_cutoff:/);
  assert.doesNotMatch(source, /verification_json|evaluationId|acceptedOutcomes|attributableOverhead/);
  assert.match(source, /schemaVersion: 1/);
  assert.match(source, /verifierRunId: \$verifierRunId/);
  assert.doesNotMatch(source, /dispatch-workflow:|create-issue:|create-pull-request:/);
  assert.doesNotMatch(source, /uses: shared\/target-checkout/);
  assert.match(source, /This workflow has no model task/);
  assert.match(source, /agent:\n\s+if: \$\{\{ false \}\}/);
  assert.match(source, /Publish immutable verification selectors/);
  assert.doesNotMatch(source, /actions\/download-artifact|post-steps:/);
  assert.match(source, /never checks out or writes to the target repository/);
  assert.equal(
    policy["control-plane"].packages.optimization.workers["token-efficiency-verifier"]["max-mode"],
    "review",
  );
  assert.equal(
    packagePolicy.workers["token-efficiency-verifier"],
    "optimization-token-efficiency-verifier",
  );
});

test("orchestrator dispatches verifier only from matured applied Activity evidence", () => {
  const source = workflow("optimization.md");
  assert.match(source, /optimization-token-efficiency-verifier/);
  assert.match(source, /uses: shared\/activity-cache\.md/);
  assert.match(source, /latest authoritative lifecycle observation/);
  assert.match(source, /disposition is `applied`/);
  assert.match(source, /cutoff is a temporal selector/);
  assert.match(source, /Do not supply Run lists, measurements, outcome lists, AIC, or evaluator contracts/);
  assert.match(source, /Do not dispatch proposed, unapplied, rejected, failed-start, superseded, outdated, duplicate, unmatured, stale, ambiguous, or mixed-grain evidence/);
});

test("Activity owns comparison publication and append-only retention", () => {
  const collector = readFileSync(join(root, "activity", "collect-logs.sh"), "utf8");
  const manifest = readFileSync(join(root, "activity", "aw.yml"), "utf8");
  const mapping = JSON.parse(readFileSync(join(
    root,
    "dashboard",
    "site",
    "src",
    "data",
    "ingest",
    "expressions",
    "gh-aw-logs-v2.json",
  ), "utf8"));

  assert.match(collector, /name=token-efficiency-verification-claim/);
  assert.match(collector, /token-efficiency-comparisons\.jsonl/);
  assert.match(collector, /token-efficiency-operational-values\.jsonl/);
  assert.match(collector, /token-efficiency-grader-evidence\.mjs/);
  assert.match(collector, /--history-file "\$comparison_tmp"/);
  assert.match(manifest, /token-efficiency-verifier\.mjs/);
  assert.match(manifest, /token-efficiency-grader-evidence\.mjs/);
  assert.deepEqual(
    mapping.variants.token_efficiency_comparison_observation.identity,
    ["verifierRunId", "verifierRunAttempt", "comparisonId"],
  );
});

test("comparison source is declarative and contains no JavaScript business derivation", () => {
  const dashboard = JSON.parse(readFileSync(join(root, "dashboard", "site", "dashboard.json"), "utf8"));
  const query = dashboard.dashboard.queries.find(({ name }) =>
    name === "token-efficiency-comparisons");
  const source = readFileSync(join(
    root,
    "dashboard",
    "site",
    "src",
    "data",
    "queries",
    "view-sources.js",
  ), "utf8");

  assert.equal(query.from, "events");
  assert.deepEqual(query.filter.predicates, [{
    field: "event-type",
    equals: "token_efficiency.comparison",
  }]);
  assert.ok(query.select.some(({ field }) => field === "verified-net-gain"));
  assert.ok(query["order-by"].some(({ field }) => field === "evidence-cutoff"));
  assert.doesNotMatch(source, /tokenEfficiencyComparisons|tokenEfficiencyComparisonSource/);
});
