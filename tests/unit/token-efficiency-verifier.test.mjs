import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { validateTokenEfficiencyAssignment } from "../../activity/token-efficiency-assignment.mjs";
import { collectGraderEvidence } from "../../activity/token-efficiency-grader-evidence.mjs";
import {
  buildVerificationObservations,
  hasComparison,
} from "../../activity/token-efficiency-verifier.mjs";

const opportunityId =
  "token-opportunity:octo%2Fexample:.github%2Fworkflows%2Freview.md:2026-09-01T00:00:00Z:2026-09-08T00:00:00Z:1185999:review-context-v1";
const interventionId = `token-intervention:${opportunityId}:review-context-v1`;
const evaluatorDigest =
  "64b72cc65f8b08a843db04b4af127bc2c2c3b3ac6ccb7db5e52c004653daa943";
const provenance = {
  source: "activity",
  generation: "cao-activity-v3-1",
  completeness: "complete",
  freshness: "fresh",
};

function operationalValue({
  status = "pass",
  value = 0.9,
  evidenceAt,
  digest = evaluatorDigest,
  mature = true,
  definition = {},
} = {}) {
  return {
    id: "operational-value",
    source: "operational-value",
    status,
    value,
    implementation: {
      digest,
      definition: {
        schemaVersion: 4,
        grader: "operational-value",
        ...definition,
      },
    },
    observation: {
      evidenceAt,
      maturesAt: evidenceAt,
      mature,
    },
  };
}

function activityRun(runId, {
  repository = "octo/example",
  workflowPath = ".github/workflows/review.md",
  workflowName = "Review",
  variant,
  aic,
  startedAt,
  completedAt = startedAt,
  conclusion = "success",
  grader = variant
    ? operationalValue({ evidenceAt: completedAt })
    : undefined,
  attempt = 1,
  overrides = {},
}) {
  return {
    schema_version: 2,
    kind: "run",
    run: {
      run_id: runId,
      run_attempt: attempt,
      organization: repository.split("/")[0],
      repository,
      workflow_path: workflowPath,
      workflow_name: workflowName,
      created_at: startedAt,
      started_at: startedAt,
      updated_at: completedAt,
      completed_at: completedAt,
      conclusion,
      experiments: variant ? { assignments: { "review-context-v1": variant } } : undefined,
      token_usage_summary: {
        total_aic: aic,
        total_input_tokens: aic * 100,
        total_output_tokens: aic * 10,
        total_cache_read_tokens: aic * 20,
        total_cache_write_tokens: 0,
        by_model: { test: { reasoning_tokens: aic * 5 } },
      },
      ...overrides,
    },
    grader,
  };
}

function claim(overrides = {}) {
  return {
    schemaVersion: 1,
    targetRepo: "octo/example",
    opportunityId,
    interventionId,
    evidenceCutoff: "2026-10-01T00:00:00Z",
    controlRepository: "githubnext/gh-aw-cao",
    verifierRunId: "9001",
    verifierRunAttempt: 1,
    ...overrides,
  };
}

