import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { parse } from "yaml";

const executeFile = promisify(execFile);
const catalog = path.resolve(".");
const installScript = path.join(catalog, "install.sh");
const installerSource = await readFile(installScript, "utf8");
const manifest = parse(await readFile(path.join(catalog, "aw.yml"), "utf8"));
const supportedGhAw = manifest["min-version"];
const [major, minor, patch] = supportedGhAw.slice(1).split(".").map(Number);
const olderGhAw = patch > 0 ? `v${major}.${minor}.${patch - 1}` : `${supportedGhAw}-rc.1`;
const newerGhAw = `v${major}.${minor + 1}.0`;
const manifestGhAw = `v${major}.${minor}.${patch + 1}`;
const revision = "1".repeat(40);
const timeout = 30_000;
const policyPath = path.join(".github", "workflows", "cao.json");
const materializer = path.join(".github", "workflows", "shared", "materialize-cao.mjs");
const manualUpgrade = (version) => new RegExp(`Run \`curl -sL \\S+/install-gh-aw\\.sh \\| bash -s -- ${version.replaceAll(".", "\\.")}\`, then rerun the CAO installer`);
const upgradePrompt = /Upgrade it now with curl -sL \S+\/install-gh-aw\.sh \| bash -s -- v\S+\? \[y\/N\]/;
const addedFiles = [
  ...manifest.resources.map(({ source, destination }) => ({ source, destination })),
  ...[".github/workflows/cao-activity.yml", ".github/workflows/cao-dashboard.yml"]
    .map((file) => ({ source: file, destination: file })),
];

const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "cao-install-fixture-"));
const archive = path.join(fixtureRoot, "gh-aw-cao.tar.gz");
const mockFetch = path.join(fixtureRoot, "mock-fetch.mjs");
await executeFile("tar", [
  "-czf", archive,
  "--exclude=node_modules", "--exclude=dist", "--exclude=test-results",
  "-C", path.dirname(catalog),
  ...["activity", "dashboard", "cao.sh", "skills", ".github/actions/setup-cao-runtime", ".github/cao/instructions.md"]
    .map((member) => `${path.basename(catalog)}/${member}`),
]);
await writeFile(mockFetch, `
import { readFileSync } from "node:fs";

const expected = "https://codeload.github.com/githubnext/gh-aw-cao/tar.gz/${revision}";
globalThis.fetch = async (input) => {
  const url = typeof input === "string" ? input : input.url ?? String(input);
  if (url !== expected) throw new Error("unexpected fetch: " + url);
  const status = Number(process.env.FAKE_CAO_ARCHIVE_STATUS || 200);
  if (status !== 200) return new Response("unavailable", { status });
  return new Response(readFileSync(process.env.FAKE_CAO_ARCHIVE));
};
`);
test.after(() => rm(fixtureRoot, { recursive: true, force: true }));

const fakeGh = `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-} \${2:-}" == "aw version" ]]; then
  [[ -f "$FAKE_GH_AW_INSTALLED" ]] || exit 1
  echo "gh aw version $(cat "$FAKE_GH_AW_INSTALLED")" >&2
  exit 0
fi
if [[ "\${1:-} \${2:-}" == "aw add" && "\${3:-}" == githubnext/gh-aw-cao* ]]; then
  stdin_bytes="$(wc -c | tr -d ' ')"
  entry=add
  [[ "\${4:-}" != "--force" ]] || entry=add-force
  [[ "$stdin_bytes" == 0 ]] || entry="$entry stdin=$stdin_bytes"
  echo "$entry" >> "$FAKE_COMMAND_LOG"
  if [[ -n "\${FAKE_ADD_FAILURE:-}" ]]; then
    echo "campaign add failed" >&2
    exit 1
  fi
  current="$(cat "$FAKE_GH_AW_INSTALLED")"
  if [[ -n "\${FAKE_MANIFEST_MIN_VERSION:-}" && "$current" != "$FAKE_MANIFEST_MIN_VERSION" ]]; then
    echo "✗ invalid Agentic Workflow manifest \\"aw.yml\\": min-version \\"$FAKE_MANIFEST_MIN_VERSION\\" requires gh-aw $FAKE_MANIFEST_MIN_VERSION or newer (current: $current)." >&2
    exit 1
  fi
${addedFiles.map(({ source, destination }) => `  mkdir -p "$(dirname '${destination}')"
  cp "$FAKE_CATALOG/${source}" '${destination}'`).join("\n")}
  mkdir -p .github/aw/packages
  cat > .github/aw/packages/githubnext-gh-aw-cao-c6b3479204cc.json <<'EOF'
{"package":"githubnext/gh-aw-cao","source":"githubnext/gh-aw-cao@${revision}","resolvedCommit":"${revision}"}
EOF
  exit 0
fi
exit 2
`;

