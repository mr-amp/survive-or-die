/**
 * Automaton SQLite Schema
 *
 * All tables for the automaton's persistent state.
 * The database IS the automaton's memory.
 */

export const SCHEMA_VERSION = 25;

export const CREATE_TABLES = `
  -- Schema version tracking
  CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Core identity key-value store
  CREATE TABLE IF NOT EXISTS identity (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- Agent reasoning turns (the thinking/action log)
  -- Application-level validation: state must be a valid AgentState ('setup','waking','running','sleeping','low_compute','critical','dead')
  CREATE TABLE IF NOT EXISTS turns (
    id TEXT PRIMARY KEY,
    timestamp TEXT NOT NULL,
    state TEXT NOT NULL,
    input TEXT,
    input_source TEXT,
    thinking TEXT NOT NULL,
    tool_calls TEXT NOT NULL DEFAULT '[]',
    token_usage TEXT NOT NULL DEFAULT '{}',
    cost_cents INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Tool call results (denormalized for fast lookup)
  CREATE TABLE IF NOT EXISTS tool_calls (
    id TEXT PRIMARY KEY,
    turn_id TEXT NOT NULL REFERENCES turns(id),
    name TEXT NOT NULL,
    arguments TEXT NOT NULL DEFAULT '{}',
    result TEXT NOT NULL DEFAULT '',
    duration_ms INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Heartbeat configuration entries
  -- Application-level validation: enabled must be 0 or 1 (boolean integer)
  CREATE TABLE IF NOT EXISTS heartbeat_entries (
    name TEXT PRIMARY KEY,
    schedule TEXT NOT NULL,
    task TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    last_run TEXT,
    next_run TEXT,
    params TEXT DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Financial transaction log
  -- Application-level validation: type must be one of 'transfer_out','transfer_in','credit_purchase','topup','x402_payment','inference'
  CREATE TABLE IF NOT EXISTS transactions (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    amount_cents INTEGER,
    balance_after_cents INTEGER,
    description TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Installed tools and MCP servers
  CREATE TABLE IF NOT EXISTS installed_tools (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    config TEXT DEFAULT '{}',
    installed_at TEXT NOT NULL DEFAULT (datetime('now')),
    enabled INTEGER NOT NULL DEFAULT 1
  );

  -- Self-modification audit log (append-only)
  CREATE TABLE IF NOT EXISTS modifications (
    id TEXT PRIMARY KEY,
    timestamp TEXT NOT NULL,
    type TEXT NOT NULL,
    description TEXT NOT NULL,
    file_path TEXT,
    diff TEXT,
    reversible INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- General key-value store for arbitrary state
  CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Installed skills
  CREATE TABLE IF NOT EXISTS skills (
    name TEXT PRIMARY KEY,
    description TEXT NOT NULL DEFAULT '',
    auto_activate INTEGER NOT NULL DEFAULT 1,
    requires TEXT DEFAULT '{}',
    instructions TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'builtin',
    path TEXT NOT NULL DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 1,
    installed_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Spawned child automatons
  -- Application-level validation: status must be one of 'spawning','running','sleeping','dead','unknown'
  CREATE TABLE IF NOT EXISTS children (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    address TEXT NOT NULL,
    sandbox_id TEXT NOT NULL,
    genesis_prompt TEXT NOT NULL,
    creator_message TEXT,
    funded_amount_cents INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'spawning',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_checked TEXT
  );

  -- ERC-8004 registration state
  CREATE TABLE IF NOT EXISTS registry (
    agent_id TEXT PRIMARY KEY,
    agent_uri TEXT NOT NULL,
    chain TEXT NOT NULL DEFAULT 'eip155:8453',
    contract_address TEXT NOT NULL,
    tx_hash TEXT NOT NULL,
    registered_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Reputation feedback received and given
  -- Application-level validation: score must be 1-5
  CREATE TABLE IF NOT EXISTS reputation (
    id TEXT PRIMARY KEY,
    from_agent TEXT NOT NULL,
    to_agent TEXT NOT NULL,
    score INTEGER NOT NULL,
    comment TEXT NOT NULL DEFAULT '',
    tx_hash TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Indices for common queries
  CREATE INDEX IF NOT EXISTS idx_turns_timestamp ON turns(timestamp);
  CREATE INDEX IF NOT EXISTS idx_turns_state ON turns(state);
  CREATE INDEX IF NOT EXISTS idx_tool_calls_turn ON tool_calls(turn_id);
  CREATE INDEX IF NOT EXISTS idx_transactions_type ON transactions(type);
  CREATE INDEX IF NOT EXISTS idx_modifications_type ON modifications(type);
  CREATE INDEX IF NOT EXISTS idx_skills_enabled ON skills(enabled);
  CREATE INDEX IF NOT EXISTS idx_children_status ON children(status);
  CREATE INDEX IF NOT EXISTS idx_reputation_to ON reputation(to_agent);

  -- Inbox messages table
  CREATE TABLE IF NOT EXISTS inbox_messages (
    id TEXT PRIMARY KEY,
    from_address TEXT NOT NULL,
    content TEXT NOT NULL,
    received_at TEXT NOT NULL DEFAULT (datetime('now')),
    processed_at TEXT,
    reply_to TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_inbox_unprocessed
    ON inbox_messages(received_at) WHERE processed_at IS NULL;
`;

