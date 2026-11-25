# Mission 12 software completion register

Assessment date: 25 November 2026. Mission 12 starts from remote branch commit `4011c59b9276ef0dc2a1ee63ed9d364788822243`. Mission 12 adds local deliverable preparation and owner review; the verified implementation commit is recorded in the final handoff.

This is a scoped readiness register for the stated local-first Automaton recreation, not a claim that every upstream feature or real-world business outcome is complete. Each criterion has equal weight within its metric. `Implemented and verified` = 1, `partial` = 0.5, `missing` or `not verified` = 0. Hardware-only checks are reported separately. Verification means the named code/tests ran in the development environment; it does not imply Windows or laptop acceptance.

## Requirement register

| # | Requirement | State | Evidence / limit |
|---:|---|---|---|
| 1 | Local-only startup without Conway credentials | Implemented and verified | Local-mode policy/configuration and offline tests; no paid fallback. |
| 2 | Ollama selection and 16GB/32GB profiles | Partial (hardware unverified) | Profile/model configuration and resource tests; no actual Ollama model run. |
| 3 | SQLite persistence for goals, tasks, memory and activity | Implemented and verified | Database migrations, persistence and recovery test groups. |
| 4 | Scheduling, dependency handling, retry/backoff and task recovery | Implemented and verified | Orchestration/heartbeat offline groups; process restart still needs laptop acceptance. |
| 5 | Reasoning/tool loop with safe idle and repetitive-loop handling | Implemented and verified with fixtures | Deterministic loop tests; not sustained local-model operation. |
| 6 | Bounded local worker identity, assignment, progress, result and cancellation | Implemented and verified | Worker/orchestration/dashboard tests; live multiworker resource load unverified. |
| 7 | Resource monitoring and low-memory/concurrency safeguards | Partial (hardware unverified) | Code and deterministic tests; CPU, thermal and RAM behavior unmeasured on target. |
| 8 | Private authenticated owner dashboard and pause/resume/stop | Implemented and verified locally | HTTP integration tests, loopback binding and auth; Android/Tailscale device path unverified. |
| 9 | Persistent owner approvals, expiry, exact binding, revocation and audit | Implemented and verified as audit-only | Approval/security tests; no privileged action executor exists. |
| 10 | Persistent business opportunities, experiments, lessons, follow-up tasks and owner-review deliverables | Implemented and verified | Business/dashboard/task/memory tests; validation goals include a feasibility-dependent product-planning task. Deliverables are private, versioned Markdown files linked to their opportunity/task and integrity checked before display. Review permits internal planning only; experiment outcomes remain owner-reported. |
| 11 | Evidence source ledger with provenance fields and unverified status | Implemented and verified | SQLite, tool and dashboard tests; optional retrieval IDs link exact fetched sources but claims remain unverified. |
| 12 | Evidence coverage, missing-topic and submitted contradiction assessment | Implemented and verified | New deterministic assessment and dashboard/API test; classifications are submitter-provided, not independently corroborated. |
| 13 | Safe public-source retrieval and independent source verification | Partial | Owner-opt-in exact-host HTTPS retrieval is implemented with pinned public DNS, manual allowlisted redirects, strict response bounds, persistent rate reservations/provenance, untrusted-content handling and local fixture tests. Retrieved claims remain unverified; external laptop network behavior and factual corroboration are not established. |
| 14 | Estimated forecasts separated from owner-entered actual accounting | Implemented and verified | Business integration tests; records do not prove transactions or revenue. |
| 15 | Self-improvement proposals, diff, isolated candidate/rollback staging and owner review | Implemented and verified as preparation only | Existing proposal/workspace tests; no candidate test command executes. |
| 16 | OS-enforced candidate verification with restricted commands/network/resources | Missing / blocked | No verified isolation runner. Windows Sandbox lacks documented CPU/time quotas; candidate execution stays off. |
| 17 | Approved update activation and automatic rollback | Partial | Baseline rollback copy/manifests and interrupted staging recovery exist; no activation or automatic rollback executor. |
| 18 | Authenticated display of Windows isolation readiness | Partial (PowerShell unverified) | New bounded, authenticated report endpoint and UI; new PS script has not run through a Windows parser here. API forces candidate execution false. |
| 19 | Encrypted backup envelope and tamper rejection | Implemented and verified | AES-256-GCM/PBKDF2 unit tests in offline suite; Windows packaging/restore still unverified. |
| 20 | Windows prerequisite, install, startup/retry, recovery and uninstall scripts | Partial (Windows unverified) | Source and CI parser workflow exist; neither target laptop nor Windows runner results observed. |
| 21 | Remote dashboard access instructions over a private authenticated path | Partial (device unverified) | Tailscale Serve guidance and loopback-auth dashboard; no device acceptance. |
| 22 | GitHub Actions workflow for Node checks and Windows PowerShell parsing | Partial (workflow execution unverified) | `.github/workflows/ci.yml` has push/PR/manual triggers and a Windows parser job; no run result confirmed for this release commit. |
| 23 | HP ProBook installation, sustained operation and thermal acceptance | Requires physical hardware | No laptop or actual Windows/Ollama measurements were available. |
| 24 | Reliable autonomous revenue generation | Not established | No income is claimed or fabricated; commercial feasibility and demand require independent real-world validation. |

