# Contributing to Central Agentic Ops

Thank you for your interest in contributing. Central Agentic Ops is a research
prototype, and its features and interfaces may change as the project evolves.

## Getting started

1. Fork and clone the repository.
2. Install Node.js 24 and npm.
3. Install dependencies and the pinned `gh-aw` compiler:

   ```bash
   npm ci
   npm run install:gh-aw
   ```

4. Create a branch for your change.

## Making changes

- Keep changes focused and include tests for new behavior.
- Update documentation when behavior or public interfaces change.
- Edit agentic workflow sources in `.github/workflows/*.md`. Do not edit
  generated `.github/workflows/*.lock.yml` files directly.
- Preserve the control-plane safety boundary: workers operate on one dispatched
  repository, and rollout policy remains in `.github/workflows/cao.json`.

See [AGENTS.md](AGENTS.md) for architecture, repository conventions, and the
test commands associated with each part of the project.

## Testing

Run the complete repository validation before submitting a pull request:

```bash
npm run check
```

For a focused change, run the narrow checks described in
[AGENTS.md](AGENTS.md), followed by the complete validation when practical.
Workflow source changes must pass `npm run compile`; run
`npm run compile:locks` only when the generated lock files should be updated.

## Issues and pull requests

- Search existing issues before opening a bug report or feature request.
- Include reproduction steps, expected behavior, and relevant logs in bug
  reports. Remove credentials and other sensitive information from logs.
- Describe what a pull request changes, why it is needed, and how it was tested.
- Link related issues and address review feedback before merge.

By participating in this project, you agree to follow our
[Code of Conduct](CODE_OF_CONDUCT.md).