// Serves gh-aw's install script, which records the requested version as installed.
const fakeCurl = `#!/usr/bin/env bash
echo "curl" >> "$FAKE_COMMAND_LOG"
if [[ -n "\${FAKE_INSTALL_FAILURE:-}" ]]; then
  echo "curl: (22) The requested URL returned error: 503" >&2
  exit 22
fi
[[ -z "\${FAKE_INSTALL_NOOP:-}" ]] || exit 0
cat <<'EOF'
printf '%s\\n' "$1" > "$FAKE_GH_AW_INSTALLED"
EOF
`;

async function createConsumer(t, ghAwVersion) {
  const root = await mkdtemp(path.join(os.tmpdir(), "cao-install-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin");
  const consumer = path.join(root, "consumer");
  const log = path.join(root, "commands.log");
  const ghAwInstalled = path.join(root, "gh-aw-installed");
  await mkdir(bin);
  await mkdir(consumer);
  await writeFile(log, "");
  for (const [name, source] of [["gh", fakeGh], ["curl", fakeCurl], ["curl.exe", fakeCurl]]) {
    await writeFile(path.join(bin, name), source);
    await chmod(path.join(bin, name), 0o755);
  }
  if (ghAwVersion) await writeFile(ghAwInstalled, `${ghAwVersion}\n`);
  const env = {
    ...process.env,
    PATH: `${bin.replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`).replaceAll("\\", "/")}:${process.env.PATH}`,
    NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${pathToFileURL(mockFetch).href}`].filter(Boolean).join(" "),
    FAKE_CATALOG: catalog,
    FAKE_CAO_ARCHIVE: archive,
    FAKE_COMMAND_LOG: log,
    FAKE_GH_AW_INSTALLED: ghAwInstalled,
  };
  return {
    consumer,
    env,
    log: () => readFile(log, "utf8"),
    installedGhAw: () => readFile(ghAwInstalled, "utf8"),
  };
}

function collect(child, resolve, reject) {
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  child.on("error", reject);
  child.stdin.on("error", reject);
  child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
}

// Detached children start a new session without a controlling terminal, so
// /dev/tty is unavailable regardless of how the test runner was launched.
function runStreamed(cwd, env, installerArguments = []) {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", ["-s", "--", ...installerArguments], { cwd, env, timeout, detached: true });
    collect(child, resolve, reject);
    child.stdin.end(installerSource);
  });
}

async function streamInstaller(cwd, env, installerArguments) {
  const result = await runStreamed(cwd, env, installerArguments);
  assert.equal(result.code, 0, `installer failed (${result.signal ?? "no signal"}):\n${result.stdout}\n${result.stderr}`);
  return result;
}

// script(1) gives the streamed installer a controlling terminal that receives the answer.
function runWithTerminal(cwd, env, answer) {
  const quoted = `'${installScript.replaceAll("'", "'\\''")}'`;
  return new Promise((resolve, reject) => {
    const child = spawn("script", ["-q", "-e", "-c", `cat ${quoted} | bash`, "/dev/null"], {
      cwd, env, timeout, detached: true,
    });
    collect(child, resolve, reject);
    child.stdin.end(`${answer}\n`);
  });
}

function runFile(cwd, env, installerArguments = []) {
  return executeFile("bash", [installScript, ...installerArguments], { cwd, env, timeout, detached: true });
}

async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function assertExecutable(file) {
  if (process.platform !== "win32") assert.notEqual((await stat(file)).mode & 0o111, 0);
}