function envelopes(lifecycleOverrides = {}, opportunityOverrides = {}) {
  const records = [
    {
      schema_version: 2,
      kind: "token_efficiency_observation",
      observation: {
        schemaVersion: 1,
        targetRepo: "octo/example",
        workflowPath: ".github/workflows/review.md",
        experimentId: "review-context-v1",
        evidenceWindowStart: "2026-09-01T00:00:00Z",
        evidenceWindowEnd: "2026-09-08T00:00:00Z",
        opportunityId,
        interventionId,
        controlRepository: "githubnext/gh-aw-cao",
        optimizerRunId: "6001",
        runAttempt: 1,
        attributableRunIds: ["5001", "6001", "7001", "5002"],
        evidenceLinks: ["https://github.com/octo/example/actions/runs/8001"],
        verificationContract: {
          evaluatorDigest,
          costGrain: "run-aggregate",
          controlVariant: "control",
          optimizedVariant: "optimized",
          workloadComparisonKey: "accepted-target-outcome:v1",
          acceptanceRuleDigest: "authoritative-accepted-target-outcome:v1",
          minimumSampleSize: 2,
          minimumMaturityDays: 14,
        },
        sourceProvenance: provenance,
        ...opportunityOverrides,
      },
    },
    {
      schema_version: 2,
      kind: "token_efficiency_lifecycle_observation",
      observation: {
        schemaVersion: 1,
        lifecycleObservationId: "token-lifecycle:applied",
        observedAt: "2026-09-16T00:00:00Z",
        controlRepository: "githubnext/gh-aw-cao",
        optimizerRunId: "6001",
        optimizerRunAttempt: 1,
        optimizerWorkflowPath: ".github/workflows/optimization-token-optimizer.md",
        optimizerWorkflowName: "AW Optimization / Token Optimizer",
        targetRepo: "octo/example",
        workflowPath: ".github/workflows/review.md",
        opportunityId,
        interventionId,
        experimentId: "review-context-v1",
        previousInterventionState: "accepted",
        interventionState: "running",
        previousRecommendationDisposition: "unapplied",
        recommendationDisposition: "applied",
        implementationChangeId: "github:pull-request:octo/example:42",
        implementationCompletedAt: "2026-09-16T00:00:00Z",
        safeOutputId: "github:issue:githubnext/gh-aw-cao:42",
        safeOutputUrl: "https://github.com/githubnext/gh-aw-cao/issues/42",
        sourceProvenance: provenance,
        ...lifecycleOverrides,
      },
    },
    activityRun(7001, { variant: "control", aic: 10, startedAt: "2026-09-02T00:00:00Z" }),
    activityRun(7002, { variant: "control", aic: 10, startedAt: "2026-09-03T00:00:00Z" }),
    activityRun(8001, { variant: "optimized", aic: 5, startedAt: "2026-09-17T00:00:00Z" }),
    activityRun(8002, { variant: "optimized", aic: 5, startedAt: "2026-09-18T00:00:00Z" }),
    activityRun(5001, {
      repository: "githubnext/gh-aw-cao",
      workflowPath: ".github/workflows/optimization-ai-credit-auditor.md",
      workflowName: "AW Optimization / AI Credit Auditor",
      aic: 1,
      startedAt: "2026-09-14T00:00:00Z",
    }),
    activityRun(5002, {
      repository: "githubnext/gh-aw-cao",
      workflowPath: ".github/workflows/unrelated.md",
      workflowName: "Unrelated",
      aic: 100,
      startedAt: "2026-09-14T00:00:00Z",
    }),
    activityRun(6001, {
      repository: "githubnext/gh-aw-cao",
      workflowPath: ".github/workflows/optimization-token-optimizer.md",
      workflowName: "AW Optimization / Token Optimizer",
      aic: 2,
      startedAt: "2026-09-15T00:00:00Z",
    }),
    activityRun(9001, {
      repository: "githubnext/gh-aw-cao",
      workflowPath: ".github/workflows/optimization-token-efficiency-verifier.md",
      workflowName: "AW Optimization / Token Efficiency Verifier",
      aic: 1,
      startedAt: "2026-10-02T00:00:00Z",
    }),
  ];
  return records.flatMap((record) => record.grader === undefined
    ? [record]
    : [
        {
          ...record,
          grader: undefined,
        },
        {
          schema_version: 2,
          kind: "token_efficiency_operational_value_observation",
          observation: {
            runId: String(record.run.run_id),
            runAttempt: record.run.run_attempt,
            result: record.grader,
            sourceProvenance: provenance,
          },
        },
      ]);
}

