#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const INTERVENTION_STATES = new Set([
  "running", "verified", "regressed", "inconclusive",
]);
const EVIDENCE_STATES = new Set([
  "complete", "incomplete", "incomparable", "unavailable",
]);
const COST_GRAINS = new Set(["invocation", "run-aggregate"]);
const ACCEPTED_GRADER_STATUSES = new Set(["accepted", "pass", "passed"]);
const NON_ACCEPTED_GRADER_STATUSES = new Set(["fail", "failed", "rejected"]);
const TOKEN_FIELDS = [
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "reasoningTokens",
];
const CLAIM_FIELDS = new Set([
  "schemaVersion",
  "targetRepo",
  "opportunityId",
  "interventionId",
  "evidenceCutoff",
  "controlRepository",
  "verifierRunId",
  "verifierRunAttempt",
]);
const VERIFIER_WORKFLOW = ".github/workflows/optimization-token-efficiency-verifier.md";
const OPTIMIZATION_OVERHEAD_WORKFLOWS = new Set([
  ".github/workflows/optimization-ai-credit-auditor.md",
  ".github/workflows/optimization-ai-credit-optimizer.md",
  ".github/workflows/optimization-token-optimizer.md",
  VERIFIER_WORKFLOW,
]);

function requiredString(value, field) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value;
}

function finiteNumber(value, field, minimum = 0, maximum = Number.POSITIVE_INFINITY) {
  if (typeof value !== "number"
      || !Number.isFinite(value)
      || value < minimum
      || value > maximum) {
    throw new TypeError(`${field} must be a finite number between ${minimum} and ${maximum}`);
  }
  return value;
}

function positiveInteger(value, field) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw new TypeError(`${field} must be a positive integer`);
  }
  return number;
}

function canonicalTimestamp(value, field) {
  const timestamp = requiredString(value, field);
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) throw new TypeError(`${field} must be an ISO 8601 timestamp`);
  return new Date(parsed).toISOString().replace(".000Z", "Z");
}

function stableDigest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function uniqueAuthoritative(records, description) {
  if (records.length === 0) return undefined;
  const digests = new Set(records.map((record) => stableDigest(record)));
  if (digests.size !== 1) throw new TypeError(`conflicting authoritative ${description}`);
  return records[0];
}

