# Windows local installation

These steps target Windows 10 or later and Node.js 20+. The original agent is intended for an HP ProBook 650 G4, but that laptop and its available GPU/RAM have not been tested here. Use the 16GB profile until the machine is confirmed upgraded.

## 1. Install prerequisites

1. Install Node.js 20 or newer from [nodejs.org](https://nodejs.org/).
2. Install Ollama from [ollama.com/download/windows](https://ollama.com/download/windows), then start Ollama from the Windows Start menu.
3. Open PowerShell in the repository folder. Run `corepack enable`; if Windows requests elevation, reopen PowerShell as administrator for that command only.
4. Confirm `node --version`, `pnpm --version`, and `ollama --version` work.

## 2. Install the model and application

From the repository root, run:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\windows\install.ps1 -Profile 16gb
```

The script installs locked dependencies, builds the app, downloads `llama3.1:8b` if it is missing, and opens first-run setup. Keep **local-only** selected. It uses Ollama at `http://localhost:11434` and does not provision a Conway API key or install Conway payment skills.

The model download needs several gigabytes of free disk space and may take time. Ollama speed depends on the laptop CPU/GPU; this setup has not been benchmarked on the target laptop.

## 3. Start and stop

Start manually with `scripts\windows\run-agent.ps1`. Stop with **Ctrl+C**. The SQLite database, wallet, configuration, memory, and logs stay under `%USERPROFILE%\.automaton`. Back up this directory before reinstalling Windows or moving the agent.

If startup reports Ollama is unavailable, open Ollama and check `ollama list`. If the configured model is missing, run `ollama pull llama3.1:8b`. In local-only mode the runtime refuses to start without the local server and selected model; it does not fall back to Conway or paid inference.

## 4. Automatic startup and crash recovery

After a successful manual start, stop the agent with Ctrl+C. Run `scripts\windows\install-startup.ps1` to register a per-user Task Scheduler task. It starts at sign-in and retries a failed process up to five times at one-minute intervals. It does not run before you sign in.

Remove the task with `scripts\windows\uninstall.ps1`. Uninstall keeps your data by default. To delete the wallet, configuration, SQLite database, memory, and logs too, run `uninstall.ps1 -DeleteData` and review the confirmation.

## 5. Upgrade from 16GB to 32GB

After the RAM upgrade is installed and Windows reports approximately 32GB, rerun:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\windows\install.ps1 -Profile 32gb -Model llama3.1:8b
```

The 32GB profile allows two local child workers and raises configured context/output limits. Both profiles keep one Ollama model loaded at a time. The script sets Ollama user-level parallel request settings; restart Ollama once after installation so it reads them. Back up `%USERPROFILE%\.automaton\automaton.json` before changing `localProfile`, `maxTokensPerTurn`, or `inferenceModel`.

## Recovery and removal

- Inspect `%USERPROFILE%\.automaton\logs\agent.log`, confirm Ollama is running, then check `ollama list`.
- Create and verify an encrypted database/configuration archive with the Windows helper below. The helper prompts for a passphrase; store it separately because it is never saved and cannot be recovered. The SQLite online backup API allows a consistent snapshot while the agent runs. Wallet files and the dashboard token are intentionally not included.
- To remove the project, remove the scheduled task and delete the cloned repository. Agent data is stored separately.

### Windows data backup and restore

From the repository folder in PowerShell, run:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\windows\backup-restore.ps1 -Action backup
powershell -ExecutionPolicy Bypass -File .\scripts\windows\backup-restore.ps1 -Action verify -BackupPath "$env:USERPROFILE\SurviveOrDieBackups\survive-or-die-YYYYMMDD-HHmmss.sodbackup"
```

Backups contain `state.db`, `automaton.json`, SHA-256 checksums and a SQLite integrity check inside an AES-256-GCM authenticated encrypted envelope. Use a passphrase of at least 12 characters and keep it separately; a lost passphrase means the backup cannot be restored. Restore requires the agent to be stopped; it authenticates and verifies the archive before extraction, only replaces the currently configured database path, keeps pre-restore database/configuration copies and journals replacement so a later invocation can recover an interrupted restore. Existing legacy plaintext ZIPs can still be verified, but restore requires typing `RESTORE-UNENCRYPTED` after the warning:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\windows\backup-restore.ps1 -Action restore -BackupPath "C:\Users\YOURNAME\SurviveOrDieBackups\your-backup.sodbackup"
```

The encryption helper is part of the project build; run `pnpm build` after installing dependencies. The Windows PowerShell parser CI job includes this script, but neither the script nor database recovery has been run on the target laptop yet. Test with a disposable profile before relying on it for recovery.
## 6. Private Android dashboard (optional)

The runtime starts an authenticated dashboard on `http://127.0.0.1:41555` by default. It binds only to this computer. On the laptop, copy the owner token from `%USERPROFILE%\.automaton\dashboard-token` using a private method, then install and sign in to Tailscale on both the laptop and Android phone. In a PowerShell window on the laptop, run:

```powershell
tailscale serve 41555
```

Use the HTTPS `*.ts.net` address printed by Tailscale on the phone. Enter the owner token on the dashboard. Keep that PowerShell window open while using the private link; press Ctrl+C to stop the Serve proxy. Keep Tailscale access restricted to your own devices and do not run `tailscale funnel`, which would make a service public. The dashboard itself still requires the owner token. Do not share the token or commit it to Git.

The dashboard shows runtime status, goals/tasks, recent activity, resource usage, memory, child agents, financial records, blocked approval-required actions, the business opportunity and experiment pipeline, product deliverables, and draft self-improvement proposals. Local worker assignments and the last 12 persisted worker reports are visible, including result, cancellation and restart-interruption state; progress is stage-level and not a live percentage. Opportunity forecasts and agent-supplied evidence are explicitly unverified; source links are recorded but not fetched unless the owner enables the opt-in feature described below. The owner can advance an opportunity through review stages and enter manually reported GBP actuals; these records do not initiate or prove a transaction. Actual income, expenses and net are displayed separately from forecast net. Agent-proposed opportunities can create a bounded persistent goal with research, competitor comparison, feasibility, dependent product planning and dependent experiment design; active business research goals are capped at three. Task prompts prohibit customer contact, spending, account creation, publication and commitments. Generated deliverables are stored as versioned Markdown under `.automaton/business-deliverables`, with database metadata, SHA-256 integrity checks and links to the originating opportunity and task. The authenticated dashboard displays a draft only after checking its saved size and digest. Owner approval means internal planning review only; it does not authorize execution, publication or spending. An experiment proposal records a hypothesis, method, success criteria and forecast cost; the agent does not start it. The owner may record an outcome and lesson from work actually performed or reject the proposal. Completed lessons are retained in low-confidence semantic memory as untrusted owner reports and atomically create one linked, bounded follow-up planning task; it cannot start another experiment or make external commitments. This reporting does not authorize spending and does not establish demand or profitability. The authenticated owner can inspect the proposed source diff, prepare a candidate and its baseline rollback copy under `.automaton/self-mod/workspaces`, outside the live checkout. Verification remains `not_run`; no candidate code is executed or activated. The dashboard can pause/resume or stop the local runtime and update the local Ollama model/resource profile; model/profile changes require an agent restart. It does not execute owner approvals, payments, cloud provisioning, child termination or code changes. If Ollama is unavailable, model selection displays a warning and the agent remains subject to local-mode startup checks.

### Public research retrieval (owner opt-in)

Public retrieval is disabled by default. When local-only mode is active, the authenticated dashboard can enable it for an exact list of public hostnames. The agent makes read-only HTTPS GET requests only, with DNS pinning and rejection of private/reserved network targets, allowlist checks on every redirect, strict byte/time/rate limits, and no credentials or cookies. Page text is reduced to a bounded excerpt and labeled untrusted; suspected injection is passed through the existing content-injection filter. Retrieval records include the URL, timestamp and content hash. If the agent records a claim, the claim may link to that retrieval only when the source URL and opportunity match. A successful fetch proves only that a public response was received; it does not verify the claims, demand, or source reliability. Confirm that each source is lawfully accessible and permitted before allowlisting its hostname. External network retrieval has not been tested on the target laptop.

### Self-improvement isolation readiness (detection only)

Do not run candidate code on the host. Windows Sandbox is a possible disposable environment for a later owner-controlled verification process, but the project does not launch it, map a candidate into it, run commands inside it, or activate its output. Before considering any isolated verification, inspect host prerequisites with an elevated PowerShell window from the repository root:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\windows\inspect-self-mod-isolation.ps1
```

The read-only check writes `%USERPROFILE%\.automaton\logs\self-mod-isolation-readiness.json`; the authenticated dashboard can display that owner-side report. It never enables an optional feature or executes candidate files. Windows Sandbox requires a supported Windows edition (Pro, Enterprise, Education and specified variants; Home is unsupported), hardware virtualization enabled in firmware, and sufficient CPU/RAM/disk. Microsoft lists 4 GB RAM and two CPU cores as minimums, with 8 GB and four cores recommended. Its `.wsb` configuration can disable networking and use read-only folder mappings, but those settings still need an owner to inspect and validate. The documented configuration does not provide a CPU quota or enforce an execution timeout. Therefore this project keeps candidate verification and activation disabled even when the readiness report says prerequisites appear available. Candidate workspaces and security controls remain outside the candidate's writable files. Physical review and a separately designed, tested isolation boundary are still required.

Retryable task failures are persisted with an increasing retry delay (5 seconds initially, capped at 30 minutes); due tasks remain available after an agent restart. The dashboard shows the saved next retry time. This scheduling behavior still needs acceptance testing on Windows under real crash/restart conditions.

### Dashboard acceptance check

Before Windows acceptance, run `pnpm run test:offline` for the local suite. It denies non-loopback global `fetch` and runs one Vitest worker; it is not a substitute for reviewing direct network clients or hardware tests. Registry loop detection uses a deterministic fixture in that suite.

After sign-in, verify the business opportunity pipeline is visible. Once the agent has proposed an opportunity, move it between permitted stages and restart the agent to confirm the stage persists. When a research task submits evidence, inspect its title, date, claim, source and limitations; confirm it remains marked unverified until a person checks it independently. Add an actual income or expense only when you have an owner-verified amount to record. Confirm the dashboard labels forecasts as unverified and that recording an actual only changes the local ledger; it must not send money or create an external commitment.

Confirm that experiment proposals do not start automatically. Record an outcome only for an experiment that was actually performed, include an uncertainty-aware lesson, and verify the proposal becomes read-only after review. The experiment outcome must not create ledger entries; enter actual income or costs separately and verify actual net and estimated forecast net remain distinct.

For a generated product or market deliverable, verify its opportunity and validation-task links, version count and SHA-256 in the authenticated dashboard. View the content and confirm it is served only after integrity validation. Approve it for internal planning or request changes; confirm the decision is audited and does not execute code, publish content, contact anyone, spend money or create a commercial commitment.

For a self-improvement proposal, prepare the candidate workspace and verify its candidate and rollback manifests match the dashboard hashes. Confirm files are outside the live checkout and the current source tree remains unchanged. Verification must show `not_run`: there is no OS-isolated test runner. Approval records review only and must not execute or activate the proposal.