export const MIGRATION_V3 = `
  CREATE TABLE IF NOT EXISTS inbox_messages (
    id TEXT PRIMARY KEY,
    from_address TEXT NOT NULL,
    content TEXT NOT NULL,
    received_at TEXT NOT NULL DEFAULT (datetime('now')),
    processed_at TEXT,
    reply_to TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_inbox_unprocessed
    ON inbox_messages(received_at) WHERE processed_at IS NULL;
`;

export const MIGRATION_V4 = `
  -- Policy decisions table
  CREATE TABLE IF NOT EXISTS policy_decisions (
    id TEXT PRIMARY KEY,
    turn_id TEXT,
    tool_name TEXT NOT NULL,
    tool_args_hash TEXT NOT NULL,
    risk_level TEXT NOT NULL CHECK(risk_level IN ('safe','caution','dangerous','forbidden')),
    decision TEXT NOT NULL CHECK(decision IN ('allow','deny','quarantine')),
    rules_evaluated TEXT NOT NULL DEFAULT '[]',
    rules_triggered TEXT NOT NULL DEFAULT '[]',
    reason TEXT NOT NULL DEFAULT '',
    latency_ms INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_policy_decisions_turn ON policy_decisions(turn_id);
  CREATE INDEX IF NOT EXISTS idx_policy_decisions_tool ON policy_decisions(tool_name);
  CREATE INDEX IF NOT EXISTS idx_policy_decisions_decision ON policy_decisions(decision);

  -- Spend tracking table
  CREATE TABLE IF NOT EXISTS spend_tracking (
    id TEXT PRIMARY KEY,
    tool_name TEXT NOT NULL,
    amount_cents INTEGER NOT NULL,
    recipient TEXT,
    domain TEXT,
    category TEXT NOT NULL CHECK(category IN ('transfer','x402','inference','other')),
    window_hour TEXT NOT NULL,
    window_day TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_spend_hour ON spend_tracking(category, window_hour);
  CREATE INDEX IF NOT EXISTS idx_spend_day ON spend_tracking(category, window_day);

  -- Heartbeat schedule (Phase 1.1)
  CREATE TABLE IF NOT EXISTS heartbeat_schedule (
    task_name TEXT PRIMARY KEY,
    cron_expression TEXT NOT NULL,
    interval_ms INTEGER,
    enabled INTEGER NOT NULL DEFAULT 1,
    priority INTEGER NOT NULL DEFAULT 0,
    timeout_ms INTEGER NOT NULL DEFAULT 30000,
    max_retries INTEGER NOT NULL DEFAULT 1,
    tier_minimum TEXT NOT NULL DEFAULT 'dead'
      CHECK(tier_minimum IN ('dead','critical','low_compute','normal','high')),
    last_run_at TEXT,
    next_run_at TEXT,
    last_result TEXT CHECK(last_result IN ('success','failure','timeout','skipped') OR last_result IS NULL),
    last_error TEXT,
    run_count INTEGER NOT NULL DEFAULT 0,
    fail_count INTEGER NOT NULL DEFAULT 0,
    lease_owner TEXT,
    lease_expires_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Heartbeat history (Phase 1.1)
  CREATE TABLE IF NOT EXISTS heartbeat_history (
    id TEXT PRIMARY KEY,
    task_name TEXT NOT NULL REFERENCES heartbeat_schedule(task_name),
    started_at TEXT NOT NULL,
    completed_at TEXT,
    result TEXT NOT NULL CHECK(result IN ('success','failure','timeout','skipped')),
    duration_ms INTEGER,
    error TEXT,
    idempotency_key TEXT UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_hb_history_task ON heartbeat_history(task_name, started_at);

  -- Wake events (Phase 1.1)
  CREATE TABLE IF NOT EXISTS wake_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    reason TEXT NOT NULL,
    payload TEXT DEFAULT '{}',
    consumed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_wake_unconsumed ON wake_events(created_at) WHERE consumed_at IS NULL;

  -- Heartbeat dedup (Phase 1.1)
  CREATE TABLE IF NOT EXISTS heartbeat_dedup (
    dedup_key TEXT PRIMARY KEY,
    task_name TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_dedup_expires ON heartbeat_dedup(expires_at);

  -- Data migration: heartbeat_entries -> heartbeat_schedule
  INSERT OR IGNORE INTO heartbeat_schedule (task_name, cron_expression, enabled, last_run_at, next_run_at)
  SELECT name, schedule, enabled, last_run, next_run FROM heartbeat_entries;
`;

