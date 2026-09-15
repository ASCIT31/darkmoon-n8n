# Darkmoon Dashboard API — the interface this node uses

Source of truth: `Dark-Moon-Front-API`, branch `dev`, `mcp/api/*` (FastAPI app in `api_server.py`). All routes are versioned under `/api/v1`. This document records the exact contract the node relies on and the one improvement that would make the integration first-class.

## Endpoints used

### Auth — `mcp/api/routes_auth.py`
```
POST /api/v1/auth/login        { username, password } -> { token, must_change_password, user }
GET  /api/v1/auth/me           (Bearer)               -> { user }
```
Token is a self-signed HS256 JWT, TTL 12h (`JWT_TTL_HOURS`). Send it as `Authorization: Bearer <token>`.

### Run — `mcp/api/routes_run.py`
```
POST   /api/v1/run/campaign            CampaignRunRequest -> { run_id, pid, command }
GET    /api/v1/run/logs/{run_id}                          -> { data: event[], total }
GET    /api/v1/run/{run_id}/stream                        -> text/event-stream (SSE)
GET    /api/v1/run/active                                 -> { data: run_id[], total }
DELETE /api/v1/run/{run_id}/stop                          -> { message, run_id }
```
`CampaignRunRequest` fields: `target` (required), `program`, `targets[]`, `out_of_scope[]`, `exclude[]`, `focus[]`, `credentials[]`, `tokens[]`, `noise`, `severity`, `format`, `rules[]`, `safe_harbor`, plus remediation fields (`git_repo`, `credential_id`, `create_repo`, `remediate`).

The run is executed by spawning `opencode run --agent pentest --format json "<prompt>"`. The JSONL log is the single source of truth for run state: **no terminal event (`run_completed` / `run_error`) means the run is still going.** The node polls `…/logs/{run_id}` until a terminal event appears (the SSE stream carries the same events).

### Campaigns / findings / report — `routes_campaigns.py`, `routes_vulnerabilities.py`
```
GET /api/v1/campaigns                          -> { data: campaign[], total }
GET /api/v1/campaigns/{id}                      -> { data: campaign + vulnerabilities }
GET /api/v1/campaigns/{id}/report              -> { campaign_id, format, content }
GET /api/v1/vulnerabilities?campaign_id=…       -> { data: finding[], total, stats }
```
Findings carry: `id`, `title`, `severity`, `status`, `category`, `cvss_score`, `cvss_vector`, `cve`, `mitre_attack_id`, `iso27001_control`, `description`, `evidence`, `remediation`, `endpoint`, `discovered_by_agent`. Stats aggregate `by_severity`, `by_category`, `by_status`.

## The correlation gap (and how the node works around it)

`POST /run/campaign` returns a **`run_id`**, but findings are keyed by **`campaign_id`**. The pentest agent creates the campaign itself, inside the run, via the MCP tool `dashboard_init_campaign(session_id, target_host, …)`, which mints `campaign_id = camp_<YYYYMMDD>_<session_fragment>`. There is today **no endpoint that maps a `run_id` to its `campaign_id`.**

Workaround used by this node (`DarkmoonClient.resolveRunCampaign`): snapshot the campaign id set **before** triggering, then after the run finishes pick the campaign that is **new** (falling back to the newest whose id matches the target host). This works but is best-effort — it can be ambiguous if several runs finish concurrently.

### Proposed minimal API change (first-class link)

Make the trigger response and the run log carry the campaign id. Smallest viable change:

1. Have the run route pass a correlation id into the prompt (e.g. `RUN_ID=<run_id>`), and have `dashboard_init_campaign` persist it on the campaign as `run_id`.
2. Add `GET /api/v1/run/{run_id}/campaign -> { campaign_id }` (or include `campaign_id` in the terminal `run_completed` event once known).

With either in place, the node would resolve findings deterministically:
`run_id -> campaign_id -> GET /vulnerabilities?campaign_id=…`, and the snapshot-diff heuristic could be dropped.

## Minor issue observed

`GET /api/v1/campaigns/{id}/report` returns HTTP 500 (`IsADirectoryError`) when a campaign has an empty `report_path`, instead of the intended graceful "Report not found" body — `load_report_content("")` resolves to the data directory. Worth a guard in `json_storage.load_report_content` for empty/falsey paths.
