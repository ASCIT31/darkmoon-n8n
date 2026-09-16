# Changelog

All notable changes to `n8n-nodes-darkmoon` are documented here. This project
follows [Semantic Versioning](https://semver.org/).

## [0.2.0] - 2026-09-16

### Added
- **Remediation on Run Pentest.** New **Enable Remediation** toggle (default off; off = unchanged behaviour). When on, the node passes the opaque `credential_id` (a Darkmoon vault reference, never a token), `git_repo` and `create_repo` to the run, and returns any fix pull requests. Includes a bounded **Wait for Pull Requests** poll (never loops forever).
- **Pull-request operations** (read-only): **List Pull Requests** (server filter `campaign_id`, plus client-side state/provider/repository filters), **Get Pull Request**, **Get Pull Requests by Finding** — mapped to the real `/api/v1/pull-requests` endpoints and `pr_store.py` fields/states.
- `DarkmoonClient`: `listPullRequests`, `getPullRequest`, `getPullRequestsForFinding`, `filterPullRequests`, `waitForPullRequests`, `validateRemediation`, and `PR_STATES`.
- Importable example workflow **"Darkmoon Pentest and Remediation Review"** (`examples/`) — merges nothing.
- Unit test suite (`test/unit.mjs`): remediation validation, 401/403/404/500 mapping, empty/malformed responses, wait/poll timeouts, and no-secret-leakage.
- README sections: Remediation (+ lifecycle), Security notes, Limitations; `docs/API.md` PR contract.

### Security
- Remediation uses an opaque credential reference only; SCM secrets never travel through workflow parameters. The node never logs secrets and error messages surface only the API `detail`. The node never merges pull requests.

## [0.1.0] - 2026-09-15

### Added
- Initial node: **Run Pentest** (trigger + wait), **Get Findings**, **Get Report**, **List Campaigns**.
- Dependency-free `DarkmoonClient` over the Darkmoon Dashboard REST API; `Darkmoon API` credential with a real login-endpoint test.
- Build (tsc + gulp icons), `eslint-plugin-n8n-nodes-base` linting, GitHub Actions npm publish with provenance, and a live-API e2e test.
