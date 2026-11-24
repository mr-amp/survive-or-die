# Development status

Checkpoint for `work/local-first-windows`. This file records repository evidence; it does not certify a Windows installation or continuous operation.

## Implemented

- Local Ollama mode, local model selection and 16GB/32GB profiles.
- Authenticated loopback dashboard and controls, including local worker stop requests.
- SQLite-backed task, memory, heartbeat and worker facilities from the upstream Automaton architecture.
- Owner approval requests with exact action and parameter hashes, pending-request deduplication, bounded expiry, decision/event history, cancellation, revocation and self-review rejection.
- Protected actions remain denied by the policy engine. The dashboard can record an owner decision, but no approved action executor exists; real financial, paid-cloud, publication and commercial execution therefore remains disabled.
- Self-modification path protections cover the live runtime, policy/approval/dashboard/database/resource files, package manifest, tool manager and safety controls. Direct live self-modification actions are also blocked by the owner-approval policy.
- Solana USDC balance reads use bounded JSON-RPC with address/account validation and timeouts; the large SDK is no longer needed for that one lookup.
- Dependency remediation removed unused `simple-git` and `gray-matter`, removed `@solana/web3.js` after replacing its one runtime use, updated the development test/build toolchain, and added only scoped compatible transitive overrides.
- The security and financial test shortcuts now use Vitest 4's supported `-t` test-name filter; their previous `--grep` option failed at CLI parsing and ran no tests.
- Persistent business opportunity pipeline (schema v13): the agent can save opportunity hypotheses with customer problem, value proposition, evidence/competitor notes, source links, estimated GBP pence, confidence, forecast horizon and risks. The authenticated owner dashboard lists these, advances the review lifecycle, and records owner-reported actual income/expenses separately with idempotency and audit events. No sources are fetched or asserted as verified; no payments, customer contact, publication, account creation or commercial commitments are performed.
- Draft-only self-improvement proposal lifecycle (schema v14): agent proposals store complete candidate file text, bounded source diffs, content hash, rationale, expiry and verification state, and create an exact software-change owner approval request. Protected/security files, traversal paths, symlink escapes, generated/private directories, and size excess are rejected. The authenticated dashboard can approve or reject a review and the approval history is linked. Approval remains review-only: no candidate code is executed, copied to the live tree or activated.
- Persistent task retry backoff (schema v15): retryable task failures now store an ISO next-attempt time, with exponential delay starting at five seconds and capped at 30 minutes. The ready-task query filters work until that time, retry timestamps survive restart, terminal/successful transitions clear the delay, and the dashboard shows scheduled retry time. Health-monitor recovery and dead-worker recovery now use the same bounded retry path instead of immediately reassigning failed work.
- Opportunity validation planning (schema v16): an authenticated owner can convert a shortlisted opportunity into one persistent goal with three dependent research/feasibility tasks in the existing task graph. Creation is idempotent and the link survives restart. Task prompts require lawful public evidence and prohibit customer contact, spending, account creation, publication and commitments. This plans work; it does not verify market evidence or create a business.
- Business experiment and learning records (schema v17): the agent can propose a bounded experiment against a shortlisted opportunity, including a falsifiable hypothesis, method, success criteria and forecast-only cost. Exact repeat proposals are idempotent so retries do not flood the owner queue. The authenticated dashboard lets the owner record a completed outcome and lesson, or reject the proposal. Outcomes are owner-reported, audit logged, immutable after review and separate from actual income/expense entries. Lessons are also saved to semantic memory as low-confidence, owner-reported untrusted data; an agent tool can retrieve them while warning against treating small reports as general market proof. Proposals do not start experiments or authorize spending, contact or publication.
- Opportunity profitability reporting: the dashboard and API show actual income, expenses and net for the owner-entered opportunity ledger, separately from estimated net forecasts for open opportunities. Forecast estimates never enter actual accounting.

## Verified in this checkpoint

