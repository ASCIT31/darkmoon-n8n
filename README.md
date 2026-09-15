# n8n-nodes-darkmoon

An [n8n](https://n8n.io) community node for [Darkmoon](https://github.com/ASCIT31) — the local, privacy-first AI penetration-testing engine.

It lets an n8n workflow **trigger a Darkmoon pentest against a target you are authorised to assess and pull back the findings**, so security testing can be wired into CI/CD, ticketing, chat and reporting automations like any other step.

> Darkmoon **runs and validates** security tests. It does not, and this node does not, guarantee that a system is secure. Findings can include false positives and must be reviewed by a qualified human. Only run assessments against systems you own or have explicit written authorisation to test.

[Installation](#installation) · [Credentials](#credentials) · [Operations](#operations) · [How it works](#how-it-works) · [Development & tests](#development--tests) · [Submission plan](#submission-plan)

## Installation

Follow the [n8n community nodes installation guide](https://docs.n8n.io/integrations/community-nodes/installation/). In a self-hosted n8n:

**Settings → Community Nodes → Install**, then enter `n8n-nodes-darkmoon`.

## Credentials

This node talks to the **Darkmoon Dashboard API** (the FastAPI service shipped with Darkmoon, typically on port `8000`). Darkmoon issues a short-lived JWT from `POST /api/v1/auth/login`, so the node logs in at run time using stored credentials.

Create a **Darkmoon API** credential with:

| Field      | Example                       | Notes                                   |
| ---------- | ----------------------------- | --------------------------------------- |
| Base URL   | `http://darkmoon.internal:8000` | Base URL of the Darkmoon Dashboard API |
| Username   | `admin`                       | Dashboard user                          |
| Password   | `••••••••`                    | Dashboard password                      |

Use the credential's **Test** button to verify — it calls the real login endpoint.

## Operations

### Run Pentest
Starts a pentest against **Target** (URL or host). With **Wait for Completion** on (default), the node polls the run to completion and returns the resolved campaign plus its findings and severity stats. With it off, it returns the `run_id` immediately for a later **Get Findings** call.

Options: additional targets, out-of-scope, exclude, focus areas, minimum severity, safe-harbor reference, poll interval and timeout.

### Get Findings
Returns the vulnerabilities for a **Campaign ID**, with aggregated stats (`by_severity`, `by_category`, `by_status`).

### Get Report
Returns the markdown report for a **Campaign ID**.

### List Campaigns
Lists past and running campaigns.

## How it works

The node maps to the Darkmoon Dashboard REST API (read from `Dark-Moon-Front-API`, branch `dev`):

| Step                    | Endpoint                                            |
| ----------------------- | --------------------------------------------------- |
| Authenticate            | `POST /api/v1/auth/login`                            |
| Start a run             | `POST /api/v1/run/campaign`                          |
| Follow run state        | `GET /api/v1/run/logs/{run_id}` (JSONL, terminal event = done) |
| Resolve the campaign    | `GET /api/v1/campaigns` (diff before/after the run)  |
| Fetch findings          | `GET /api/v1/vulnerabilities?campaign_id=…`          |
| Fetch report            | `GET /api/v1/campaigns/{id}/report`                  |

The trigger endpoint returns a `run_id`; the pentest agent creates the campaign itself. The node therefore correlates a run to its campaign by snapshotting the campaign set before the run and picking the one that appears afterwards. See [`docs/API.md`](docs/API.md) for the exact contract and a proposed first-class `run_id → campaign_id` link.

## Development & tests

```bash
npm install
npm run build     # tsc + copy icons into dist/
npm run lint      # eslint-plugin-n8n-nodes-base (the verification ruleset)
npm run test:e2e  # requires a running Darkmoon API at $BASE_URL
```

### End-to-end test

`test/run_local_api.sh` starts the **real** Darkmoon Dashboard API locally (no Docker required — it is a FastAPI-over-JSON service) against an isolated copy of its data store, with the `opencode` pentest engine replaced by `test/stub_opencode`. The stub drives the **real** dashboard write-path (`init_live_campaign` / `push_finding` / `finalize_campaign`), so the full trigger → wait → resolve-campaign → findings → report flow is exercised against real API code:

```bash
FRONT_API=/path/to/Dark-Moon-Front-API bash test/run_local_api.sh
```

The engine's LLM-driven discovery (sealed container + license) is not part of this test; the finding it produces is a labelled lab fixture, not an LLM result.

## Submission plan

This package targets the n8n community-nodes registry (npm) and the **verified community nodes** programme. It already meets the structural rules: `n8n-nodes-` name, `n8n-community-node-package` keyword, `n8n` object with `n8nNodesApiVersion`, no runtime dependencies, MIT licence, English UI/docs, no filesystem/env access in node code, and it passes the linter. Publishing is wired to GitHub Actions with npm **provenance** (`.github/workflows/publish.yml`), as required for verification from 2026-05-01.

Steps to publish:
1. Push this package to `github.com/ASCIT31/n8n-nodes-darkmoon`.
2. `npx @n8n/scan-community-package n8n-nodes-darkmoon` and fix anything it flags.
3. Create a GitHub release → the workflow publishes to npm with provenance.
4. Submit for verification via the n8n creator portal / [submit community nodes](https://docs.n8n.io/integrations/creating-nodes/deploy/submit-community-nodes/) process.

## License

[MIT](LICENSE)