test("discovers target attempts and derives deterministic net verified savings", () => {
  const first = buildVerificationObservations({ claim: claim(), envelopes: envelopes() });
  const replay = buildVerificationObservations({ claim: claim(), envelopes: envelopes() });

  assert.deepEqual(first, replay);
  assert.equal(first.comparison.evidenceState, "complete");
  assert.equal(first.comparison.baselineAicPerAcceptedOutcome, 10);
  assert.equal(first.comparison.optimizedAicPerAcceptedOutcome, 5);
  assert.equal(first.comparison.baselineAcceptedTargetOutcomeCount, 2);
  assert.equal(first.comparison.optimizedAcceptedTargetOutcomeCount, 2);
  assert.equal(first.comparison.grossRealizedSavingsAic, 10);
  assert.equal(first.comparison.optimizationOverheadAic, 4);
  assert.equal(first.comparison.netRealizedSavingsAic, 6);
  assert.equal(first.comparison.verifiedNetGain, 0.3);
  assert.deepEqual(first.comparison.baselineWindow, {
    start: "2026-09-01T00:00:00Z",
    end: "2026-09-08T00:00:00Z",
  });
  assert.deepEqual(first.comparison.optimizedWindow, {
    start: "2026-09-16T00:00:00Z",
    end: "2026-10-01T00:00:00Z",
  });
  assert.equal(first.comparison.maturityAt, "2026-09-30T00:00:00Z");
  assert.equal(first.comparison.baselineInputTokens, 2_000);
  assert.equal(first.comparison.optimizedInputTokens, 1_000);
  assert.deepEqual(
    first.comparison.attributableOverheadRunIds,
    ["5001:1", "6001:1", "9001:1"],
  );
  assert.equal(first.lifecycle.interventionState, "verified");
  assert.equal(first.lifecycle.implementationChangeId, "github:pull-request:octo/example:42");
});

test("quality, reliability, and cost regressions cannot report realized savings", () => {
  const qualityEvidence = envelopes();
  for (const envelope of qualityEvidence.filter((candidate) =>
    candidate.run?.experiments?.assignments?.["review-context-v1"] === "optimized")) {
    const grader = qualityEvidence.find((candidate) =>
      candidate.kind === "token_efficiency_operational_value_observation"
      && candidate.observation.runId === String(envelope.run.run_id));
    grader.observation.result.value = 0.8;
  }
  const qualityResult = buildVerificationObservations({
    claim: claim(),
    envelopes: qualityEvidence,
  });
  assert.equal(qualityResult.comparison.outcomeQualityPreserved, false);
  assert.equal(qualityResult.comparison.grossRealizedSavingsAic, 0);
  assert.equal(qualityResult.lifecycle.interventionState, "regressed");

  const reliabilityEvidence = envelopes();
  reliabilityEvidence.find((candidate) => candidate.run?.run_id === 8001).run.conclusion = "failure";
  const reliabilityResult = buildVerificationObservations({
    claim: claim(),
    envelopes: reliabilityEvidence,
  });
  assert.equal(reliabilityResult.comparison.reliabilityPreserved, false);
  assert.equal(reliabilityResult.comparison.optimizedFailureRate, 0.5);
  assert.equal(reliabilityResult.lifecycle.interventionState, "regressed");

  const costEvidence = envelopes();
  for (const envelope of costEvidence.filter((candidate) =>
    [8001, 8002].includes(candidate.run?.run_id))) {
    envelope.run.token_usage_summary.total_aic = 12;
  }
  const costResult = buildVerificationObservations({ claim: claim(), envelopes: costEvidence });
  assert.equal(costResult.comparison.verifiedNetGain, 0);
  assert.equal(costResult.lifecycle.interventionState, "regressed");
});

