# Development status

Checkpoint for `work/local-first-windows`. This file records repository evidence; it does not certify a Windows installation or continuous operation.

## Implemented

- Local Ollama mode, local model selection and 16GB/32GB profiles.
- Authenticated loopback dashboard and controls, including local worker stop requests.
- SQLite-backed task, memory, heartbeat and worker facilities from the upstream Automaton architecture.
- Owner approval requests with exact action and parameter hashes, pending-request deduplication, bounded expiry, decision/event history, cancellation, revocation and self-review rejection.
- Protected actions remain denied by the policy engine. The dashboard can record an owner decision, but no approved action executor exists; real financial, paid-cloud, publication and commercial execution therefore remains disabled.
- Self-modification path protections cover the live runtime, policy/approval/dashboard/database/resource files, package manifest, tool manager and safety controls. Direct live self-modification actions are also blocked by the owner-approval policy.

## Verified in this checkpoint

- Frozen pnpm dependency installation completed with pnpm 10.28.1 on Node 24.22.3.
- `pnpm run typecheck` passed.
- `pnpm run build` passed.
- Six focused test files passed: 108 tests covering approval storage, denied-tool integration, dashboard input guards, path protection and tool security.
- `git diff --check` passed after the final status-file addition.

## Unverified implementations

- Full Vitest suite and end-to-end autonomous runtime behavior.
- GitHub Actions execution, Node 20/22 CI matrix and Windows PowerShell validation.
- Actual Windows setup, startup/recovery, Ollama model loading, Android remote access and backup/restore on the target HP laptop.
- Local inference quality, sustained 16GB/32GB resource use and child-worker recovery after a real process restart.
- Approval execution and pre-execution revalidation. The current design is intentionally audit-only and fails closed.

## Outstanding development

- Obtain an Actions run and fix any verified CI failures; determine or enable repository workflow permissions through GitHub owner settings if required.
- Review and remediate the dependency audit findings without forcing unverified major-version overrides. Current audit reported 46 advisories (5 critical, 18 high, 21 moderate, 2 low); the automatic override proposal was discarded because it included major-version changes that were not compatibility-tested.
- Build isolated self-improvement workspaces, diff/test proposal review, approval-gated activation and rollback. Current protections do not constitute that complete proposal lifecycle.
- Add full dashboard workflows for persistent goals, business opportunity review, resource history and self-improvement proposals.
- Extend persistent worker identities, bounded delegation and parent/child progress/result messaging.
- Continue durable task retry/backoff, dependency and resource-aware scheduling verification against the existing task subsystem.
- Do not implement an executor for real financial transactions without a separate security review and owner authorization.

## Known issues and external blockers

- The full test run was not completed: automatic tool review blocked the run after an integration test attempted an outbound request to `taskmarket.dev`. The test was not bypassed or retried through another path.
- GitHub reports no workflow runs and no commit statuses for the development branch. The available GitHub connector did not expose repository Actions settings, so the cause (disabled Actions, permissions, or an untriggered run) remains unverified.
- PowerShell (`pwsh`) and a Windows runner are unavailable in this workspace.
- `pnpm build` emits a warning that `pnpm.onlyBuiltDependencies` in `package.json` is no longer read by pnpm 10; move this configuration to the supported workspace settings in a separately reviewed change.
- Target laptop and Android private-network access are not available for acceptance testing in this session.

## Windows acceptance requirements

1. On the HP ProBook, record Windows version, CPU, free disk and installed RAM; run the install instructions from `docs/WINDOWS_LOCAL_INSTALL.md`.
2. Install the supported Node.js LTS and Ollama; pull one profile-compatible local model and verify the local-only first start works with no Conway key.
3. Run typecheck, build, focused tests and the complete test suite locally; validate PowerShell scripts in Windows PowerShell and inspect startup logs.
4. Verify SQLite persistence after stop/restart, interrupted task recovery, retry caps, pause/resume/emergency stop and a failed Ollama connection.
5. Verify dashboard authentication on loopback, then test private Android access only over an authenticated private network such as Tailscale. Confirm it is not publicly reachable.
6. Test the 16GB profile before using parallel workers; after a RAM upgrade, explicitly test the 32GB profile and resource limits.
7. Test backup, restore, crash restart, safe update and uninstall before calling the installation ready.

## Checkpoint

At the start of this work, the verified remote branch head was `7a569ca60d3138efb795a2f13a57e4371e3cc294`. The approval and hardening batch is committed to `work/local-first-windows` as `c5c008fe1ff51e3b831b58823cbf6e2dd1329ef3`; this status-file correction follows that code commit.
