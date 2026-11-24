# Survive or Die Development Instructions

## Project identity

- This repository is the Survive or Die fork of Conway Automaton.
- Preserve the upstream MIT license and copyright notices in all copied or adapted source.
- Keep Survive or Die changes on a development branch. Do not work directly on `main`.
- Never replace the upstream runtime with a superficial rewrite; extend its existing architecture.

## Local-first target

- Target Windows on the HP ProBook 650 G4, assuming 16 GB RAM until the machine is checked.
- Keep the 16 GB profile usable and make a 32 GB profile an upgrade, not a separate architecture.
- Prefer local Ollama inference and persistent local SQLite state.
- Do not add a mandatory paid API, cloud subscription, or cloud provisioning step.
- Do not assume the Windows installation has been tested until it has been run on that machine.

## Financial and cloud safety

- Never trigger a real payment, wallet transaction, paid API call, credit purchase, paid cloud resource, or domain registration automatically.
- Require an explicit owner approval path before any agent initiated financial or paid cloud action is enabled.
- Until that approval path exists, fail closed and deny those actions.
- Do not deploy publicly, expose administrative controls, or publish releases without explicit approval.
- Do not commit secrets, wallet keys, API keys, database files, or personal data.

## Development workflow

1. Verify the exact repository branch and latest commit before editing.
2. Read the complete source files and preserve surrounding code; never edit from partial snapshots.
3. Prefer small, integrated changes that preserve upstream architecture.
4. Add focused tests for behavior changes. Do not describe a test as passed unless it ran.
5. Run `pnpm run typecheck` and relevant Vitest tests when a complete checkout and dependencies are available. Run the full suite before merging.
6. Review the complete diff and check for financial, security, Windows-path, and persistence regressions.
7. Keep unverified changes on the development branch; do not merge them into `main`.
8. Report unavailable tools, checks, and hardware verification plainly.

## Recovery and persistent state

- Keep configuration, SQLite state, and logs in the user's home directory with restrictive permissions where supported.
- Preserve existing state during upgrades. Back up configuration before scripts change it.
- Provide a clear stop, restart, backup, and restore path for any Windows startup integration.