// Inbox modifications for V4 (ALTER TABLE must be run separately from CREATE TABLE)
export const MIGRATION_V4_ALTER = `
  ALTER TABLE inbox_messages ADD COLUMN to_address TEXT;
`;

export const MIGRATION_V4_ALTER2 = `
  ALTER TABLE inbox_messages ADD COLUMN raw_content TEXT;
`;

// Inbox state machine columns (Phase 1.2)
// Note: SQLite ALTER TABLE ADD COLUMN cannot include CHECK constraints,
// so status validation is enforced at the application level.
export const MIGRATION_V4_ALTER_INBOX_STATUS = `
  ALTER TABLE inbox_messages ADD COLUMN status TEXT DEFAULT 'received';
`;

export const MIGRATION_V4_ALTER_INBOX_RETRY = `
  ALTER TABLE inbox_messages ADD COLUMN retry_count INTEGER DEFAULT 0;
`;

export const MIGRATION_V4_ALTER_INBOX_MAX_RETRIES = `
  ALTER TABLE inbox_messages ADD COLUMN max_retries INTEGER DEFAULT 3;
`;

export const MIGRATION_V2 = `
  CREATE TABLE IF NOT EXISTS skills (
    name TEXT PRIMARY KEY,
    description TEXT NOT NULL DEFAULT '',
    auto_activate INTEGER NOT NULL DEFAULT 1,
    requires TEXT DEFAULT '{}',
    instructions TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'builtin',
    path TEXT NOT NULL DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 1,
    installed_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS children (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    address TEXT NOT NULL,
    sandbox_id TEXT NOT NULL,
    genesis_prompt TEXT NOT NULL,
    creator_message TEXT,
    funded_amount_cents INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'spawning',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_checked TEXT
  );

  CREATE TABLE IF NOT EXISTS registry (
    agent_id TEXT PRIMARY KEY,
    agent_uri TEXT NOT NULL,
    chain TEXT NOT NULL DEFAULT 'eip155:8453',
    contract_address TEXT NOT NULL,
    tx_hash TEXT NOT NULL,
    registered_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS reputation (
    id TEXT PRIMARY KEY,
    from_agent TEXT NOT NULL,
    to_agent TEXT NOT NULL,
    score INTEGER NOT NULL,
    comment TEXT NOT NULL DEFAULT '',
    tx_hash TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_skills_enabled ON skills(enabled);
  CREATE INDEX IF NOT EXISTS idx_children_status ON children(status);
  CREATE INDEX IF NOT EXISTS idx_reputation_to ON reputation(to_agent);
`;

// === Phase 2.1 + 2.2: Soul + Memory Tables ===

export const MIGRATION_V5 = `
  -- === Phase 2.1: Soul System ===

  CREATE TABLE IF NOT EXISTS soul_history (
    id TEXT PRIMARY KEY,
    version INTEGER NOT NULL,
    content TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    change_source TEXT NOT NULL CHECK(change_source IN ('agent','human','system','genesis','reflection')),
    change_reason TEXT,
    previous_version_id TEXT REFERENCES soul_history(id),
    approved_by TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_soul_version ON soul_history(version);

  -- === Phase 2.2: Memory System ===

  CREATE TABLE IF NOT EXISTS working_memory (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    content TEXT NOT NULL,
    content_type TEXT NOT NULL CHECK(content_type IN ('goal','observation','plan','reflection','task','decision','note','summary')),
    priority REAL NOT NULL DEFAULT 0.5,
    token_count INTEGER NOT NULL DEFAULT 0,
    expires_at TEXT,
    source_turn TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_wm_session ON working_memory(session_id, priority);

  CREATE TABLE IF NOT EXISTS episodic_memory (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    summary TEXT NOT NULL,
    detail TEXT,
    outcome TEXT CHECK(outcome IN ('success','failure','partial','neutral') OR outcome IS NULL),
    importance REAL NOT NULL DEFAULT 0.5,
    embedding_key TEXT,
    token_count INTEGER NOT NULL DEFAULT 0,
    accessed_count INTEGER NOT NULL DEFAULT 0,
    last_accessed_at TEXT,
    classification TEXT NOT NULL DEFAULT 'maintenance' CHECK(classification IN ('strategic','productive','communication','maintenance','idle','error')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_episodic_type ON episodic_memory(event_type);
  CREATE INDEX IF NOT EXISTS idx_episodic_importance ON episodic_memory(importance);
  CREATE INDEX IF NOT EXISTS idx_episodic_classification ON episodic_memory(classification);

  CREATE TABLE IF NOT EXISTS session_summaries (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL UNIQUE,
    summary TEXT NOT NULL,
    key_decisions TEXT NOT NULL DEFAULT '[]',
    tools_used TEXT NOT NULL DEFAULT '[]',
    outcomes TEXT NOT NULL DEFAULT '[]',
    turn_count INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    total_cost_cents INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS semantic_memory (
    id TEXT PRIMARY KEY,
    category TEXT NOT NULL CHECK(category IN ('self','environment','financial','agent','domain','procedural_ref','creator')),
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    confidence REAL NOT NULL DEFAULT 1.0,
    source TEXT NOT NULL,
    embedding_key TEXT,
    last_verified_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(category, key)
  );

  CREATE INDEX IF NOT EXISTS idx_semantic_category ON semantic_memory(category);

  CREATE TABLE IF NOT EXISTS procedural_memory (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL,
    steps TEXT NOT NULL,
    success_count INTEGER NOT NULL DEFAULT 0,
    failure_count INTEGER NOT NULL DEFAULT 0,
    last_used_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS relationship_memory (
    id TEXT PRIMARY KEY,
    entity_address TEXT NOT NULL UNIQUE,
    entity_name TEXT,
    relationship_type TEXT NOT NULL,
    trust_score REAL NOT NULL DEFAULT 0.5,
    interaction_count INTEGER NOT NULL DEFAULT 0,
    last_interaction_at TEXT,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_rel_trust ON relationship_memory(trust_score);
`;

