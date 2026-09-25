# n8n-nodes-darkmoon

> **📦 Marketplace status:** Published on [npm](https://www.npmjs.com/package/n8n-nodes-darkmoon) — installable as a community node today. n8n **verified-community-node** submission **pending review**.

[![npm version](https://img.shields.io/npm/v/n8n-nodes-darkmoon?color=4f46e5&label=npm)](https://www.npmjs.com/package/n8n-nodes-darkmoon)
[![n8n community node](https://img.shields.io/badge/n8n-community%20node-ff6d5a)](https://docs.n8n.io/integrations/community-nodes/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)

An [n8n](https://n8n.io) **community node + trigger** for [Darkmoon](https://dark-moon.org),
the autonomous AI pentest platform. Launch pentest campaigns, read findings, run
retests, pull security-posture metrics, manage webhooks — and start workflows the
moment Darkmoon confirms a finding, completes a campaign, or opens a fix pull request.

Use it as SOAR glue: **exploited finding → Slack/Jira/DefectDojo**, **remediation PR
merged → auto-retest → post verdict**, **nightly scan → posture digest**.

## ⭐ Darkmoon ecosystem

Darkmoon is open-source — **a star really helps us grow.** [![Star the Darkmoon core](https://img.shields.io/github/stars/ASCIT31/Dark-Moon?style=social&label=Star%20Darkmoon)](https://github.com/ASCIT31/Dark-Moon)

🌐 **Website:** [dark-moon.org](https://dark-moon.org) · 📚 **Docs:** [docs.dark-moon.org](https://docs.dark-moon.org) · ⭐ **Star the core:** [github.com/ASCIT31/Dark-Moon](https://github.com/ASCIT31/Dark-Moon)

**Install the integrations, right where you work:**

| Platform | Get it |
|---|---|
| VS Code | [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=Darkmoon.darkmoon-vscode) |
| JetBrains | [JetBrains Marketplace](https://plugins.jetbrains.com/plugin/34497-darkmoon) |
| GitHub Actions | [GitHub Marketplace](https://github.com/marketplace/actions/darkmoon-pentest) |
| GitLab CI/CD | [CI/CD Catalog](https://gitlab.com/explore/catalog/Dark-Moon-X/darkmoon-scan) |
| Jenkins | [Download the .hpi](https://github.com/ASCIT31/darkmoon-jenkins/releases) |
| Client & CLI | [npm: @darkmoon_ai/client](https://www.npmjs.com/package/@darkmoon_ai/client) |

## Screenshots

Captured from a **real n8n** (`n8nio/n8n`) running this node in Docker against a
synthetic **Demo Shop** campaign (zeroed secrets).

| The node on a canvas | The operation picker |
|---|---|
| ![Darkmoon node on an n8n canvas](https://raw.githubusercontent.com/ASCIT31/darkmoon-n8n/main/docs/screenshots/01-canvas-workflow.png) | ![Darkmoon operation dropdown](https://raw.githubusercontent.com/ASCIT31/darkmoon-n8n/main/docs/screenshots/02-operation-dropdown.png) |

| The trigger configuration | A template running |
|---|---|
| ![Darkmoon Trigger config](https://raw.githubusercontent.com/ASCIT31/darkmoon-n8n/main/docs/screenshots/03-trigger-config.png) | ![Template executed successfully](https://raw.githubusercontent.com/ASCIT31/darkmoon-n8n/main/docs/screenshots/04-template-running.png) |

## Installation

In n8n: **Settings → Community Nodes → Install**, then enter:

```
n8n-nodes-darkmoon
```

Or self-host with npm:

```bash
npm install n8n-nodes-darkmoon
```

The package is **dependency-free at runtime** (the shared Darkmoon client is bundled
at build time) and published with **npm provenance** from GitHub Actions.

**Compatibility:** n8n `>= 1.60`, Node `>= 20.15`. `n8nNodesApiVersion: 1`. Tested
against n8n `2.40.x`.

## Credentials — `Darkmoon API`

Create a **Darkmoon API** credential:

| Field | Notes |
|---|---|
| **Base URL** | Your Darkmoon **Pro** REST API, e.g. `https://darkmoon.internal:8000` (with or without the `/api/v1` suffix). |
| **Authentication** | `API Token (Bearer)` (recommended) or `Username and Password` (the node logs in and caches the short-lived JWT in memory). |
| **API Token** / **Username / Password** | Stored with n8n's credential encryption. Secrets are never logged. |

The **Test** button calls `GET /api/v1/system/info` to confirm the Base URL points at
a real Darkmoon API and reports its edition + contract version.

> **Networked deployments:** Darkmoon's write endpoints (`run/*`, `retest/*`,
> `webhooks/*`) are destructive. Set `DARKMOON_REQUIRE_AUTH_WRITES=1` on the Pro API
> and use a scoped token for any workflow that can launch campaigns or retests.

## The `Darkmoon` node (actions)

| Resource | Operation | What it does |
|---|---|---|
| **Campaign** | Launch | Start a pentest against an authorised target (optional wait-for-completion; optional remediation → fix PR). |
| | Get | Get one campaign by ID. |
| | List | List past & running campaigns (filter by target / status). |
| | Get Severity Summary | Severity counts for a campaign. |
| **Finding** | List | List findings (filter by campaign / severity / status / category). |
| | Get | Get one finding by ID. |
| | Get Evidence Metadata | Counts-only evidence metadata (never the evidence itself). |
| **Retest** | Launch | Re-run a target or base campaign and compute per-finding verdicts. |
| | Get Verdicts | Verdicts: `fixed` / `still_present` / `regressed` / `new`. |
| **Metric** | Get Timeseries | Security-posture time series (severity / status / category / campaigns). |
| **Webhook** | Register / List / Delete | Manage Darkmoon Pro webhooks (safe-field events, HMAC-signed). |

### Remediation

On **Campaign → Launch**, enable **Remediation** to let Darkmoon try to fix confirmed
issues and open a **pull request for a human to review** (it never merges). It requires
an **opaque credential reference** — a Darkmoon vault ID, **not** a token; no SCM secret
ever travels through the workflow.

## The `Darkmoon Trigger` node

Starts a workflow on Darkmoon events, with an **event-type filter**
(`campaign.*` / `finding.*` / `pr.*`). Two modes:

- **Poll (recommended)** — a polling trigger that reproduces the event taxonomy with a
  cloud-safe synthetic **poll-and-diff**. It reads campaigns / findings / pull-requests
  each poll, diffs them against a durable cursor kept in the workflow static data
  (exactly-once), and works behind NAT. First activation only primes the cursor (no
  historical replay storm).
- **Webhook** — registers a Darkmoon **Pro webhook** that POSTs signed events straight
  to this node; the `X-Darkmoon-Signature` HMAC is verified before the workflow runs.

## Templates

Four importable workflows in [`templates/`](./templates) (**n8n → Import from File**):

| # | Template | Flow |
|---|---|---|
| 1 | **Darkmoon → DefectDojo** | Launch campaign → list findings (redaction-safe) → map to DefectDojo Generic Findings Import v2 → upload → Slack notify. |
| 2 | **Alert on `finding.exploited`** | Darkmoon Trigger (exploited) → format → Slack/Teams alert (safe fields only). |
| 3 | **Auto-retest on PR merged** | Darkmoon Trigger (PR events) → *if merged* → launch retest → wait → post verdict to Slack. |
| 4 | **Scheduled posture digest** | Schedule → Get Timeseries → format → Slack digest. |

Each references a **Darkmoon API** credential and any third-party credentials (Slack,
DefectDojo) — set them via n8n credentials, never `$env`.

## Redaction & the OSS / Pro boundary (stated honestly)

- **Evidence is never emitted.** Findings are returned with `evidence: null`; the
  internal `raw` mirror is dropped and the output is scrubbed for secrets. To see that
  evidence *exists*, use **Get Evidence Metadata** — counts only, never content.
- **Secrets never travel or log.** SCM credentials are opaque vault references; tokens
  live only in n8n's encrypted credential store.
- **This node targets Darkmoon Pro** (the networked REST API). The **web dashboard, SSE
  event stream, scheduler and remediation → PR are Pro-only** capabilities and are not
  open source. The open-source Darkmoon core is the CLI + agents; a co-located OSS
  install without the Pro API is not addressable by a networked automation host like n8n.
- The node reuses the shared **`@darkmoon_ai/client`** contract (its normalizers,
  redaction and verdict helpers) so its data model can never drift from the rest of the
  Darkmoon ecosystem. Transport uses n8n's own HTTP helper, per community-node rules.

## Testing it yourself (real Docker n8n)

```bash
docker compose -f docker/docker-compose.yml up -d      # n8n + a mock Darkmoon API
# open http://localhost:5678 , add a Darkmoon API credential
#   Base URL: http://mock-darkmoon:8000 , any token
# import a template from /home/node/templates , run it
```

Local checks:

```bash
npm ci
npm run lint          # eslint-plugin-n8n-nodes-base
npm run build         # tsc + esbuild bundle + icons
npm test              # drives the built nodes against the mock; asserts no secret leak
```

## License

MIT © ASC-IT (SARL) — Darkmoon
