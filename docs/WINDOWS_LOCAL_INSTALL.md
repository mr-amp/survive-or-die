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
- Stop the agent before copying `state.db`. Keep the backup outside `.automaton`; SQLite can use journal/WAL files while active.
- To remove the project, remove the scheduled task and delete the cloned repository. Agent data is stored separately.
## 6. Private Android dashboard (optional)

The runtime starts an authenticated dashboard on `http://127.0.0.1:41555` by default. It binds only to this computer. On the laptop, copy the owner token from `%USERPROFILE%\.automaton\dashboard-token` using a private method, then install and sign in to Tailscale on both the laptop and Android phone. In a PowerShell window on the laptop, run:

```powershell
tailscale serve 41555
```

Use the HTTPS `*.ts.net` address printed by Tailscale on the phone. Enter the owner token on the dashboard. Keep that PowerShell window open while using the private link; press Ctrl+C to stop the Serve proxy. Keep Tailscale access restricted to your own devices and do not run `tailscale funnel`, which would make a service public. The dashboard itself still requires the owner token. Do not share the token or commit it to Git.

The dashboard shows runtime status, goals/tasks, recent activity, resource usage, memory, child agents, financial records, blocked approval-required actions, the business opportunity pipeline and draft self-improvement proposals. Opportunity forecasts and agent-supplied evidence are explicitly unverified; source links are recorded but not fetched. The owner can advance an opportunity through review stages and enter manually reported GBP actuals; these records do not initiate or prove a transaction. Code proposals remain stored drafts; their approval only records owner review and does not execute tests, apply or activate code. It can pause/resume or stop the local runtime and update the local Ollama model/resource profile; model/profile changes require an agent restart. The dashboard does not execute owner approvals, payments, cloud provisioning, child termination or code changes. If Ollama is unavailable, model selection displays a warning and the agent remains subject to local-mode startup checks.

Retryable task failures are persisted with an increasing retry delay (5 seconds initially, capped at 30 minutes); due tasks remain available after an agent restart. The dashboard shows the saved next retry time. This scheduling behavior still needs acceptance testing on Windows under real crash/restart conditions.

### Dashboard acceptance check

After sign-in, verify the business opportunity pipeline is visible. Once the agent has proposed an opportunity, move it between permitted stages and restart the agent to confirm the stage persists. Add an actual income or expense only when you have an owner-verified amount to record. Confirm the dashboard labels forecasts as unverified and that recording an actual only changes the local ledger; it must not send money or create an external commitment.

Review any self-improvement proposal by checking the exact diff and its hash. Verification must show `not_run` until a future isolated test runner is installed. Recording approval must not change the running application or working tree.
