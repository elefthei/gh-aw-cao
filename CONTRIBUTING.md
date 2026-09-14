# Contributing to Central Agentic Ops

Thank you for your interest in contributing to Central Agentic Ops! We welcome
contributions from the community and are excited to work with you.

**IMPORTANT: This project uses agentic development by a core team, primarily
using Copilot coding agent or local coding agents.**

**Traditional pull requests are not enabled for non-core team members.** If you
are not part of the core team, please do not create a pull request directly.
Instead, create a detailed agentic plan in an issue, discuss it with the team,
and a core team member will create and implement the pull request using agents.

This document describes the contribution process for non-core team members.

## How development works

Central Agentic Ops is developed by a core team using agentic development. This
means:

- **Core team members use agents to create and manage pull requests**, through
  Copilot coding agent or local coding agents.
- **Continuous integration provides automated quality assurance** for every
  pull request.
- **Community members contribute through agentic plans** that the core team can
  execute.
- **Traditional pull requests from non-core members are not enabled.**

### Why this approach?

Central Agentic Ops practices the development model it supports: agents help
build and operate agentic workflows. This approach provides:

- **Consistency:** Changes go through the same automated quality gates.
- **Dogfooding:** We use agentic development to build agentic operations.
- **Established practices:** Agents follow the repository's documented patterns
  and safety boundaries.
- **Actionable plans:** Contributors think through implementation and validation
  before work begins.

## Quick start for community contributors

**If you are not part of the core team, do not create a pull request directly.**
Instead, craft a detailed agentic plan in an issue so a core team member can
implement it using agents.

### Step 1: Analyze with an agent

Before filing a contribution request, use an agent to:

- Scan the relevant source code and identify root causes for bugs.
- Analyze execution patterns and trace the issue.
- Research related issues and existing implementation patterns.
- Propose specific changes, including code examples when useful.
- Create a complete plan for implementation and validation.

Remove credentials, private repository data, and other sensitive information
from prompts, plans, examples, and logs.

### Step 2: Open an issue with your agentic plan

Search existing issues first, then open an issue that:

- Describes what you want to contribute.
- Includes the agent's analysis and findings for bugs.
- Explains the use case and expected behavior.
- Provides a complete, step-by-step implementation plan.
- Identifies the relevant files, tests, and documentation.
- Includes specific implementation details and examples.
- Uses the appropriate issue labels when available.

## Core team implementation reference

Core team members implementing an accepted plan should use Node.js 24 and npm,
then install dependencies and the pinned `gh-aw` compiler:

```bash
npm ci
npm run install:gh-aw
```

Keep changes focused and include tests for new behavior. Edit agentic workflow
sources in `.github/workflows/*.md`; do not edit generated
`.github/workflows/*.lock.yml` files directly. Preserve the control-plane safety
boundary: workers operate on one dispatched repository, and rollout policy
remains in `.github/workflows/cao.json`.

See [AGENTS.md](AGENTS.md) for architecture, repository conventions, and focused
test commands. Run the complete repository validation before submitting a pull
request:

```bash
npm run check
```

Workflow source changes must pass `npm run compile`. Run
`npm run compile:locks` only when generated lock files should be updated.

By participating in this project, you agree to follow our
[Code of Conduct](CODE_OF_CONDUCT.md).