test("non-accepted grader outcomes stay distinct from run reliability and the denominator", () => {
  const evidence = envelopes();
  const additional = activityRun(8003, {
    variant: "optimized",
    aic: 5,
    startedAt: "2026-09-19T00:00:00Z",
    grader: operationalValue({
      status: "fail",
      value: 0,
      evidenceAt: "2026-09-19T00:00:00Z",
    }),
  });
  evidence.push(
    { ...additional, grader: undefined },
    {
      schema_version: 2,
      kind: "token_efficiency_operational_value_observation",
      observation: {
        runId: "8003",
        runAttempt: 1,
        result: additional.grader,
        sourceProvenance: provenance,
      },
    },
  );
  const result = buildVerificationObservations({ claim: claim(), envelopes: evidence });
  assert.equal(result.comparison.optimizedAcceptedTargetOutcomeCount, 2);
  assert.equal(result.comparison.optimizedAicPerAcceptedOutcome, 7.5);
  assert.equal(result.comparison.optimizedFailureRate, 0);

  evidence.find((candidate) => candidate.run?.run_id === 8003).run.conclusion = "failure";
  const failedRun = buildVerificationObservations({ claim: claim(), envelopes: evidence });
  assert.equal(failedRun.comparison.optimizedAcceptedTargetOutcomeCount, 2);
  assert.equal(failedRun.comparison.optimizedFailureRate, 1 / 3);
});

test("missing and malformed operational-value grader evidence fails closed", () => {
  const missing = envelopes();
  const missingIndex = missing.findIndex((candidate) =>
    candidate.kind === "token_efficiency_operational_value_observation"
    && candidate.observation.runId === "8001");
  missing.splice(missingIndex, 1);
  const missingResult = buildVerificationObservations({ claim: claim(), envelopes: missing });
  assert.equal(missingResult.comparison.evidenceState, "incomplete");
  assert.equal(missingResult.comparison.missingReason, "operational-value-grader-evidence-absent");
  assert.equal(missingResult.comparison.verifiedNetGain, undefined);

  const wrongDigest = envelopes();
  wrongDigest.find((candidate) =>
    candidate.kind === "token_efficiency_operational_value_observation"
    && candidate.observation.runId === "8001")
    .observation.result.implementation.digest = "wrong";
  const digestResult = buildVerificationObservations({
    claim: claim(),
    envelopes: wrongDigest,
  });

  assert.equal(digestResult.comparison.evidenceState, "incomparable");
  assert.equal(digestResult.comparison.missingReason, "operational-value-grader-not-comparable");

  const afterCutoff = envelopes();
  afterCutoff.find((candidate) =>
    candidate.kind === "token_efficiency_operational_value_observation"
    && candidate.observation.runId === "8001")
    .observation.result.observation.evidenceAt = "2026-10-01T00:00:01Z";
  const cutoffResult = buildVerificationObservations({
    claim: claim(),
    envelopes: afterCutoff,
  });
  assert.equal(cutoffResult.comparison.evidenceState, "incomparable");
  assert.equal(
    cutoffResult.comparison.missingReason,
    "operational-value-grader-evidence-after-cutoff",
  );
});

test("later complete evidence can recover from an earlier inconclusive observation", () => {
  const incompleteEvidence = envelopes().filter((candidate) =>
    !(candidate.kind === "token_efficiency_operational_value_observation"
      && candidate.observation.runId === "8001"));
  const incomplete = buildVerificationObservations({
    claim: claim(),
    envelopes: incompleteEvidence,
  });
  const recoveredEvidence = envelopes();
  recoveredEvidence.push({
    schema_version: 2,
    kind: "token_efficiency_lifecycle_observation",
    observation: incomplete.lifecycle,
  });
  const recovered = buildVerificationObservations({
    claim: claim({ evidenceCutoff: "2026-10-01T00:00:01Z" }),
    envelopes: recoveredEvidence,
  });
  assert.equal(recovered.comparison.evidenceState, "complete");
  assert.equal(recovered.lifecycle.previousInterventionState, "inconclusive");
  assert.equal(recovered.lifecycle.interventionState, "verified");
});

test("a non-positive baseline denominator is unavailable rather than regressed", () => {
  const evidence = envelopes();
  for (const envelope of evidence.filter((candidate) =>
    [7001, 7002].includes(candidate.run?.run_id))) {
    envelope.run.token_usage_summary.total_aic = 0;
  }
  const result = buildVerificationObservations({ claim: claim(), envelopes: evidence });
  assert.equal(result.comparison.evidenceState, "unavailable");
  assert.equal(result.comparison.missingReason, "baseline-cost-denominator-non-positive");
  assert.equal(result.comparison.verifiedNetGain, undefined);
  assert.equal(result.lifecycle.interventionState, "inconclusive");
});