// === Phase 2.3: Inference & Model Strategy Tables ===

export const MIGRATION_V6 = `
  -- === Phase 2.3: Inference & Model Strategy ===

  CREATE TABLE IF NOT EXISTS inference_costs (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    turn_id TEXT,
    model TEXT NOT NULL,
    provider TEXT NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cost_cents INTEGER NOT NULL DEFAULT 0,
    latency_ms INTEGER NOT NULL DEFAULT 0,
    tier TEXT NOT NULL,
    task_type TEXT NOT NULL CHECK(task_type IN ('agent_turn','heartbeat_triage','safety_check','summarization','planning')),
    cache_hit INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_inf_session ON inference_costs(session_id);
  CREATE INDEX IF NOT EXISTS idx_inf_model ON inference_costs(model);
  CREATE INDEX IF NOT EXISTS idx_inf_created ON inference_costs(created_at);
  CREATE INDEX IF NOT EXISTS idx_inf_task ON inference_costs(task_type);

  CREATE TABLE IF NOT EXISTS model_registry (
    model_id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    display_name TEXT NOT NULL,
    tier_minimum TEXT NOT NULL DEFAULT 'normal',
    cost_per_1k_input INTEGER NOT NULL DEFAULT 0,
    cost_per_1k_output INTEGER NOT NULL DEFAULT 0,
    max_tokens INTEGER NOT NULL DEFAULT 4096,
    context_window INTEGER NOT NULL DEFAULT 128000,
    supports_tools INTEGER NOT NULL DEFAULT 1,
    supports_vision INTEGER NOT NULL DEFAULT 0,
    parameter_style TEXT NOT NULL DEFAULT 'max_tokens' CHECK(parameter_style IN ('max_tokens','max_completion_tokens')),
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`;

// === Phase 3: Replication + Social ===

export const MIGRATION_V7 = `
  -- === Phase 3.1: Replication Lifecycle ===

  CREATE TABLE IF NOT EXISTS child_lifecycle_events (
    id TEXT PRIMARY KEY,
    child_id TEXT NOT NULL,
    from_state TEXT NOT NULL,
    to_state TEXT NOT NULL CHECK(to_state IN (
      'requested','sandbox_created','runtime_ready','wallet_verified',
      'funded','starting','healthy','unhealthy','stopped','failed','cleaned_up'
    )),
    reason TEXT,
    metadata TEXT DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_child_events ON child_lifecycle_events(child_id, created_at);

  -- === Phase 3.2: Social & Registry ===

  CREATE TABLE IF NOT EXISTS discovered_agents_cache (
    agent_address TEXT PRIMARY KEY,
    agent_card TEXT NOT NULL,
    fetched_from TEXT NOT NULL,
    card_hash TEXT NOT NULL,
    valid_until TEXT,
    fetch_count INTEGER NOT NULL DEFAULT 1,
    last_fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS onchain_transactions (
    id TEXT PRIMARY KEY,
    tx_hash TEXT NOT NULL UNIQUE,
    chain TEXT NOT NULL,
    operation TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending','confirmed','failed')),
    gas_used INTEGER,
    metadata TEXT DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_onchain_status ON onchain_transactions(status);
`;

// === Phase 4.1: Observability ===

export const MIGRATION_V8 = `
  -- === Phase 4.1: Observability ===

  CREATE TABLE IF NOT EXISTS metric_snapshots (
    id TEXT PRIMARY KEY,
    snapshot_at TEXT NOT NULL,
    metrics_json TEXT NOT NULL DEFAULT '[]',
    alerts_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_metric_snapshots_at ON metric_snapshots(snapshot_at);
`;

// === Plan A: Orchestration + Memory ===