## Evidence-backed measures

### Overall software implementation: **73.9% (17/23 weighted points)**

This is the equal-weighted implementation maturity of software rows 1–22 and 24: 13 implemented, 8 partial, and 2 missing/not established (OS-isolated candidate execution and reliable revenue generation). Hardware acceptance row 23 is reported separately and is not scored as code completeness. Formula: `(13 + 8×0.5) / 23`. This broad roll-up intentionally includes research and commercial outcome limits, so it is not a test pass rate.

### Original Automaton capability coverage: **68.2% (7.5/11 weighted points)**

Equal-weighted capabilities: reasoning/tool loop, persistent goals/tasks, heartbeat/recovery, memory, local inference configuration, bounded local worker delegation, survival/economic accounting, business research/planning, self-improvement, agent replication, and autonomous income generation. Five are implemented and verified in deterministic/local tests, five are partial (including limits on local replication, live inference, independent research, and safe self-update), and one—reliable income generation—is not established. Formula: `(5 + 5×0.5) / 11`. This measures capability coverage, not the project's fidelity to every upstream implementation detail.

### Integrated workflow completion: **75% (4.5/6 weighted points)**

Six end-to-end paths are scored: objective→plan→execute→memory; evidence→assessment→business plan; local worker assignment→result/dashboard/cancel; owner approval audit path; proposal→isolated verification→review→activation; and Windows install→restart→backup/restore. Three paths are complete for their explicitly restricted behavior (business research→persistent validation tasks→assessment, worker lifecycle, and audit-only approvals); three remain partial because sustained local inference, isolated candidate execution/update activation, or Windows execution is absent/unverified. Formula: `(3 + 3×0.5) / 6`. This corrects the previous arithmetic inconsistency: the prior text stated 2 complete and 4 partial but its displayed 3.5/6 total did not match those classifications.

### Remote engineering verification: **91.7% (11/12 checks)**

The 12 check groups are frozen installation, TypeScript, production build, bounded offline suite, focused Mission 11 regression, security filter, financial filter, full dependency audit, production dependency audit, backup crypto tests, remote source-integrity verification, and Windows PowerShell parsing/Actions execution. Eleven groups completed successfully. The security and financial shortcuts run under the offline network guard and pass 124 and 38 tests. An earlier default-config security-filter invocation timed out in the inbox-injection loop test; the guarded invocation and full offline suite both pass that case. Windows PowerShell and Actions execution did not run. Formula: `11/12 = 91.7%`. This measure excludes real laptop acceptance.

### Windows installation software readiness: **70% (7/10 weighted points)**

Ten equal-weight items: prerequisites/install, local model profiles, local-only startup, persistent data/logs, automatic startup/restart, encrypted backup/restore, diagnostics, authenticated private dashboard, isolation readiness detection, and uninstall/recovery. Four are implemented in software (local-only startup, persistent data/logs, model/profile configuration, diagnostics); six are partial pending Windows execution or security acceptance (installer, startup, backup/recovery, private remote access, isolation detection, uninstall/recovery). Formula: `(4 + 6×0.5) / 10 = 70%`. Physical acceptance remains separate.

