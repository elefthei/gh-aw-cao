#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

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

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function sourcePath(value) {
  return String(value ?? "").replace(/\.lock\.yml$/u, ".md");
}

function timestamp(run) {
  return Date.parse(run.started_at ?? run.created_at);
}

function exactRun(envelopes, runId) {
  const records = envelopes
    .filter((envelope) => envelope.kind === "run" && String(envelope.run?.run_id) === runId)
    .map((envelope) => envelope.run);
  if (records.length === 0) throw new TypeError(`authoritative assignment run ${runId} is absent`);
  const attempts = new Set(records.map((run) => Number(run.run_attempt ?? 1)));
  if (attempts.size !== 1 || new Set(records.map(digest)).size !== 1) {
    throw new TypeError(`authoritative assignment run ${runId} is ambiguous`);
  }
  return records[0];
}

const OVERHEAD_WORKFLOWS = new Set([
  ".github/workflows/optimization-ai-credit-auditor.md",
  ".github/workflows/optimization-ai-credit-optimizer.md",
  ".github/workflows/optimization-token-optimizer.md",
]);

export function validateTokenEfficiencyAssignment(assignment, envelopes, controlRepository) {
  const targetRepo = String(assignment.targetRepo ?? "").toLowerCase();
  const workflowPath = sourcePath(assignment.workflowPath);
  const experimentId = String(assignment.experimentId ?? "");
  const start = Date.parse(assignment.evidenceWindowStart);
  const end = Date.parse(assignment.evidenceWindowEnd);
  const attributable = new Set((assignment.attributableRunIds ?? []).map(String));
  if (!attributable.has(String(assignment.assignmentRunId))) {
    throw new TypeError("assignment Run must be included in attributable Run IDs");
  }

  for (const runId of attributable) {
    const run = exactRun(envelopes, runId);
    const assignedVariant = run.experiments?.assignments?.[experimentId];
    const observedAt = timestamp(run);
    const targetEvidence = String(run.repository ?? "").toLowerCase() === targetRepo
      && sourcePath(run.workflow_path) === workflowPath
      && typeof assignedVariant === "string"
      && Number.isFinite(observedAt)
      && observedAt >= start
      && observedAt <= end;
    const overheadEvidence = controlRepository
      && String(run.repository ?? "").toLowerCase() === controlRepository.toLowerCase()
      && OVERHEAD_WORKFLOWS.has(sourcePath(run.workflow_path));
    if (!targetEvidence && !overheadEvidence) {
      throw new TypeError(`attributable Run ${runId} conflicts with the frozen assignment`);
    }
  }

  const assignmentRun = exactRun(envelopes, String(assignment.assignmentRunId));
  const assignmentAttempt = Number(assignmentRun.run_attempt ?? 1);
  const evaluatorRecords = envelopes.filter((envelope) =>
    envelope.kind === "token_efficiency_operational_value_observation"
    && String(envelope.observation?.runId) === String(assignment.assignmentRunId)
    && Number(envelope.observation?.runAttempt ?? 1) === assignmentAttempt);
  if (evaluatorRecords.length === 0) {
    throw new TypeError("authoritative assignment evaluator evidence is absent");
  }
  const evaluatorDigests = new Set(evaluatorRecords.map((envelope) =>
    envelope.observation?.result?.implementation?.digest));
  if (evaluatorDigests.size !== 1 || !evaluatorDigests.has(assignment.evaluatorDigest)) {
    throw new TypeError("evaluator digest conflicts with authoritative assignment evidence");
  }
  return assignment;
}

async function main(args) {
  const options = new Map();
  for (let index = 0; index < args.length; index += 2) options.set(args[index], args[index + 1]);
  const assignmentPath = options.get("--assignment");
  const shardDirectory = options.get("--shard-dir");
  const controlRepository = options.get("--control-repository");
  if (!assignmentPath || !shardDirectory || !controlRepository) {
    throw new TypeError(
      "usage: token-efficiency-assignment.mjs --assignment FILE --shard-dir DIRECTORY --control-repository OWNER/REPO",
    );
  }
  const assignment = JSON.parse(await readFile(assignmentPath, "utf8"));
  validateTokenEfficiencyAssignment(
    assignment,
    await readEnvelopes(shardDirectory),
    controlRepository,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