export const MIGRATION_V9 = `
  -- Schema version: 9
  -- Tables: goals, task_graph, event_stream

  CREATE TABLE goals (
    id TEXT PRIMARY KEY,                    -- ULID
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',  -- active|completed|failed|paused
    strategy TEXT,
    expected_revenue_cents INTEGER DEFAULT 0,
    actual_revenue_cents INTEGER DEFAULT 0,
    created_at TEXT NOT NULL,
    deadline TEXT,
    completed_at TEXT
  );

  CREATE TABLE task_graph (
    id TEXT PRIMARY KEY,                    -- ULID
    parent_id TEXT,                         -- parent task (decomposition)
    goal_id TEXT NOT NULL REFERENCES goals(id),
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', -- pending|assigned|running|completed|failed|blocked|cancelled
    assigned_to TEXT,                       -- agent wallet address (0x...)
    agent_role TEXT,                        -- predefined role name
    priority INTEGER DEFAULT 50,           -- 0-100
    dependencies TEXT DEFAULT '[]',        -- JSON array of task IDs
    result TEXT,                           -- JSON TaskResult
    estimated_cost_cents INTEGER DEFAULT 0,
    actual_cost_cents INTEGER DEFAULT 0,
    max_retries INTEGER DEFAULT 3,
    retry_count INTEGER DEFAULT 0,
    timeout_ms INTEGER DEFAULT 300000,
    created_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT
  );

  CREATE INDEX idx_task_graph_goal ON task_graph(goal_id);
  CREATE INDEX idx_task_graph_status ON task_graph(status);
  CREATE INDEX idx_task_graph_assigned ON task_graph(assigned_to);

  CREATE TABLE event_stream (
    id TEXT PRIMARY KEY,                    -- ULID
    type TEXT NOT NULL,                     -- EventType enum
    agent_address TEXT NOT NULL,
    goal_id TEXT,
    task_id TEXT,
    content TEXT NOT NULL,
    token_count INTEGER NOT NULL,
    compacted_to TEXT,
    created_at TEXT NOT NULL
  );

  CREATE INDEX idx_events_agent ON event_stream(agent_address, created_at);
  CREATE INDEX idx_events_goal ON event_stream(goal_id, created_at);
  CREATE INDEX idx_events_type ON event_stream(type, created_at);
`;

// Role column for children table (must be separate statement for SQLite ALTER)
export const MIGRATION_V9_ALTER_CHILDREN_ROLE = `
  ALTER TABLE children ADD COLUMN role TEXT DEFAULT 'generalist';
`;

// === Solana Integration: Chain Type Column ===

export const MIGRATION_V11 = `
  -- Schema version: 11
  -- Add chain_type column to children table for multi-chain support
  ALTER TABLE children ADD COLUMN chain_type TEXT DEFAULT 'evm';
`;

export const MIGRATION_V12 = `
  -- Schema version: 12
  -- Owner review records are immutable action-bound approvals. Approved records
  -- are audit state only: no financial/cloud executor consumes them.
  CREATE TABLE owner_approval_requests (
    id TEXT PRIMARY KEY,
    requester_id TEXT NOT NULL,
    requester_kind TEXT NOT NULL CHECK(requester_kind IN ('agent','child')),
    scope TEXT NOT NULL CHECK(scope IN ('financial','paid_cloud','publication','commercial','software_change','other')),
    action_name TEXT NOT NULL,
    action_parameters TEXT NOT NULL,
    action_hash TEXT NOT NULL,
    description TEXT NOT NULL,
    estimated_cost_cents INTEGER CHECK(estimated_cost_cents IS NULL OR estimated_cost_cents >= 0),
    risk_level TEXT NOT NULL CHECK(risk_level IN ('safe','caution','dangerous','forbidden')),
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','expired','cancelled','revoked')),
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    reviewed_at TEXT,
    reviewed_by TEXT,
    review_note TEXT
  );

  CREATE UNIQUE INDEX idx_owner_approval_pending_hash
    ON owner_approval_requests(action_hash) WHERE status = 'pending';
  CREATE INDEX idx_owner_approval_status_expiry
    ON owner_approval_requests(status, expires_at);
  CREATE INDEX idx_owner_approval_created
    ON owner_approval_requests(created_at);

  CREATE TABLE owner_approval_events (
    id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL REFERENCES owner_approval_requests(id),
    event_type TEXT NOT NULL CHECK(event_type IN ('requested','approved','rejected','expired','cancelled','revoked')),
    actor_kind TEXT NOT NULL CHECK(actor_kind IN ('agent','child','owner','system')),
    actor_id TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );

  CREATE INDEX idx_owner_approval_events_request
    ON owner_approval_events(request_id, created_at);
`;