async function assertCompleteInstall(consumer, env, ghAwVersion) {
  const policy = JSON.parse(await readFile(path.join(consumer, policyPath), "utf8"));
  assert.equal(policy.version, 1);
  assert.equal(policy["gh-aw-version"], ghAwVersion);
  assert.deepEqual(policy["control-plane"], { campaigns: {} });
  await assertExecutable(path.join(consumer, "cao.sh"));
  const launcher = process.platform === "win32" ? ["bash", ["./cao.sh", "--help"]] : ["./cao.sh", ["--help"]];
  await executeFile(...launcher, { cwd: consumer, env, timeout });
  for (const bundle of ["activity", "dashboard"]) {
    await executeFile(process.execPath, [materializer, "verify", bundle], { cwd: consumer, env, timeout });
  }
}

async function assertNothingInstalled(consumer) {
  assert.equal(await exists(path.join(consumer, policyPath)), false);
  assert.equal(await exists(path.join(consumer, "cao.sh")), false);
}

for (const [state, initialVersion, expectedVersion, expectedLog] of [
  ["missing gh-aw", undefined, supportedGhAw, "curl\nadd\n"],
  [`gh-aw ${supportedGhAw}`, supportedGhAw, supportedGhAw, "add\n"],
  [`gh-aw ${newerGhAw}`, newerGhAw, newerGhAw, "add\n"],
]) {
  test(`streamed install.sh with ${state} materializes the runtime and initializes policy`, async (t) => {
    const { consumer, env, log } = await createConsumer(t, initialVersion);
    await streamInstaller(consumer, env);
    assert.equal(await log(), expectedLog);
    await assertCompleteInstall(consumer, env, expectedVersion);
  });
}

test(`streamed install.sh with gh-aw ${olderGhAw} and no terminal stops with upgrade guidance`, async (t) => {
  const { consumer, env, log, installedGhAw } = await createConsumer(t, olderGhAw);
  const result = await streamInstaller(consumer, env);
  assert.match(result.stdout, manualUpgrade(supportedGhAw));
  assert.equal(await log(), "");
  assert.equal(await installedGhAw(), `${olderGhAw}\n`);
  await assertNothingInstalled(consumer);
});

test(`streamed install.sh requires the local aw.yml min-version ${manifestGhAw} before adding`, async (t) => {
  const { consumer, env, log, installedGhAw } = await createConsumer(t, supportedGhAw);
  await writeFile(path.join(consumer, "aw.yml"), `min-version: ${manifestGhAw}\n`);
  const result = await streamInstaller(consumer, env);
  assert.match(result.stdout, manualUpgrade(manifestGhAw));
  assert.equal(await log(), "");
  assert.equal(await installedGhAw(), `${supportedGhAw}\n`);
  await assertNothingInstalled(consumer);
});

test("install.sh exits nonzero when a fresh gh-aw install does not provide the required version", async (t) => {
  const { consumer, env, log } = await createConsumer(t);
  const result = await runStreamed(consumer, { ...env, FAKE_INSTALL_NOOP: "1" });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, new RegExp(`Failed to verify gh-aw installation: expected at least ${supportedGhAw.replaceAll(".", "\\.")}, got no version`));
  assert.equal(await log(), "curl\n");
  await assertNothingInstalled(consumer);
});

test("install.sh does not retry when the campaign manifest rejects the installed gh-aw", async (t) => {
  const { consumer, env, log, installedGhAw } = await createConsumer(t, supportedGhAw);
  const result = await runStreamed(consumer, { ...env, FAKE_MANIFEST_MIN_VERSION: manifestGhAw });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, new RegExp(`min-version "${manifestGhAw}" requires gh-aw`));
  assert.equal(await log(), "add\n");
  assert.equal(await installedGhAw(), `${supportedGhAw}\n`);
  await assertNothingInstalled(consumer);
});