test("only the frozen contract and authoritative applied implementation define the comparison", () => {
  assert.throws(
    () => buildVerificationObservations({
      claim: claim(),
      envelopes: envelopes({ recommendationDisposition: "unapplied" }),
    }),
    /authoritative applied implementation/,
  );
  assert.throws(
    () => buildVerificationObservations({
      claim: claim({ evidenceCutoff: "2026-09-29T00:00:00Z" }),
      envelopes: envelopes(),
    }),
    /not mature/,
  );
  assert.throws(
    () => buildVerificationObservations({
      claim: claim({ targetRepo: "octo/other" }),
      envelopes: envelopes(),
    }),
    /identity conflicts/,
  );
  assert.throws(
    () => buildVerificationObservations({
      claim: claim({ evidenceCutoff: "2026-10-03T00:00:00Z" }),
      envelopes: envelopes(),
    }),
    /after the authoritative verifier run/,
  );
  assert.throws(
    () => buildVerificationObservations({
      claim: claim({ baseline: { aic: 0 }, attributableOverheadAic: 0 }),
      envelopes: envelopes(),
    }),
    /non-selector field/,
  );
});

test("exact run identity and authoritative experiment assignment fail closed", () => {
  const reassigned = envelopes();
  reassigned.find((candidate) => candidate.run?.run_id === 8001)
    .run.experiments.assignments["review-context-v1"] = "control";
  const missingSample = buildVerificationObservations({
    claim: claim(),
    envelopes: reassigned,
  });
  assert.equal(missingSample.comparison.evidenceState, "incomplete");
  assert.equal(missingSample.comparison.missingReason, "minimum-comparable-sample-not-reached");

  const conflicting = envelopes();
  const duplicate = structuredClone(
    conflicting.find((candidate) => candidate.run?.run_id === 8001),
  );
  duplicate.run.token_usage_summary.total_aic = 0;
  duplicate.run.experiments.assignments["review-context-v1"] = "control";
  conflicting.push(duplicate);
  assert.throws(
    () => buildVerificationObservations({ claim: claim(), envelopes: conflicting }),
    /conflicting authoritative target run evidence/,
  );
});

test("overhead is derived only from authoritative optimization-family control runs", () => {
  const evidence = envelopes();
  for (const envelope of evidence.filter((candidate) =>
    [5001, 6001, 9001].includes(candidate.run?.run_id))) {
    envelope.run.token_usage_summary.invocations = [{ aic: 999 }];
  }
  const result = buildVerificationObservations({ claim: claim(), envelopes: evidence });
  assert.deepEqual(
    result.comparison.attributableOverheadRunIds,
    ["5001:1", "6001:1", "9001:1"],
  );
  assert.equal(result.comparison.optimizationOverheadAic, 4);

  const missingOptimizer = envelopes().filter((candidate) => candidate.run?.run_id !== 6001);
  const incomplete = buildVerificationObservations({
    claim: claim(),
    envelopes: missingOptimizer,
  });
  assert.equal(incomplete.comparison.evidenceState, "incomplete");
  assert.equal(incomplete.comparison.missingReason, "optimizer-overhead-run-absent");
});

