# Changelog

All notable changes to `n8n-nodes-darkmoon` are documented here. This project
follows [Semantic Versioning](https://semver.org/).

## [0.3.0] - 2026-09-25

Upgraded to the official n8n **community-node standard** (repo moved to
[ASCIT31/darkmoon-n8n](https://github.com/ASCIT31/darkmoon-n8n)).

### Added
- **`Darkmoon Trigger` node** — fires on Darkmoon events (`campaign.*` / `finding.*` /
  `pr.*`) with an event-type filter. **Poll** mode (cloud-safe synthetic poll-and-diff
  with a durable cursor, works behind NAT) and **Webhook** mode (registers a Pro webhook,
  verifies the `X-Darkmoon-Signature` HMAC).
- **Resource/operation UX** on the action node: **Campaign** (Launch / Get / List / Get
  Severity Summary), **Finding** (List / Get / Get Evidence Metadata), **Retest** (Launch
  / Get Verdicts), **Metric** (Get Timeseries), **Webhook** (Register / List / Delete).
- **Retest verdicts** (`fixed` / `still_present` / `regressed` / `new`), **evidence
  metadata** (counts only), **security-posture timeseries**, and **webhook** management.
- **Four importable templates** (`templates/`): Darkmoon → DefectDojo, alert on
  `finding.exploited`, auto-retest on PR merged, scheduled posture digest.
- Token authentication on the **Darkmoon API** credential (bearer), alongside
  username/password; themed node & credential icons; `credentialTest` via `system/info`.
- Real **Docker test lab** (`docker/docker-compose.yml`) — n8n + a mock Darkmoon API —
  and mandatory screenshots captured from it (`docs/screenshots/`).

### Changed
- **Adopts the shared `@darkmoon_ai/client`** data model (normalizers, redaction and
  verdict helpers) in place of the bespoke `DarkmoonClient`, so the node can never drift
  from the rest of the Darkmoon ecosystem. Transport uses n8n's own `httpRequest` helper.
- Node namespace fixed to `n8n-nodes-darkmoon.*`; package is **dependency-free at
  runtime** (the client is bundled at build time).

### Verification
- Passes `eslint-plugin-n8n-nodes-base` **and** the full `@n8n/scan-community-package`
  (`@n8n/eslint-plugin-community-nodes` recommended) ruleset — 0 errors on both the
  source and the published artifact.

## [0.2.0] - 2026-09-16

**Published to npm:** https://www.npmjs.com/package/n8n-nodes-darkmoon (v0.2.0, `latest`) —
built and signed on GitHub Actions with npm provenance (SLSA provenance v1).
Release: https://github.com/ASCIT31/n8n-nodes-darkmoon/releases/tag/v0.2.0

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