const terminalCases = [
  {
    name: `approved upgrade of gh-aw ${olderGhAw} completes installation`,
    initialVersion: olderGhAw,
    answer: "y",
    expectedLog: "curl\nadd\n",
    expectedVersion: supportedGhAw,
  },
  {
    name: `declined upgrade of gh-aw ${olderGhAw} stops with upgrade guidance`,
    initialVersion: olderGhAw,
    answer: "n",
    expectedLog: "",
  },
  {
    name: `failed approved upgrade of gh-aw ${olderGhAw} exits nonzero`,
    initialVersion: olderGhAw,
    answer: "y",
    environment: { FAKE_INSTALL_FAILURE: "1" },
    expectedLog: "curl\n",
    failure: /Failed to install gh-aw/,
  },
  {
    name: `approved upgrade that does not provide gh-aw ${supportedGhAw} exits nonzero`,
    initialVersion: olderGhAw,
    answer: "y",
    environment: { FAKE_INSTALL_NOOP: "1" },
    expectedLog: "curl\n",
    failure: /Failed to verify gh-aw installation/,
  },
  {
    name: `approved upgrade to the local aw.yml min-version ${manifestGhAw} completes installation`,
    initialVersion: supportedGhAw,
    answer: "y",
    manifest: manifestGhAw,
    expectedLog: "curl\nadd\n",
    expectedVersion: manifestGhAw,
  },
];

for (const { name, initialVersion, answer, environment = {}, manifest, expectedLog, expectedVersion, failure } of terminalCases) {
  test(`install.sh on a terminal: ${name}`, { skip: process.platform === "win32" }, async (t) => {
    const { consumer, env, log, installedGhAw } = await createConsumer(t, initialVersion);
    if (manifest) await writeFile(path.join(consumer, "aw.yml"), `min-version: ${manifest}\n`);
    const terminalEnv = { ...env, ...environment };
    const result = await runWithTerminal(consumer, terminalEnv, answer);
    assert.match(result.stdout, upgradePrompt);
    assert.equal(await log(), expectedLog);
    if (failure) {
      assert.notEqual(result.code, 0, result.stdout);
      assert.match(result.stdout, failure);
      assert.equal(await installedGhAw(), `${initialVersion}\n`);
      await assertNothingInstalled(consumer);
    } else if (expectedVersion) {
      assert.equal(result.code, 0, result.stdout);
      assert.equal(await installedGhAw(), `${expectedVersion}\n`);
      await assertCompleteInstall(consumer, terminalEnv, expectedVersion);
    } else {
      assert.equal(result.code, 0, result.stdout);
      assert.match(result.stdout, manualUpgrade(supportedGhAw));
      assert.equal(await installedGhAw(), `${initialVersion}\n`);
      await assertNothingInstalled(consumer);
    }
  });
}

test("install.sh reruns restore missing policy and launcher mode without replacing consumer policy", async (t) => {
  const { consumer, env, log } = await createConsumer(t, supportedGhAw);
  await runFile(consumer, env);
  assert.equal(await log(), "add\n");
  await assertCompleteInstall(consumer, env, supportedGhAw);

  await rm(path.join(consumer, policyPath));
  await runFile(consumer, env);
  assert.equal(await log(), "add\n");
  await assertCompleteInstall(consumer, env, supportedGhAw);

  const customPolicy = '{"version":1,"gh-aw-version":"v9.9.9","control-plane":{"campaigns":{"custom":{}}}}\n';
  await writeFile(path.join(consumer, policyPath), customPolicy);
  await chmod(path.join(consumer, "cao.sh"), 0o644);
  await streamInstaller(consumer, env);
  assert.equal(await log(), "add\n");
  assert.equal(await readFile(path.join(consumer, policyPath), "utf8"), customPolicy);
  await assertExecutable(path.join(consumer, "cao.sh"));

  await runFile(consumer, env, ["githubnext/gh-aw-cao@v1.2.3"]);
  assert.equal(await log(), "add\nadd-force\n");
  assert.equal(await readFile(path.join(consumer, policyPath), "utf8"), customPolicy);
});

for (const [failure, environment, expectedLog] of [
  ["campaign add fails", { FAKE_ADD_FAILURE: "1" }, "add\n"],
  ["the immutable archive download fails", { FAKE_CAO_ARCHIVE_STATUS: "503" }, "add\n"],
]) {
  test(`install.sh exits nonzero without policy when ${failure}`, async (t) => {
    const { consumer, env, log } = await createConsumer(t, supportedGhAw);
    const result = await runStreamed(consumer, { ...env, ...environment });
    assert.notEqual(result.code, 0);
    assert.equal(await log(), expectedLog);
    await assertNothingInstalled(consumer);
  });
}
