#!/usr/bin/env node

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

async function filesUnder(directory, name) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(candidate, name));
    else if (entry.isFile() && (!name || entry.name === name)) files.push(candidate);
  }
  return files;
}

async function authoritativeRuns(shardDirectory) {
  const runs = new Map();
  for (const file of await filesUnder(shardDirectory, "")) {
    if (!file.endsWith(".jsonl")) continue;
    const content = await readFile(file, "utf8");
    for (const line of content.split(/\r?\n/u)) {
      if (!line.trim()) continue;
      const envelope = JSON.parse(line);
      if (envelope.kind !== "run" || !envelope.run?.run_id) continue;
      const runId = String(envelope.run.run_id);
      const attempt = Number(envelope.run.run_attempt ?? 1);
      const existing = runs.get(runId);
      if (!existing || Number(existing.run_attempt ?? 1) < attempt) runs.set(runId, envelope.run);
      else if (Number(existing.run_attempt ?? 1) === attempt
          && JSON.stringify(existing) !== JSON.stringify(envelope.run)) {
        throw new TypeError(`conflicting authoritative run evidence for ${runId}:${attempt}`);
      }
    }
  }
  return runs;
}

export async function collectGraderEvidence({ logsDirectory, shardDirectory }) {
  const runs = await authoritativeRuns(shardDirectory);
  const observations = [];
  for (const file of await filesUnder(logsDirectory, "grader_results.json")) {
    const runId = file.split(path.sep).find((segment) => /^run-[0-9]+$/u.test(segment))
      ?.slice("run-".length);
    if (!runId || !runs.has(runId)) continue;
    const run = runs.get(runId);
    const runAttempt = Number(run.run_attempt ?? 1);
    const document = JSON.parse(await readFile(file, "utf8"));
    const matches = (Array.isArray(document.results) ? document.results : [])
      .filter((result) =>
        result?.id === "operational-value" && result?.source === "operational-value");
    if (matches.length !== 1) continue;
    observations.push(
      {
        schema_version: 2,
        kind: "token_efficiency_run_context",
        run,
      },
      {
        schema_version: 2,
        kind: "token_efficiency_operational_value_observation",
        observation: {
          runId,
          runAttempt,
          result: matches[0],
          sourceProvenance: {
            source: "gh-aw-grader-artifact",
            sourceId: `github-actions-run:${runId}:attempt:${runAttempt}:grader:operational-value`,
            sourceSchemaRevision: Number(document.version ?? 1),
            generation: `run-${runId}-attempt-${runAttempt}`,
            completeness: "complete",
            freshness: "fresh",
          },
        },
      },
    );
  }
  return observations.sort((left, right) =>
    Number(left.observation?.runId ?? left.run?.run_id)
      - Number(right.observation?.runId ?? right.run?.run_id)
    || String(left.kind).localeCompare(String(right.kind)));
}

async function main(args) {
  const options = new Map();
  for (let index = 0; index < args.length; index += 2) options.set(args[index], args[index + 1]);
  const logsDirectory = options.get("--logs-dir");
  const shardDirectory = options.get("--shard-dir");
  if (!logsDirectory || !shardDirectory) {
    throw new TypeError(
      "usage: token-efficiency-grader-evidence.mjs --logs-dir DIRECTORY --shard-dir DIRECTORY",
    );
  }
  const current = await collectGraderEvidence({ logsDirectory, shardDirectory });
  let history = [];
  const historyFile = options.get("--history-file");
  if (historyFile) {
    try {
      history = (await readFile(historyFile, "utf8"))
        .split(/\r?\n/u)
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  const merged = new Map();
  for (const observation of [...history, ...current]) {
    let identity;
    if (observation.kind === "token_efficiency_operational_value_observation") {
      const result = observation.observation?.result;
      identity = [
        observation.kind,
        observation.observation?.runId,
        observation.observation?.runAttempt ?? 1,
        result?.implementation?.digest,
      ].join(":");
    } else if (observation.kind === "token_efficiency_run_context") {
      identity = [
        observation.kind,
        observation.run?.run_id,
        observation.run?.run_attempt ?? 1,
      ].join(":");
    } else {
      continue;
    }
    merged.set(identity, observation);
  }
  for (const observation of [...merged.values()].sort((left, right) =>
    Number(left.observation?.runId ?? left.run?.run_id)
      - Number(right.observation?.runId ?? right.run?.run_id)
    || String(left.kind).localeCompare(String(right.kind)))) {
    process.stdout.write(`${JSON.stringify(observation)}\n`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