export const MIGRATION_V13 = `
  -- Schema version: 13
  -- Persistent opportunity pipeline. Forecasts and owner-entered actuals are
  -- separate records; this schema has no payment or publication executor.
  CREATE TABLE business_opportunities (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    customer_segment TEXT NOT NULL,
    customer_problem TEXT NOT NULL,
    value_proposition TEXT NOT NULL,
    evidence_summary TEXT NOT NULL,
    competitor_summary TEXT NOT NULL DEFAULT '',
    evidence_urls TEXT NOT NULL DEFAULT '[]',
    estimated_cost_cents INTEGER CHECK(estimated_cost_cents IS NULL OR estimated_cost_cents >= 0),
    estimated_revenue_cents INTEGER CHECK(estimated_revenue_cents IS NULL OR estimated_revenue_cents >= 0),
    forecast_days INTEGER NOT NULL CHECK(forecast_days BETWEEN 1 AND 3650),
    confidence REAL NOT NULL CHECK(confidence BETWEEN 0 AND 1),
    risks TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'discovered'
      CHECK(status IN ('discovered','researching','shortlisted','proposal','experiment','completed','rejected')),
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX idx_business_opportunities_status ON business_opportunities(status, updated_at DESC);
  CREATE INDEX idx_business_opportunities_created ON business_opportunities(created_at DESC);

  CREATE TABLE business_opportunity_events (
    id TEXT PRIMARY KEY,
    opportunity_id TEXT NOT NULL REFERENCES business_opportunities(id),
    event_type TEXT NOT NULL CHECK(event_type IN ('created','status_changed','actual_recorded')),
    actor_kind TEXT NOT NULL CHECK(actor_kind IN ('agent','owner','system')),
    actor_id TEXT NOT NULL,
    details TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_business_opportunity_events ON business_opportunity_events(opportunity_id, created_at DESC);

  CREATE TABLE business_opportunity_actuals (
    id TEXT PRIMARY KEY,
    opportunity_id TEXT NOT NULL REFERENCES business_opportunities(id),
    kind TEXT NOT NULL CHECK(kind IN ('income','expense')),
    amount_cents INTEGER NOT NULL CHECK(amount_cents > 0),
    currency TEXT NOT NULL DEFAULT 'GBP' CHECK(currency = 'GBP'),
    description TEXT NOT NULL,
    external_reference TEXT,
    entered_by TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_business_actuals_opportunity ON business_opportunity_actuals(opportunity_id, created_at DESC);
`;

export const MIGRATION_V14 = `
  -- Schema version: 14. Draft-only self-improvement proposals. No executor consumes approval.
  CREATE TABLE self_improvement_proposals (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    rationale TEXT NOT NULL,
    proposed_files TEXT NOT NULL,
    diff_preview TEXT NOT NULL,
    diff_hash TEXT NOT NULL,
    verification_status TEXT NOT NULL DEFAULT 'not_run'
      CHECK(verification_status IN ('not_run','passed','failed')),
    verification_summary TEXT NOT NULL DEFAULT 'Not run: no isolated execution sandbox is available.',
    approval_request_id TEXT NOT NULL REFERENCES owner_approval_requests(id),
    status TEXT NOT NULL DEFAULT 'pending_review'
      CHECK(status IN ('pending_review','approved_for_manual_activation','rejected','expired')),
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    reviewed_by TEXT,
    reviewed_at TEXT,
    review_note TEXT
  );
  CREATE UNIQUE INDEX idx_self_improvement_pending_hash
    ON self_improvement_proposals(diff_hash) WHERE status = 'pending_review';
  CREATE INDEX idx_self_improvement_status ON self_improvement_proposals(status, created_at DESC);
`;

export const MIGRATION_V15 = `
  -- Schema version: 15. Persist bounded exponential retry backoff for task recovery.
  ALTER TABLE task_graph ADD COLUMN next_attempt_at TEXT;
  CREATE INDEX idx_task_graph_next_attempt ON task_graph(status, next_attempt_at);
`;

export const MIGRATION_V16 = `
  -- Schema version: 16. Link each reviewed opportunity to at most one validation goal.
  ALTER TABLE business_opportunities ADD COLUMN validation_goal_id TEXT REFERENCES goals(id);
  CREATE UNIQUE INDEX idx_business_opportunity_validation_goal
    ON business_opportunities(validation_goal_id) WHERE validation_goal_id IS NOT NULL;
`;

export const MIGRATION_V17 = `
  -- Schema version: 17. Proposed experiments are plans only. Owner-entered
  -- results and lessons are separate from forecasts and the actuals ledger.
  CREATE TABLE business_experiments (
    id TEXT PRIMARY KEY,
    opportunity_id TEXT NOT NULL REFERENCES business_opportunities(id),
    title TEXT NOT NULL,
    hypothesis TEXT NOT NULL,
    method TEXT NOT NULL,
    success_criteria TEXT NOT NULL,
    estimated_cost_cents INTEGER CHECK(estimated_cost_cents IS NULL OR estimated_cost_cents >= 0),
    status TEXT NOT NULL DEFAULT 'proposed'
      CHECK(status IN ('proposed','completed','rejected')),
    outcome TEXT,
    lesson TEXT,
    review_note TEXT,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    reviewed_by TEXT,
    reviewed_at TEXT
  );
  CREATE INDEX idx_business_experiments_opportunity ON business_experiments(opportunity_id, created_at DESC);
  CREATE INDEX idx_business_experiments_status ON business_experiments(status, created_at DESC);

  CREATE TABLE business_experiment_events (
    id TEXT PRIMARY KEY,
    experiment_id TEXT NOT NULL REFERENCES business_experiments(id),
    event_type TEXT NOT NULL CHECK(event_type IN ('proposed','completed','rejected')),
    actor_kind TEXT NOT NULL CHECK(actor_kind IN ('agent','owner','system')),
    actor_id TEXT NOT NULL,
    details TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_business_experiment_events ON business_experiment_events(experiment_id, created_at DESC);
`;