test("comparison identity deduplicates one cutoff and retains later evidence", () => {
  const first = buildVerificationObservations({ claim: claim(), envelopes: envelopes() });
  const retained = [{
    schema_version: 2,
    kind: "token_efficiency_comparison_observation",
    observation: first.comparison,
  }];
  assert.equal(hasComparison(retained, first.comparison.comparisonId), true);

  const laterEvidence = envelopes();
  const verifier = laterEvidence.find((candidate) => candidate.run?.run_id === 9001).run;
  verifier.started_at = "2026-10-03T00:00:00Z";
  verifier.created_at = "2026-10-03T00:00:00Z";
  verifier.completed_at = "2026-10-03T00:00:00Z";
  verifier.updated_at = "2026-10-03T00:00:00Z";
  const additional = activityRun(8003, {
    variant: "optimized",
    aic: 5,
    startedAt: "2026-10-02T00:00:00Z",
  });
  laterEvidence.push(
    { ...additional, grader: undefined },
    {
      schema_version: 2,
      kind: "token_efficiency_operational_value_observation",
      observation: {
        runId: "8003",
        runAttempt: 1,
        result: additional.grader,
        sourceProvenance: provenance,
      },
    },
  );
  const later = buildVerificationObservations({
    claim: claim({ evidenceCutoff: "2026-10-02T00:00:00Z" }),
    envelopes: laterEvidence,
  });
  assert.notEqual(later.comparison.comparisonId, first.comparison.comparisonId);
  assert.equal(later.comparison.optimizedAcceptedTargetOutcomeCount, 3);
  assert.notEqual(later.lifecycle.lifecycleObservationId, first.lifecycle.lifecycleObservationId);
});

test("collector retains full grader authority omitted by compact gh-aw run JSONL", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "token-efficiency-graders-"));
  try {
    const logsDirectory = path.join(root, "logs");
    const shardDirectory = path.join(root, "shards");
    const graderDirectory = path.join(logsDirectory, "octo-example", "run-8001", "usage", "graders");
    await mkdir(graderDirectory, { recursive: true });
    await mkdir(shardDirectory, { recursive: true });
    await writeFile(
      path.join(graderDirectory, "grader_results.json"),
      JSON.stringify({ version: 1, results: [operationalValue({
        evidenceAt: "2026-09-17T00:00:00Z",
      })] }),
    );
    await writeFile(
      path.join(shardDirectory, "logs-1.jsonl"),
      `${JSON.stringify(activityRun(8001, {
        variant: "optimized",
        aic: 5,
        startedAt: "2026-09-17T00:00:00Z",
        attempt: 2,
      }))}\n`,
    );

    const observations = await collectGraderEvidence({ logsDirectory, shardDirectory });
    assert.equal(observations.length, 2);
    const grader = observations.find((observation) =>
      observation.kind === "token_efficiency_operational_value_observation");
    const context = observations.find((observation) =>
      observation.kind === "token_efficiency_run_context");
    assert.equal(grader.observation.runId, "8001");
    assert.equal(grader.observation.runAttempt, 2);
    assert.equal(grader.observation.result.implementation.digest, evaluatorDigest);
    assert.equal(grader.observation.sourceProvenance.completeness, "complete");
    assert.equal(context.run.run_id, 8001);
    assert.equal(context.run.run_attempt, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("optimizer assignment selectors must resolve to authoritative runs and evaluator evidence", () => {
  const assignment = {
    targetRepo: "octo/example",
    workflowPath: ".github/workflows/review.md",
    evidenceWindowStart: "2026-09-01T00:00:00Z",
    evidenceWindowEnd: "2026-09-08T00:00:00Z",
    assignmentRunId: "7001",
    experimentId: "review-context-v1",
    evaluatorDigest,
    attributableRunIds: ["7001", "7002"],
  };
  const authoritative = {
    ...assignment,
    attributableRunIds: ["7001", "7002", "5001"],
  };
  assert.equal(
    validateTokenEfficiencyAssignment(
      authoritative,
      envelopes(),
      "githubnext/gh-aw-cao",
    ),
    authoritative,
  );
  assert.throws(
    () => validateTokenEfficiencyAssignment(
      { ...assignment, evaluatorDigest: "0".repeat(64) },
      envelopes(),
      "githubnext/gh-aw-cao",
    ),
    /evaluator digest conflicts/,
  );
  assert.throws(
    () => validateTokenEfficiencyAssignment(
      { ...assignment, attributableRunIds: ["7001", "7999"] },
      envelopes(),
      "githubnext/gh-aw-cao",
    ),
    /authoritative assignment run 7999 is absent/,
  );
});