These measures have different denominators and must not be added together. The current project is a pre-release development checkpoint, not an installation-ready production release. Remaining remote software gates include OS-enforced candidate verification and update activation; physical Windows and actual model acceptance remain mandatory afterward.

### Mission 12 scoring update

The equal-weighted measures remain **73.9% overall software implementation**, **68.2% original Automaton capability coverage**, **75% integrated workflow completion**, **91.7% remote engineering verification**, and **70% Windows software preparation**. Mission 12's deliverable capability strengthens requirement 10, which was already counted as implemented and verified under the existing broad criterion; no previously partial register row is promoted solely because a new sub-capability was added. The scoring denominator and weights are unchanged. Independent factual corroboration, OS-isolated candidate execution, Windows execution, device acceptance and real-world revenue remain incomplete or unverified.

## Mission 11 implementation and verification

- Added `retrieve_public_research`, disabled by default and configured only by the authenticated loopback dashboard with exact hostname allowlists. Requests are HTTPS GET only, send no cookies/credentials, pin DNS results after rejecting non-public addresses, revalidate every redirect, reject secret query parameters/unsupported encodings/content types, cap redirects, bytes, excerpts and total time, abort the underlying HTTPS request at the absolute deadline, and reserve per-host rate quota atomically in SQLite.
- Successful retrievals persist requested/final URLs, HTTP status, timestamp, content type, page title, bounded extracted text, SHA-256 and requester. Fetched text is treated as untrusted and passed through existing external-tool sanitization. The system records retrieval provenance only; it does not establish source reliability or factual truth.
- Evidence can link to a successful retrieval only when the final URL and opportunity match; dashboard evidence remains marked unverified and shows retrieval timestamp/ID. Business-validation tasks now use this capability only with owner opt-in and allowlisting.
- Agent proposals automatically create a persistent three-task validation goal when fewer than three business research goals are active. Creation is idempotent; unsupported or external actions remain prohibited. At the cap, no new goal or tasks are created.
- Deterministic tests use injected DNS and HTTP fixtures; no public network request was made in this environment.
- Offline verification: all 13 bounded groups passed across 75 test files, totaling 1,696 tests. Focused research/business/dashboard regression: 20 passed. Security filter: 124 passed; financial filter: 38 passed. Both filtered commands now use the offline network guard; a prior unguarded invocation timed out in the inbox-injection loop test, while the guarded test and full offline suite pass. Frozen offline pnpm install, TypeScript, production build, full and production dependency audits passed; both audits found no known vulnerabilities. Windows PowerShell, live remote retrieval and Android device access were not tested.

## Mission 12 — local deliverables and business workflow integration

- Added schema v25 for private business deliverable records, version metadata and append-only preparation/review events. Supported outputs are business plans, market reports, product and prototype specifications, website drafts, and experiment specifications.
- Added `prepare_business_deliverable`. Content is capped at 64 KiB and saved as a generated, versioned Markdown path under `.automaton/business-deliverables`; arbitrary file paths are not accepted. SQLite ties the record to its originating opportunity and optional task from that opportunity's validation goal. Repeat content returns the existing version; changed content appends a version, resets it to pending owner review, and records its SHA-256 and size.
- The authenticated dashboard lists version history, verifies the current file's path, type, size and SHA-256 before returning its body, and lets the owner approve for internal planning, request changes or archive. A review is audit state only and grants no execution, publication, financial or commercial authority. Review replay is rejected.
- New validation goals have four persistent stages: customer/problem research, competitor comparison, dependent feasibility, then dependent product planning. The last task asks the agent to prepare a linked review-only artifact and explicitly labels unknowns, assumptions, and restrictions. It remains within the existing three-active-goal limit and scheduler.
- Mission 12 verification: the complete offline groups passed 13/13 across 76 files and 1,700 tests with no failures/timeouts. After a final no-overwrite atomic file-install refinement, focused business/deliverable/dashboard tests passed (16), and TypeScript plus production build passed on Node 24.22.3 with pinned pnpm 10.28.1. Coverage includes task linkage, repeat/version behavior, content tamper rejection, dashboard authentication and owner review. No dependency files changed, so the dependency audit was not rerun. PowerShell, Windows, live Ollama, external retrieval and Android/Tailscale device behavior remain unverified in this batch.