export const MIGRATION_V18 = `
  -- Schema version: 18. Preserve isolated self-improvement workspaces and rollback material.
  CREATE TABLE self_improvement_workspaces (
    id TEXT PRIMARY KEY,
    proposal_id TEXT NOT NULL UNIQUE REFERENCES self_improvement_proposals(id),
    workspace_path TEXT NOT NULL,
    manifest_json TEXT NOT NULL,
    manifest_hash TEXT NOT NULL,
    rollback_manifest_json TEXT NOT NULL,
    rollback_hash TEXT NOT NULL,
    verification_status TEXT NOT NULL DEFAULT 'not_run'
      CHECK(verification_status IN ('not_run','passed','failed')),
    verification_summary TEXT NOT NULL,
    prepared_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE self_improvement_workspace_events (
    id TEXT PRIMARY KEY,
    proposal_id TEXT NOT NULL REFERENCES self_improvement_proposals(id),
    event_type TEXT NOT NULL CHECK(event_type IN ('workspace_prepared','workspace_recovered','verification_blocked')),
    actor_kind TEXT NOT NULL CHECK(actor_kind IN ('owner','system')),
    actor_id TEXT NOT NULL,
    details TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_self_improvement_workspace_events ON self_improvement_workspace_events(proposal_id, created_at DESC);
`;

export const MIGRATION_V19 = `
  -- Schema version: 19. Link a completed, owner-reported business experiment to
  -- one persistent follow-up goal in the existing task graph.
  ALTER TABLE business_experiments ADD COLUMN follow_up_goal_id TEXT REFERENCES goals(id);
  CREATE UNIQUE INDEX idx_business_experiment_follow_up_goal
    ON business_experiments(follow_up_goal_id) WHERE follow_up_goal_id IS NOT NULL;
`;

export const MIGRATION_V20 = `
  -- Schema version: 20. Durable local worker identities, execution status and reports.
  CREATE TABLE local_worker_runs (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES task_graph(id),
    parent_worker_id TEXT,
    name TEXT NOT NULL,
    address TEXT NOT NULL,
    role TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('queued','running','stopping','completed','failed','cancelled','interrupted')),
    progress_stage TEXT NOT NULL,
    progress_message TEXT NOT NULL,
    result_json TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX idx_local_worker_runs_task ON local_worker_runs(task_id, created_at DESC);
  CREATE INDEX idx_local_worker_runs_status ON local_worker_runs(status, updated_at DESC);
  CREATE TABLE local_worker_events (
    id TEXT PRIMARY KEY,
    worker_id TEXT NOT NULL REFERENCES local_worker_runs(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL CHECK(event_type IN ('assigned','started','progress','result','failed','cancel_requested','cancelled','interrupted')),
    message TEXT NOT NULL,
    details_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_local_worker_events_worker ON local_worker_events(worker_id, created_at DESC);
`;

export const MIGRATION_V21 = `
  -- Schema version: 21. Structured business research submitted with explicit provenance.
  CREATE TABLE business_opportunity_evidence (
    id TEXT PRIMARY KEY,
    opportunity_id TEXT NOT NULL REFERENCES business_opportunities(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    source_url TEXT NOT NULL,
    claim TEXT NOT NULL,
    source_date TEXT NOT NULL,
    source_type TEXT NOT NULL CHECK(source_type IN ('official','research','news','competitor','other')),
    limitations TEXT NOT NULL,
    submitted_by TEXT NOT NULL,
    verification_status TEXT NOT NULL DEFAULT 'unverified' CHECK(verification_status = 'unverified'),
    created_at TEXT NOT NULL,
    UNIQUE(opportunity_id, source_url, title, claim, source_date, source_type, limitations)
  );
  CREATE INDEX idx_business_evidence_opportunity ON business_opportunity_evidence(opportunity_id, created_at DESC);
`;