- Frozen pnpm dependency installation completed with pnpm 10.28.1 on Node 24.22.3.
- `pnpm run typecheck` passed.
- `pnpm run build` passed.
- Seventeen focused test files passed: 314 tests covering approval storage, denied-tool integration, dashboard, security, financial policy, Solana RPC validation, local worker cancellation, task graph, heartbeat scheduling, low-compute operation and offline integration flows.
- `pnpm audit --audit-level=low` and `pnpm audit --prod --audit-level=low` report no known vulnerabilities for the current lockfile.
- `git diff --check` passed after the final status-file addition.
- Business pipeline implementation: `pnpm run typecheck`, `pnpm run build`, and the focused business-opportunity, dashboard, policy-engine and approval integration tests passed (13 tests in the latest focused run). Persistence, agent tool registration, transition guards, source URL validation, owner-only actual ledger entries, idempotent retry behavior and accurate totals beyond the bounded history view are covered. The dashboard HTTP routes were not exercised end-to-end.
- Combined business-pipeline and self-improvement proposal checks: typecheck and production build passed, the dashboard inline JavaScript passed `node --check`, and five focused business, proposal, dashboard and approval test files passed (17 tests). Proposal tests verify approval binding, persisted drafts, no live-file writes, protected-path rejection, expiry and safe resubmission after expiry.
- Retry backoff integration: typecheck and production build passed, the dashboard inline JavaScript passed `node --check`, and four focused orchestration, health-monitor, proposal and business test files passed (92 tests), including deterministic first/second retry timing and persistence through the ready-task database query.
- SQLite runtime recovery and validation-plan verification: the pinned pnpm 10.28.1 install compiled `better-sqlite3` for Node 24.22.3. Four focused suites covering business opportunities, task graph, dashboard, self-improvement, health monitor and orchestrator passed (116 tests). Typecheck, production build, `git diff --check`, dashboard inline JavaScript `node --check`, and a standalone Python SQLite migration/constraint check passed. One initial new assertion failed because the existing graph correctly marked a dependent task blocked; the assertion was corrected, then all 116 focused tests passed.
- The repaired security shortcut passed 124 tests across 17 files (55 files skipped); the repaired financial shortcut passed 38 tests across 9 files (63 files skipped). `pnpm audit --audit-level=low` reports no known vulnerabilities.
- Business experiment/profitability batch: Node 24.22.3 with repository-pinned pnpm 10.28.1; typecheck and production build passed. Eleven focused business, dashboard HTTP integration, self-improvement, owner-approval and orchestration files passed 140 tests. The repaired security filter passed 124 tests across 17 files (56 files skipped); the financial filter passed 38 tests across 9 files (64 files skipped). The dashboard inline JavaScript passed `node --check`; a built-runtime SQLite migration check confirmed schema v17 and both experiment tables; `git diff --check` passed. Tests cover auth, owner-only outcome entry, duplicate review rejection, persistence after reopening SQLite, semantic-memory learning retrieval, and separation of actual net versus forecast net. A subsequent four-file regression run passed 99 tests after adding semantic-memory persistence. The follow-up duplicate-proposal guard passed TypeScript, production build, dashboard script syntax, and four focused business/dashboard/self-improvement/task-graph files (74 tests).

## Security audit resolution

The starting lockfile reported 46 findings: 5 critical, 18 high, 21 moderate and 2 low. The findings fell into these dependency/exposure groups:

- `simple-git` was a direct production dependency with multiple Git-configuration/option parsing command-execution advisories. Repository source did not import it, so it was removed rather than upgraded across a major version.
- `gray-matter` was a direct production dependency with no source imports; its `js-yaml` 3.x dependency carried CPU denial-of-service advisories. It was removed.
- `@solana/web3.js` was a direct production dependency used only for the Solana USDC balance query. Its Jayson, `rpc-websockets`, `ws`, `uuid` and `stream-json` tree accounted for multiple production findings. The single use is now a bounded JSON-RPC call with a 10-second timeout, 256KB response cap, valid owner/mint checks and integer amount validation; the SDK was removed.
- `yaml` is used by runtime configuration/skill parsing and had a nested-collection stack-overflow advisory. It was updated to 2.9.1.
- `ws` was reachable through production libraries including viem and SIWE/ethers, with memory-exhaustion findings. A scoped compatible 8.x update resolves the affected runtime path.
- Vitest was a direct development dependency with a critical arbitrary-file/code-execution advisory in its UI server plus additional mocker advisories. It was upgraded to 4.1.12 (Node 20+). The test suite uses `vitest run`, not the vulnerable UI server.
- Vite/Rollup/PostCSS/nanoid/source-map findings were in the development toolchain, not the shipped agent runtime. Vite was updated to 6.4.6 and compatible 4.x/8.x/3.x/1.x fixes are constrained by narrow workspace overrides.
- `tsx`/esbuild carried a low-severity Windows development-server file-read advisory; both were updated to patched versions (tsx 4.23.15, esbuild 0.28.2).