function compact(record) {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

function sourceWorkflowPath(value) {
  return String(value ?? "").replace(/\.lock\.yml$/u, ".md");
}

function runIdentity(run) {
  return `${positiveInteger(run.run_id, "authoritative run id")}:${positiveInteger(
    run.run_attempt ?? 1,
    "authoritative run attempt",
  )}`;
}

function runEnvelope(envelopes, runId, runAttempt, required = false) {
  const matches = envelopes
    .filter((envelope) =>
      ["run", "token_efficiency_run_context"].includes(envelope.kind)
      && String(envelope.run?.run_id) === String(runId)
      && Number(envelope.run?.run_attempt ?? 1) === Number(runAttempt))
    .map((envelope) => envelope.run);
  const run = uniqueAuthoritative(matches, `run evidence for ${runId}:${runAttempt}`);
  if (required && !run) {
    throw new TypeError(`authoritative run evidence absent for ${runId}:${runAttempt}`);
  }
  return run;
}

function runAttempts(envelopes, runId) {
  const attempts = new Map();
  for (const envelope of envelopes) {
    if (!["run", "token_efficiency_run_context"].includes(envelope.kind)
        || String(envelope.run?.run_id) !== String(runId)) {
      continue;
    }
    const identity = runIdentity(envelope.run);
    const records = attempts.get(identity) ?? [];
    records.push(envelope.run);
    attempts.set(identity, records);
  }
  return [...attempts.entries()].map(([identity, records]) => ({
    identity,
    run: uniqueAuthoritative(records, `run evidence for ${identity}`),
  }));
}

function runTimestamp(run, field) {
  return canonicalTimestamp(
    run[field] ?? (field === "started_at" ? run.created_at : run.updated_at),
    `authoritative run ${field}`,
  );
}

function runVariant(run, experimentId) {
  const assigned = run.experiments?.assignments?.[experimentId];
  if (assigned === undefined || assigned === null) return undefined;
  return typeof assigned === "object" ? assigned.variant : assigned;
}

function summaryNumber(summary, field) {
  const snake = field.replace(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`);
  const value = summary?.[field] ?? summary?.[snake];
  return value === undefined || value === null ? null : finiteNumber(value, field);
}

function runCost(run, costGrain) {
  const summary = run.token_usage_summary ?? run.token_usage;
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) {
    return costGrain === "run-aggregate" && run.aic !== undefined && run.aic !== null
      ? finiteNumber(run.aic, "authoritative run AIC")
      : null;
  }
  if (costGrain === "run-aggregate") {
    const aic = summary.total_aic ?? summary.aic ?? run.aic;
    return aic === undefined || aic === null ? null : finiteNumber(aic, "authoritative run AIC");
  }
  const invocations = summary.invocations;
  if (!Array.isArray(invocations) || invocations.length === 0) return null;
  return invocations.reduce((total, invocation, index) =>
    total + finiteNumber(invocation.aic, `authoritative invocation[${index}].aic`), 0);
}

function runTokens(run, costGrain) {
  const summary = run.token_usage_summary ?? run.token_usage;
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) {
    return Object.fromEntries(TOKEN_FIELDS.map((field) => [field, null]));
  }
  if (costGrain === "run-aggregate") {
    return Object.fromEntries(TOKEN_FIELDS.map((field) => {
      const totalField = `total${field[0].toUpperCase()}${field.slice(1)}`;
      let value = summaryNumber(summary, totalField);
      if (value === null && field === "reasoningTokens") {
        const models = summary.by_model && typeof summary.by_model === "object"
          ? Object.values(summary.by_model)
          : [];
        const modelValues = models.map((model) => summaryNumber(model, field));
        value = modelValues.length > 0 && modelValues.every((candidate) => candidate !== null)
          ? modelValues.reduce((sum, candidate) => sum + candidate, 0)
          : null;
      }
      return [field, value];
    }));
  }
  const invocations = summary.invocations;
  if (!Array.isArray(invocations) || invocations.length === 0) {
    return Object.fromEntries(TOKEN_FIELDS.map((field) => [field, null]));
  }
  return Object.fromEntries(TOKEN_FIELDS.map((field) => {
    const values = invocations.map((invocation) => summaryNumber(invocation, field));
    return [field, values.some((value) => value === null)
      ? null
      : values.reduce((total, value) => total + value, 0)];
  }));
}

function tokenTotals(runs) {
  return Object.fromEntries(TOKEN_FIELDS.map((field) => {
    if (!runs.every((run) => run.tokens[field] !== null)) return [field, null];
    return [field, runs.reduce((sum, run) => sum + run.tokens[field], 0)];
  }));
}

function latestLifecycle(envelopes, interventionId, includeVerification = true) {
  const observations = envelopes
    .filter((envelope) =>
      envelope.kind === "token_efficiency_lifecycle_observation"
      && envelope.observation?.interventionId === interventionId
      && (includeVerification
        || envelope.observation?.sourceProvenance?.kind
          !== "matured-token-efficiency-verification"))
    .map((envelope) => envelope.observation)
    .sort((left, right) =>
      Date.parse(right.observedAt) - Date.parse(left.observedAt)
      || String(right.lifecycleObservationId).localeCompare(String(left.lifecycleObservationId)));
  if (observations.length > 1
      && observations[0].observedAt === observations[1].observedAt
      && stableDigest(observations[0]) !== stableDigest(observations[1])) {
    throw new TypeError("conflicting authoritative lifecycle observations");
  }
  return observations[0];
}

function opportunity(envelopes, opportunityId) {
  const candidates = envelopes
    .filter((envelope) =>
      envelope.kind === "token_efficiency_observation"
      && envelope.observation?.opportunityId === opportunityId)
    .map((envelope) => envelope.observation);
  const proposal = uniqueAuthoritative(candidates, "opportunity observations");
  if (proposal) return proposal;
  const retained = envelopes
    .filter((envelope) =>
      envelope.kind === "token_efficiency_lifecycle_observation"
      && envelope.observation?.opportunityId === opportunityId
      && envelope.observation?.verificationContract)
    .map((envelope) => envelope.observation)
    .sort((left, right) => Date.parse(right.observedAt) - Date.parse(left.observedAt));
  return retained[0];
}

function authoritativeTargetRuns(envelopes, expected, window) {
  const candidatesByIdentity = new Map();
  for (const envelope of envelopes) {
    if (!["run", "token_efficiency_run_context"].includes(envelope.kind) || !envelope.run) continue;
    const run = envelope.run;
    if (String(run.repository ?? "").toLowerCase() !== expected.targetRepo
        || sourceWorkflowPath(run.workflow_path) !== sourceWorkflowPath(expected.workflowPath)) {
      continue;
    }
    const identity = runIdentity(run);
    const records = candidatesByIdentity.get(identity) ?? [];
    records.push(run);
    candidatesByIdentity.set(identity, records);
  }

  const selected = [];
  for (const [identity, records] of candidatesByIdentity) {
    const run = uniqueAuthoritative(records, `target run evidence for ${identity}`);
    if (runVariant(run, expected.experimentId) !== expected.variant) continue;
    let startedAt;
    let completedAt;
    try {
      startedAt = runTimestamp(run, "started_at");
      completedAt = runTimestamp(run, "completed_at");
    } catch {
      return { problem: "target-run-timestamp-incomplete", state: "incomplete" };
    }
    if (Date.parse(startedAt) < Date.parse(window.start)
        || Date.parse(startedAt) > Date.parse(window.end)
        || Date.parse(completedAt) < Date.parse(window.start)
        || Date.parse(completedAt) > Date.parse(window.end)) {
      continue;
    }
    selected.push({ identity, run, startedAt, completedAt });
  }
  return {
    runs: selected.sort((left, right) => left.identity.localeCompare(right.identity)),
  };
}

function operationalValueEvidence(envelopes, run, evaluatorDigest, evidenceCutoff) {
  const matches = envelopes
    .filter((envelope) =>
      envelope.kind === "token_efficiency_operational_value_observation"
      && String(envelope.observation?.runId) === String(run.run_id)
      && Number(envelope.observation?.runAttempt ?? 1) === Number(run.run_attempt ?? 1))
    .map((envelope) => envelope.observation)
    .filter((observation) => observation?.result && typeof observation.result === "object");
  if (matches.length === 0) {
    return { problem: "operational-value-grader-evidence-absent", state: "incomplete" };
  }
  const observationRecord = uniqueAuthoritative(
    matches,
    `operational-value grader for ${runIdentity(run)}`,
  );
  const result = observationRecord.result;
  const definition = result.definition ?? result.implementation?.definition;
  if (!definition
      || definition.schemaVersion !== 4
      || definition.grader !== "operational-value"
      || result.implementation?.digest !== evaluatorDigest) {
    return { problem: "operational-value-grader-not-comparable", state: "incomparable" };
  }
  const observation = result.observation;
  if (!observation || typeof observation !== "object" || observation.mature !== true) {
    return { problem: "operational-value-grader-evidence-unmatured", state: "incomplete" };
  }
  let evidenceAt;
  try {
    evidenceAt = canonicalTimestamp(observation.evidenceAt, "operational-value evidenceAt");
    if (observation.maturesAt !== undefined
        && Date.parse(canonicalTimestamp(
          observation.maturesAt,
          "operational-value maturesAt",
        )) > Date.parse(evidenceAt)) {
      return { problem: "operational-value-grader-evidence-unmatured", state: "incomplete" };
    }
  } catch {
    return { problem: "operational-value-grader-evidence-malformed", state: "incomparable" };
  }
  if (Date.parse(evidenceAt) > Date.parse(evidenceCutoff)) {
    return { problem: "operational-value-grader-evidence-after-cutoff", state: "incomparable" };
  }
  const status = String(result.status ?? "").toLowerCase();
  if (!ACCEPTED_GRADER_STATUSES.has(status) && !NON_ACCEPTED_GRADER_STATUSES.has(status)) {
    return { problem: "operational-value-grader-status-incomplete", state: "incomplete" };
  }
  let value;
  try {
    value = finiteNumber(result.value, "operational-value grader value", 0, 1);
  } catch {
    return { problem: "operational-value-grader-value-malformed", state: "incomparable" };
  }
  const identity = `operational-value:${runIdentity(run)}:${evaluatorDigest}`;
  return {
    accepted: ACCEPTED_GRADER_STATUSES.has(status),
    identity,
    value,
    result,
    source: observationRecord,
  };
}

function variantMetrics(envelopes, field, expected, minimumSampleSize, window) {
  const discovery = authoritativeTargetRuns(envelopes, expected, window);
  if (discovery.problem) return discovery;
  if (discovery.runs.length === 0) {
    return { problem: "minimum-comparable-sample-not-reached", state: "incomplete" };
  }

  const runs = [];
  const acceptedOutcomes = new Map();
  const graderRecords = [];
  let qualitySum = 0;
  for (const selected of discovery.runs) {
    const { run, identity } = selected;
    const aic = runCost(run, expected.costGrain);
    if (aic === null) {
      return { problem: "authoritative-run-aic-incomplete", state: "incomplete" };
    }
    if (run.conclusion === null || run.conclusion === undefined || run.conclusion === "") {
      return { problem: "run-conclusion-evidence-incomplete", state: "incomplete" };
    }
    const grader = operationalValueEvidence(
      envelopes,
      run,
      expected.evaluatorDigest,
      expected.evidenceCutoff,
    );
    if (grader.problem) return grader;
    graderRecords.push(grader.source);
    if (grader.accepted) {
      if (acceptedOutcomes.has(grader.identity)) {
        return { problem: "duplicate-accepted-outcome", state: "incomparable" };
      }
      acceptedOutcomes.set(grader.identity, grader);
      qualitySum += grader.value;
    }
    runs.push({
      identity,
      conclusion: run.conclusion,
      aic,
      tokens: runTokens(run, expected.costGrain),
      source: run,
    });
  }

  if (acceptedOutcomes.size < minimumSampleSize) {
    return { problem: "minimum-comparable-sample-not-reached", state: "incomplete" };
  }
  const totalAic = runs.reduce((sum, run) => sum + run.aic, 0);
  return {
    runs,
    acceptedOutcomeIds: [...acceptedOutcomes.keys()].sort(),
    acceptedOutcomeCount: acceptedOutcomes.size,
    aicPerAcceptedOutcome: totalAic / acceptedOutcomes.size,
    failureRate:
      runs.filter((run) => run.conclusion !== "success").length / runs.length,
    quality: qualitySum / acceptedOutcomes.size,
    tokens: tokenTotals(runs),
    sourceRecords: [...runs.map((run) => run.source), ...graderRecords],
  };
}

function recordProvenances(record) {
  return [
    ...(Array.isArray(record?.evidenceProvenance) ? record.evidenceProvenance : []),
    ...(record?.sourceProvenance ? [record.sourceProvenance] : []),
  ];
}

function authoritativeGenerations(records) {
  const byIdentity = new Map();
  for (const provenance of records.flatMap(recordProvenances)) {
    if (!provenance || typeof provenance !== "object") continue;
    const sourceIdentity = provenance.generation ?? provenance.sourceId;
    const identity = sourceIdentity === undefined
      ? `record:${stableDigest(provenance)}`
      : `${provenance.source ?? provenance.kind ?? ""}:${sourceIdentity}`;
    const existing = byIdentity.get(identity);
    if (existing && stableDigest(existing) !== stableDigest(provenance)) {
      throw new TypeError(`conflicting authoritative source generation ${identity}`);
    }
    byIdentity.set(identity, provenance);
  }
  const generations = [...byIdentity.values()];
  if (generations.some((source) =>
    (source.completeness !== undefined && source.completeness !== "complete")
    || (source.freshness !== undefined && source.freshness !== "fresh"))) {
    return {
      generations,
      problem: {
        state: "incomplete",
        reason: "authoritative-source-incomplete-or-stale",
      },
    };
  }
  return { generations };
}

function validOverheadRun(run, controlRepository) {
  return String(run.repository ?? "").toLowerCase() === controlRepository
    && OPTIMIZATION_OVERHEAD_WORKFLOWS.has(sourceWorkflowPath(run.workflow_path));
}

function attributedOverhead({
  envelopes,
  lifecycle,
  proposal,
  verifierRun,
  verifierRunId,
  verifierRunAttempt,
  controlRepository,
  costGrain,
  targetRunIds,
  target,
}) {
  const optimizerRunId = String(positiveInteger(lifecycle.optimizerRunId, "optimizerRunId"));
  const optimizerRunAttempt = positiveInteger(
    lifecycle.optimizerRunAttempt ?? lifecycle.runAttempt,
    "optimizerRunAttempt",
  );
  const optimizerRun = runEnvelope(envelopes, optimizerRunId, optimizerRunAttempt);
  if (!optimizerRun) return { problem: "optimizer-overhead-run-absent" };
  if (!validOverheadRun(optimizerRun, controlRepository)
      || sourceWorkflowPath(optimizerRun.workflow_path)
        !== sourceWorkflowPath(lifecycle.optimizerWorkflowPath)) {
    return { problem: "optimizer-overhead-lineage-mismatch" };
  }
  if (!validOverheadRun(verifierRun, controlRepository)
      || sourceWorkflowPath(verifierRun.workflow_path) !== VERIFIER_WORKFLOW) {
    return { problem: "verifier-overhead-lineage-mismatch" };
  }

  const included = new Map();
  const include = (identity, run) => {
    let aic = runCost(run, costGrain);
    if (aic === null
        && sourceWorkflowPath(run.workflow_path) === VERIFIER_WORKFLOW
        && runCost(run, "run-aggregate") === 0) {
      aic = 0;
    }
    if (aic === null) return false;
    included.set(identity, aic);
    return true;
  };
  if (!include(`${optimizerRunId}:${optimizerRunAttempt}`, optimizerRun)
      || !include(`${verifierRunId}:${verifierRunAttempt}`, verifierRun)) {
    return { problem: "attributable-overhead-aic-incomplete" };
  }

  for (const frozenRunId of new Set((proposal.attributableRunIds ?? []).map(String))) {
    const attempts = runAttempts(envelopes, frozenRunId);
    if (attempts.length === 0) return { problem: "attributable-overhead-run-absent" };
    for (const { identity, run } of attempts) {
      const isTargetEvidenceRun =
        String(run.repository ?? "").toLowerCase() === target.targetRepo
        && sourceWorkflowPath(run.workflow_path) === sourceWorkflowPath(target.workflowPath)
        && [target.controlVariant, target.optimizedVariant]
          .includes(runVariant(run, target.experimentId));
      if (targetRunIds.has(identity)
          || isTargetEvidenceRun
          || !validOverheadRun(run, controlRepository)) {
        continue;
      }
      if (!include(identity, run)) return { problem: "attributable-overhead-aic-incomplete" };
    }
  }
  return {
    total: [...included.values()].reduce((sum, value) => sum + value, 0),
    runIds: [...included.keys()].sort(),
    sourceRecords: [
      optimizerRun,
      verifierRun,
      ...[...included.keys()]
        .filter((identity) =>
          identity !== `${optimizerRunId}:${optimizerRunAttempt}`
          && identity !== `${verifierRunId}:${verifierRunAttempt}`)
        .map((identity) => {
          const [runId, attempt] = identity.split(":");
          return runEnvelope(envelopes, runId, Number(attempt), true);
        }),
    ],
  };
}

function authoritativeLinks(records) {
  return [...new Set(records.flatMap((record) => [
    ...(Array.isArray(record?.evidenceLinks) ? record.evidenceLinks : []),
    ...(Array.isArray(record?.sourceProvenance?.evidenceLinks)
      ? record.sourceProvenance.evidenceLinks
      : []),
  ]).filter((value) => typeof value === "string" && value))].sort();
}

export function hasComparison(envelopes, comparisonId) {
  return envelopes.some((envelope) =>
    envelope.kind === "token_efficiency_comparison_observation"
    && envelope.observation?.comparisonId === comparisonId);
}

function validateClaim(claim) {
  if (claim.schemaVersion !== 1) throw new TypeError("unsupported verification claim schemaVersion");
  const unsupportedClaimFields = Object.keys(claim).filter((field) => !CLAIM_FIELDS.has(field));
  if (unsupportedClaimFields.length > 0) {
    throw new TypeError(`verification claim contains non-selector field: ${unsupportedClaimFields[0]}`);
  }
}

function comparisonIdForClaim(claim, envelopes) {
  const proposal = opportunity(envelopes, requiredString(claim.opportunityId, "opportunityId"));
  if (!proposal?.verificationContract) return undefined;
  return `token-comparison:${requiredString(
    claim.interventionId,
    "interventionId",
  )}:${requiredString(
    proposal.verificationContract.evaluatorDigest,
    "proposal evaluatorDigest",
  )}:${canonicalTimestamp(claim.evidenceCutoff, "evidenceCutoff")}`;
}

export function buildVerificationObservations({ claim, envelopes }) {
  validateClaim(claim);
  const verifierRunId = String(positiveInteger(claim.verifierRunId, "verifierRunId"));
  const verifierRunAttempt = positiveInteger(claim.verifierRunAttempt, "verifierRunAttempt");
  const verifierRun = runEnvelope(envelopes, verifierRunId, verifierRunAttempt, true);
  if (sourceWorkflowPath(verifierRun.workflow_path) !== VERIFIER_WORKFLOW) {
    throw new TypeError("verifier selector does not resolve to the authoritative verifier workflow");
  }
  const observedAt = runTimestamp(verifierRun, "completed_at");
  const controlRepository = requiredString(
    verifierRun.repository,
    "authoritative verifier repository",
  ).toLowerCase();
  if (claim.controlRepository !== undefined
      && String(claim.controlRepository).toLowerCase() !== controlRepository) {
    throw new TypeError("verification changes the authoritative control repository");
  }

  const opportunityId = requiredString(claim.opportunityId, "opportunityId");
  const interventionId = requiredString(claim.interventionId, "interventionId");
  const previousLifecycle = latestLifecycle(envelopes, interventionId);
  const lifecycle = latestLifecycle(envelopes, interventionId, false);
  if (!lifecycle
      || lifecycle.opportunityId !== opportunityId
      || lifecycle.recommendationDisposition !== "applied"
      || !INTERVENTION_STATES.has(lifecycle.interventionState)
      || !lifecycle.implementationChangeId
      || !lifecycle.implementationCompletedAt) {
    throw new TypeError("verification requires one authoritative applied implementation");
  }
  const proposal = opportunity(envelopes, opportunityId);
  if (!proposal) throw new TypeError("verification requires its authoritative frozen opportunity");
  if (proposal.interventionId !== interventionId) {
    throw new TypeError("verification intervention conflicts with its authoritative opportunity");
  }
  if (String(proposal.controlRepository).toLowerCase() !== controlRepository
      || (lifecycle.controlRepository !== undefined
        && String(lifecycle.controlRepository).toLowerCase() !== controlRepository)
      || String(lifecycle.optimizerRunId) !== String(proposal.optimizerRunId)
      || Number(lifecycle.optimizerRunAttempt ?? lifecycle.runAttempt)
        !== Number(proposal.optimizerRunAttempt ?? proposal.runAttempt)) {
    throw new TypeError("verification control lineage conflicts with authoritative evidence");
  }

  const targetRepo = requiredString(proposal.targetRepo, "proposal targetRepo").toLowerCase();
  const workflowPath = requiredString(proposal.workflowPath, "proposal workflowPath");
  const experimentId = requiredString(proposal.experimentId, "proposal experimentId");
  if (String(claim.targetRepo).toLowerCase() !== targetRepo
      || String(lifecycle.targetRepo).toLowerCase() !== targetRepo
      || sourceWorkflowPath(lifecycle.workflowPath) !== sourceWorkflowPath(workflowPath)
      || lifecycle.experimentId !== experimentId) {
    throw new TypeError("verification identity conflicts with authoritative intervention evidence");
  }

  const contract = proposal.verificationContract;
  if (!contract || typeof contract !== "object" || Array.isArray(contract)) {
    throw new TypeError("authoritative opportunity does not freeze a verification contract");
  }
  const evaluatorDigest = requiredString(contract.evaluatorDigest, "proposal evaluatorDigest");
  const costGrain = requiredString(contract.costGrain, "proposal costGrain");
  if (!COST_GRAINS.has(costGrain)) throw new TypeError("invalid authoritative comparison costGrain");
  const controlVariant = requiredString(contract.controlVariant, "proposal controlVariant");
  const optimizedVariant = requiredString(contract.optimizedVariant, "proposal optimizedVariant");
  const workloadComparisonKey = requiredString(
    contract.workloadComparisonKey,
    "proposal workloadComparisonKey",
  );
  const acceptanceRuleDigest = requiredString(
    contract.acceptanceRuleDigest,
    "proposal acceptanceRuleDigest",
  );
  const minimumSampleSize = positiveInteger(
    contract.minimumSampleSize,
    "proposal minimumSampleSize",
  );
  const minimumMaturityDays = positiveInteger(
    contract.minimumMaturityDays,
    "proposal minimumMaturityDays",
  );

  const baselineStart = canonicalTimestamp(
    proposal.evidenceWindowStart,
    "proposal evidenceWindowStart",
  );
  const baselineEnd = canonicalTimestamp(
    proposal.evidenceWindowEnd,
    "proposal evidenceWindowEnd",
  );
  const optimizedStart = canonicalTimestamp(
    lifecycle.implementationCompletedAt,
    "lifecycle implementationCompletedAt",
  );
  const evidenceCutoff = canonicalTimestamp(claim.evidenceCutoff, "evidenceCutoff selector");
  if (Date.parse(evidenceCutoff) > Date.parse(observedAt)) {
    throw new TypeError("verification evidence cutoff is after the authoritative verifier run");
  }
  const maturityAt = new Date(
    Date.parse(optimizedStart) + minimumMaturityDays * 24 * 60 * 60 * 1000,
  ).toISOString().replace(".000Z", "Z");
  if (Date.parse(evidenceCutoff) < Date.parse(maturityAt)) {
    throw new TypeError("verification evidence is not mature");
  }

  const comparisonId =
    `token-comparison:${interventionId}:${evaluatorDigest}:${evidenceCutoff}`;
  const baselineWindow = { start: baselineStart, end: baselineEnd };
  const optimizedWindow = { start: optimizedStart, end: evidenceCutoff };
  const expected = {
    targetRepo,
    workflowPath,
    experimentId,
    evaluatorDigest,
    costGrain,
    evidenceCutoff,
  };
  const baseline = variantMetrics(
    envelopes,
    "baseline",
    { ...expected, variant: controlVariant },
    minimumSampleSize,
    baselineWindow,
  );
  const optimized = variantMetrics(
    envelopes,
    "optimized",
    { ...expected, variant: optimizedVariant },
    minimumSampleSize,
    optimizedWindow,
  );
  const targetRunIds = new Set([
    ...(baseline.runs ?? []).map((run) => run.identity),
    ...(optimized.runs ?? []).map((run) => run.identity),
  ]);
  const overhead = attributedOverhead({
    envelopes,
    lifecycle,
    proposal,
    verifierRun,
    verifierRunId,
    verifierRunAttempt,
    controlRepository,
    costGrain,
    targetRunIds,
    target: {
      targetRepo,
      workflowPath,
      experimentId,
      controlVariant,
      optimizedVariant,
    },
  });
  const sourceRecords = [
    proposal,
    lifecycle,
    ...(baseline.sourceRecords ?? []),
    ...(optimized.sourceRecords ?? []),
    ...(overhead.sourceRecords ?? []),
  ];
  const generationEvidence = authoritativeGenerations(sourceRecords);
  let problem = generationEvidence.problem;
  if (!problem && baseline.problem) problem = { state: baseline.state, reason: baseline.problem };
  if (!problem && optimized.problem) problem = { state: optimized.state, reason: optimized.problem };
  if (!problem && overhead.problem) {
    problem = { state: "incomplete", reason: overhead.problem };
  }
  if (!problem && baseline.aicPerAcceptedOutcome <= 0) {
    problem = { state: "unavailable", reason: "baseline-cost-denominator-non-positive" };
  }
  const evidenceState = problem?.state ?? "complete";
  if (!EVIDENCE_STATES.has(evidenceState)) throw new TypeError("invalid derived evidence state");

  const base = {
    schemaVersion: 1,
    comparisonId,
    observedAt,
    controlRepository,
    verifierRunId,
    verifierRunAttempt,
    verifierWorkflowPath: VERIFIER_WORKFLOW,
    verifierWorkflowName: "AW Optimization / Token Efficiency Verifier",
    targetRepo,
    workflowPath,
    opportunityId,
    interventionId,
    implementationChangeId: lifecycle.implementationChangeId,
    experimentId,
    evaluatorDigest,
    costGrain,
    controlVariant,
    optimizedVariant,
    baselineWindow,
    optimizedWindow,
    workloadComparisonKey,
    acceptanceRuleDigest,
    minimumSampleSize,
    maturityAt,
    maturityStatus: "mature",
    evidenceCutoff,
    sourceGenerations: generationEvidence.generations,
    evidenceLinks: authoritativeLinks(sourceRecords),
    evidenceState,
    missingReason: problem?.reason,
  };

  let comparison = base;
  let interventionState = "inconclusive";
  if (evidenceState === "complete") {
    const outcomeQualityPreserved = optimized.quality >= baseline.quality;
    const reliabilityPreserved = optimized.failureRate <= baseline.failureRate;
    const costImproved =
      optimized.aicPerAcceptedOutcome < baseline.aicPerAcceptedOutcome;
    const grossRealizedSavingsAic = outcomeQualityPreserved && reliabilityPreserved
      ? Math.max(
        baseline.aicPerAcceptedOutcome - optimized.aicPerAcceptedOutcome,
        0,
      ) * optimized.acceptedOutcomeCount
      : 0;
    const optimizationOverheadAic = overhead.total;
    const netRealizedSavingsAic = grossRealizedSavingsAic - optimizationOverheadAic;
    const verifiedNetGain = outcomeQualityPreserved
      && reliabilityPreserved
      && costImproved
      && netRealizedSavingsAic > 0
      ? Math.min(
        1,
        Math.max(
          0,
          netRealizedSavingsAic
            / (baseline.aicPerAcceptedOutcome * optimized.acceptedOutcomeCount),
        ),
      )
      : 0;
    interventionState = verifiedNetGain > 0 ? "verified" : "regressed";
    comparison = {
      ...comparison,
      baselineAicPerAcceptedOutcome: baseline.aicPerAcceptedOutcome,
      optimizedAicPerAcceptedOutcome: optimized.aicPerAcceptedOutcome,
      baselineAcceptedTargetOutcomeCount: baseline.acceptedOutcomeCount,
      optimizedAcceptedTargetOutcomeCount: optimized.acceptedOutcomeCount,
      acceptedTargetOutcomeCount: optimized.acceptedOutcomeCount,
      baselineFailureRate: baseline.failureRate,
      optimizedFailureRate: optimized.failureRate,
      outcomeQualityPreserved,
      reliabilityPreserved,
      grossRealizedSavingsAic,
      optimizationOverheadAic,
      netRealizedSavingsAic,
      verifiedNetGain,
      attributableOverheadRunIds: overhead.runIds,
      ...Object.fromEntries(TOKEN_FIELDS.flatMap((field) => [
        [`baseline${field[0].toUpperCase()}${field.slice(1)}`, baseline.tokens[field]],
        [`optimized${field[0].toUpperCase()}${field.slice(1)}`, optimized.tokens[field]],
      ])),
    };
  }

  const lifecycleObservation = compact({
    ...lifecycle,
    schemaVersion: 1,
    lifecycleObservationId:
      `token-lifecycle:${stableDigest({ interventionId, comparisonId })}`,
    observedAt,
    previousInterventionState: previousLifecycle.interventionState,
    previousRecommendationDisposition: "applied",
    interventionState,
    recommendationDisposition: "applied",
    evidenceState,
    missingReason: problem?.reason,
    verificationComparisonId: comparisonId,
    sourceProvenance: {
      kind: "matured-token-efficiency-verification",
      sourceId:
        `github-actions-run:${controlRepository}:${verifierRunId}:attempt:${verifierRunAttempt}`,
      sourceSchemaRevision: 1,
      repository: controlRepository,
      runId: verifierRunId,
      runAttempt: verifierRunAttempt,
      observedAt,
      generation: comparisonId,
      completeness: evidenceState === "complete" ? "complete" : "partial",
      freshness: "fresh",
      evidenceLinks: comparison.evidenceLinks,
    },
  });
  return {
    comparison: compact(comparison),
    lifecycle: lifecycleObservation,
  };
}

async function filesUnder(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(candidate));
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(candidate);
  }
  return files;
}

async function readEnvelopes(directory) {
  const envelopes = [];
  for (const file of await filesUnder(directory)) {
    const content = await readFile(file, "utf8");
    for (const line of content.split(/\r?\n/u)) {
      if (line.trim()) envelopes.push(JSON.parse(line));
    }
  }
  return envelopes;
}

async function readEnvelopeFile(file) {
  const content = await readFile(file, "utf8");
  return content.split(/\r?\n/u).filter((line) => line.trim()).map((line) => JSON.parse(line));
}

async function main(args) {
  const options = new Map();
  for (let index = 0; index < args.length; index += 2) options.set(args[index], args[index + 1]);
  const claimPath = options.get("--claim");
  const shardDirectory = options.get("--shard-dir");
  if (!claimPath || !shardDirectory) {
    throw new TypeError("usage: token-efficiency-verifier.mjs --claim FILE --shard-dir DIRECTORY");
  }
  const claim = JSON.parse(await readFile(claimPath, "utf8"));
  validateClaim(claim);
  const envelopes = await readEnvelopes(shardDirectory);
  const historyPath = options.get("--history-file");
  if (historyPath) envelopes.push(...await readEnvelopeFile(historyPath));
  const comparisonId = comparisonIdForClaim(claim, envelopes);
  if (comparisonId && hasComparison(envelopes, comparisonId)) return;
  const observations = buildVerificationObservations({ claim, envelopes });
  const sourceRun = runEnvelope(envelopes, claim.verifierRunId, claim.verifierRunAttempt);
  if (!sourceRun) throw new TypeError("verification claim requires its verifier run envelope");
  process.stdout.write(`${JSON.stringify({
    schema_version: 2,
    kind: "token_efficiency_run_context",
    run: sourceRun,
  })}\n`);
  process.stdout.write(`${JSON.stringify({
    schema_version: 2,
    kind: "token_efficiency_comparison_observation",
    created_at: observations.comparison.observedAt,
    observation: observations.comparison,
  })}\n`);
  process.stdout.write(`${JSON.stringify({
    schema_version: 2,
    kind: "token_efficiency_lifecycle_observation",
    created_at: observations.lifecycle.observedAt,
    observation: observations.lifecycle,
  })}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