export const MIGRATION_V22 = `
  -- Schema version: 22. Evidence topic and stance are agent-reported; truth remains unverified.
  ALTER TABLE business_opportunity_evidence ADD COLUMN claim_area TEXT NOT NULL DEFAULT 'other'
    CHECK(claim_area IN ('problem','demand','competitors','pricing','feasibility','regulatory','other'));
  ALTER TABLE business_opportunity_evidence ADD COLUMN position TEXT NOT NULL DEFAULT 'context'
    CHECK(position IN ('supports','contradicts','context'));
  ALTER TABLE business_opportunity_evidence ADD COLUMN date_basis TEXT NOT NULL DEFAULT 'unknown'
    CHECK(date_basis IN ('publication','accessed','unknown'));
`;

export const MIGRATION_V23 = `
  -- Schema version: 23. Read-only public research retrieval; retrieval never implies factual verification.
  CREATE TABLE business_research_retrievals (
    id TEXT PRIMARY KEY,
    opportunity_id TEXT REFERENCES business_opportunities(id) ON DELETE SET NULL,
    requested_url TEXT NOT NULL,
    final_url TEXT,
    host TEXT NOT NULL,
    research_area TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending','retrieved','failed','blocked')),
    http_status INTEGER,
    content_type TEXT,
    page_title TEXT,
    excerpt TEXT NOT NULL DEFAULT '',
    content_sha256 TEXT,
    error_code TEXT,
    retrieved_at TEXT NOT NULL,
    requested_by TEXT NOT NULL
  );
  CREATE INDEX idx_business_research_host_time ON business_research_retrievals(host, retrieved_at DESC);
  CREATE INDEX idx_business_research_opportunity ON business_research_retrievals(opportunity_id, retrieved_at DESC);
`;

export const MIGRATION_V24 = `
  -- Schema version: 24. Evidence may cite a successful retrieval record without upgrading factual verification.
  ALTER TABLE business_opportunity_evidence ADD COLUMN retrieval_id TEXT REFERENCES business_research_retrievals(id) ON DELETE SET NULL;
  CREATE INDEX idx_business_evidence_retrieval ON business_opportunity_evidence(retrieval_id) WHERE retrieval_id IS NOT NULL;
`;

export const MIGRATION_V25 = `
  -- Schema version: 25. Bounded, versioned business deliverables for owner review.
  CREATE TABLE business_deliverables (
    id TEXT PRIMARY KEY,
    opportunity_id TEXT NOT NULL REFERENCES business_opportunities(id) ON DELETE CASCADE,
    task_id TEXT REFERENCES task_graph(id) ON DELETE SET NULL,
    artifact_type TEXT NOT NULL CHECK(artifact_type IN ('business_plan','market_report','product_spec','prototype_spec','website_draft','experiment_spec')),
    title TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('draft','pending_review','approved_for_internal_use','changes_requested','archived')),
    created_by TEXT NOT NULL,
    reviewed_by TEXT,
    review_note TEXT,
    current_version INTEGER NOT NULL DEFAULT 1 CHECK(current_version > 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    reviewed_at TEXT,
    UNIQUE(opportunity_id, artifact_type, title)
  );
  CREATE INDEX idx_business_deliverables_opportunity ON business_deliverables(opportunity_id, updated_at DESC);
  CREATE INDEX idx_business_deliverables_status ON business_deliverables(status, updated_at DESC);
  CREATE TABLE business_deliverable_versions (
    id TEXT PRIMARY KEY,
    deliverable_id TEXT NOT NULL REFERENCES business_deliverables(id) ON DELETE CASCADE,
    version INTEGER NOT NULL CHECK(version > 0),
    content_sha256 TEXT NOT NULL CHECK(length(content_sha256) = 64),
    byte_size INTEGER NOT NULL CHECK(byte_size BETWEEN 1 AND 65536),
    storage_path TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(deliverable_id, version)
  );
  CREATE INDEX idx_business_deliverable_versions_latest ON business_deliverable_versions(deliverable_id, version DESC);
  CREATE TABLE business_deliverable_events (
    id TEXT PRIMARY KEY,
    deliverable_id TEXT NOT NULL REFERENCES business_deliverables(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL CHECK(event_type IN ('prepared','version_added','reviewed')),
    actor_kind TEXT NOT NULL CHECK(actor_kind IN ('agent','owner','system')),
    actor_id TEXT NOT NULL,
    details_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_business_deliverable_events ON business_deliverable_events(deliverable_id, created_at DESC);
`;

export const MIGRATION_V10 = `
  -- Schema version: 10
  -- Tables: knowledge_store

  CREATE TABLE knowledge_store (
    id TEXT PRIMARY KEY,                    -- ULID
    category TEXT NOT NULL,                 -- market|technical|social|financial|operational
    key TEXT NOT NULL,
    content TEXT NOT NULL,
    source TEXT NOT NULL,                   -- agent address that contributed
    confidence REAL DEFAULT 1.0,
    last_verified TEXT NOT NULL,
    access_count INTEGER DEFAULT 0,
    token_count INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT
  );

  CREATE INDEX idx_knowledge_category ON knowledge_store(category);
  CREATE INDEX idx_knowledge_key ON knowledge_store(key);
`;