The automatic audit fix was not used. It proposed broad overrides including major-version jumps. Instead, unused packages were removed, direct dependencies were upgraded deliberately, and only compatible patch/minor transitive ranges were constrained. Current all-dependency and production audits both report no known advisories at low severity or higher. Compatibility on Node 20 and Windows still needs CI/laptop acceptance.

## Unverified implementations

- Full Vitest suite and end-to-end autonomous runtime behavior.
- GitHub Actions execution, Node 20/22 CI matrix and Windows PowerShell validation.
- Actual Windows setup, startup/recovery, Ollama model loading, Android remote access and backup/restore on the target HP laptop.
- Local inference quality, sustained 16GB/32GB resource use and child-worker recovery after a real process restart.
- Approval execution and pre-execution revalidation. The current design is intentionally audit-only and fails closed.
- Self-improvement workspace isolation, automated verification, rollback and activation. Proposal contents stay in the SQLite proposal record and are review-only; no untrusted code is run.

## Outstanding development

- Obtain an Actions run and fix any verified CI failures; determine or enable repository workflow permissions through GitHub owner settings if required.
- Repeat dependency audits as part of CI and review future transitive changes. The prior lockfile had 46 advisories (5 critical, 18 high, 21 moderate, 2 low); the current lockfile audit returns none at low severity or higher.
- Add an OS-isolated proposal workspace and sandboxed test runner, persist real test results, then implement owner-approved activation/rollback. Current proposals are stored separately in SQLite, but are not copied into a workspace; code has not been tested or activated.
- Continue to attach independently verifiable, dated research evidence to opportunities. Source links are still recorded, not fetched or checked; experiment outcomes remain owner-reported and no real-world experiment runner exists.
- Run the opportunity validation-plan test on a working SQLite-enabled environment; add sourced research collection only through explicitly permitted, documented sources.
- Add full dashboard workflows for persistent goals, resource history and self-improvement proposals.
- Extend persistent worker identities, bounded delegation and parent/child progress/result messaging.
- Verify crash/restart retry behavior on Windows and confirm resource-aware scheduling over a sustained run.
- Do not implement an executor for real financial transactions without a separate security review and owner authorization.

## Known issues and external blockers

- The full Vitest suite was not run. A previous attempt was blocked after the test runner was flagged for a request to `taskmarket.dev`; a repository-wide source search did not identify that hostname in test code. The attempted external test remains unidentified, and no bypass or network-enabled rerun was made. This resumed session ran four reviewed focused suites (116 tests) with the compiled local SQLite addon.
- The available GitHub connector returned no PR-triggered workflow runs for the checked commit and no commit statuses. Its run lookup does not expose push-triggered runs or repository Actions settings, so the cause of the earlier missing CI evidence remains unverified.
- PowerShell (`pwsh`) and a Windows runner are unavailable in this workspace.
- Advisory findings are currently clear, but that is not a guarantee against future vulnerabilities; keep CI audit enabled.
- Target laptop and Android private-network access are not available for acceptance testing in this session.

## Windows acceptance requirements

1. On the HP ProBook, record Windows version, CPU, free disk and installed RAM; run the install instructions from `docs/WINDOWS_LOCAL_INSTALL.md`.
2. Install the supported Node.js LTS and Ollama; pull one profile-compatible local model and verify the local-only first start works with no Conway key.
3. Run typecheck, build, focused tests and the complete test suite locally; validate PowerShell scripts in Windows PowerShell and inspect startup logs.
4. Verify SQLite persistence after stop/restart, interrupted task recovery, retry caps, pause/resume/emergency stop and a failed Ollama connection.
5. Verify dashboard authentication on loopback, then test private Android access only over an authenticated private network such as Tailscale. Confirm it is not publicly reachable.
6. Test the 16GB profile before using parallel workers; after a RAM upgrade, explicitly test the 32GB profile and resource limits.
7. Test backup, restore, crash restart, safe update and uninstall before calling the installation ready.
8. In the authenticated dashboard, submit an opportunity through the agent tool; verify stage changes persist after restart, estimates remain marked unverified, and owner-entered actuals are idempotent and do not trigger payments.
9. Verify self-improvement proposals remain draft-only, approval decisions are linked to exact proposal hashes, and no approval applies code. Workspace isolation, test execution and activation require a later hardened implementation and Windows acceptance review.

## Checkpoint

Latest verified remote development commit: `0766354d7556e37d29e682e7689cc484b24b9337` — `feat: track business experiment outcomes and lessons`. The working tree is clean after synchronization. `main` remains untouched.
