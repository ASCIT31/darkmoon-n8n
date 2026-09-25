import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	JsonObject,
	NodeConnectionType,
} from 'n8n-workflow';
import { NodeApiError, NodeOperationError } from 'n8n-workflow';

import {
	authorize,
	csv,
	dm,
	dmDelete,
	launchAndCorrelate,
	normalizeCampaignSafe,
	sanitizeFinding,
	severitySummaryOf,
} from './GenericFunctions';

/**
 * Darkmoon action node.
 *
 * Every operation runs through the official shared client `@darkmoon_ai/client`
 * (bundled at build time). There is no bespoke HTTP. Redaction is safe by
 * default: findings never carry evidence, the full report needs a two-key opt-in,
 * and remediation SCM secrets travel only as opaque vault references.
 */
export class Darkmoon implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Darkmoon',
		name: 'darkmoon',
		icon: { light: 'file:darkmoon.svg', dark: 'file:darkmoon.svg' },
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description: 'Launch AI pentest campaigns, read findings, run retests and manage Darkmoon webhooks',
		defaults: {
			name: 'Darkmoon',
		},
		usableAsTool: true,
		inputs: ['main'] as NodeConnectionType[],
		outputs: ['main'] as NodeConnectionType[],
		credentials: [
			{
				name: 'darkmoonApi',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				default: 'campaign',
				options: [
					{ name: 'Campaign', value: 'campaign' },
					{ name: 'Finding', value: 'finding' },
					{ name: 'Metric', value: 'metric' },
					{ name: 'Retest', value: 'retest' },
					{ name: 'Webhook', value: 'webhook' },
				],
			},

			// ── Campaign operations ──────────────────────────────────────
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				default: 'launch',
				displayOptions: { show: { resource: ['campaign'] } },
				options: [
					{
						name: 'Get',
						value: 'get',
						description: 'Get one campaign by ID',
						action: 'Get a campaign',
					},
					{
						name: 'Get Severity Summary',
						value: 'getSeveritySummary',
						description: 'Get the severity counts for a campaign',
						action: 'Get the severity summary of a campaign',
					},
					{
						name: 'Launch',
						value: 'launch',
						description: 'Launch a pentest campaign against an authorised target',
						action: 'Launch a campaign',
					},
					{
						name: 'List',
						value: 'list',
						description: 'List past and running campaigns',
						action: 'List campaigns',
					},
				],
			},

			// ── Finding operations ───────────────────────────────────────
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				default: 'list',
				displayOptions: { show: { resource: ['finding'] } },
				options: [
					{
						name: 'Get',
						value: 'get',
						description: 'Get one finding by ID (evidence excluded by default)',
						action: 'Get a finding',
					},
					{
						name: 'Get Evidence Metadata',
						value: 'getEvidenceMeta',
						description: 'Get counts-only evidence metadata for a finding (never the evidence itself)',
						action: 'Get evidence metadata for a finding',
					},
					{
						name: 'List',
						value: 'list',
						description: 'List findings, filtered by campaign, severity, status or category',
						action: 'List findings',
					},
				],
			},

			// ── Retest operations ────────────────────────────────────────
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				default: 'launch',
				displayOptions: { show: { resource: ['retest'] } },
				options: [
					{
						name: 'Get Verdicts',
						value: 'get',
						description: 'Get a retest and its per-finding verdicts (fixed / still present / regressed / new)',
						action: 'Get retest verdicts',
					},
					{
						name: 'Launch',
						value: 'launch',
						description: 'Re-run a target or campaign and compute per-finding verdicts',
						action: 'Launch a retest',
					},
				],
			},

			// ── Metric operations ────────────────────────────────────────
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				default: 'getTimeseries',
				displayOptions: { show: { resource: ['metric'] } },
				options: [
					{
						name: 'Get Timeseries',
						value: 'getTimeseries',
						description: 'Get a security-posture time series (severity, status, category or campaigns)',
						action: 'Get a metrics time series',
					},
				],
			},

			// ── Webhook operations ───────────────────────────────────────
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				default: 'list',
				displayOptions: { show: { resource: ['webhook'] } },
				options: [
					{
						name: 'Delete',
						value: 'delete',
						description: 'Delete a registered Darkmoon webhook',
						action: 'Delete a webhook',
					},
					{
						name: 'List',
						value: 'list',
						description: 'List registered Darkmoon webhooks',
						action: 'List webhooks',
					},
					{
						name: 'Register',
						value: 'register',
						description: 'Register a webhook so Darkmoon posts signed events to a URL',
						action: 'Register a webhook',
					},
				],
			},

			// ── Campaign: Launch ─────────────────────────────────────────
			{
				displayName: 'Target',
				name: 'target',
				type: 'string',
				default: '',
				required: true,
				placeholder: 'http://juice-shop.lab:3000 or 10.0.0.5',
				description: 'Primary target URL or host. Only test systems you are explicitly authorised to assess.',
				displayOptions: { show: { resource: ['campaign'], operation: ['launch'] } },
			},
			{
				displayName: 'Wait for Completion',
				name: 'waitForCompletion',
				type: 'boolean',
				default: true,
				description: 'Whether to poll until the campaign finishes and return its final status. If off, returns immediately with the run reference.',
				displayOptions: { show: { resource: ['campaign'], operation: ['launch'] } },
			},
			{
				displayName: 'Enable Remediation',
				name: 'enableRemediation',
				type: 'boolean',
				default: false,
				description: 'Whether Darkmoon should also try to fix confirmed issues and open a pull request for a human to review. It never merges anything. Requires an opaque credential reference below.',
				displayOptions: { show: { resource: ['campaign'], operation: ['launch'] } },
			},
			{
				displayName: 'Remediation Settings',
				name: 'remediation',
				type: 'collection',
				placeholder: 'Add Setting',
				default: {},
				displayOptions: {
					show: { resource: ['campaign'], operation: ['launch'], enableRemediation: [true] },
				},
				options: [
					{
						displayName: 'Allow Darkmoon to Create the Repository',
						name: 'createRepository',
						type: 'boolean',
						default: false,
						description: 'Whether to authorise Darkmoon to create the repository if it does not exist yet',
					},
					{
						displayName: 'Credential Reference',
						name: 'credentialReference',
						type: 'string',
						default: '',
						description: 'Opaque ID of a source-control credential already stored in Darkmoon\'s vault. This is a reference, NOT a token — no secret is sent through the workflow.',
					},
					{
						displayName: 'Repository URL',
						name: 'repositoryUrl',
						type: 'string',
						default: '',
						placeholder: 'https://github.com/acme/shop',
						description: 'Source repository the target was built from, where the fix pull request is opened',
					},
				],
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				displayOptions: { show: { resource: ['campaign'], operation: ['launch'] } },
				options: [
					{
						displayName: 'Additional Targets',
						name: 'targets',
						type: 'string',
						default: '',
						description: 'Comma-separated extra in-scope targets',
					},
					{
						displayName: 'Exclude',
						name: 'exclude',
						type: 'string',
						default: '',
						description: 'Comma-separated exclusions',
					},
					{
						displayName: 'Focus',
						name: 'focus',
						type: 'string',
						default: '',
						description: 'Comma-separated focus areas (e.g. sqli,xss,auth)',
					},
					{
						displayName: 'Minimum Severity',
						name: 'severity',
						type: 'options',
						default: '',
						options: [
							{ name: 'Any', value: '' },
							{ name: 'Critical', value: 'critical' },
							{ name: 'High', value: 'high' },
							{ name: 'Low', value: 'low' },
							{ name: 'Medium', value: 'medium' },
						],
					},
					{
						displayName: 'Out of Scope',
						name: 'outOfScope',
						type: 'string',
						default: '',
						description: 'Comma-separated hosts/paths that must not be touched',
					},
					{
						displayName: 'Poll Interval (Seconds)',
						name: 'pollSeconds',
						type: 'number',
						default: 5,
						description: 'How often to poll while waiting for completion',
					},
					{
						displayName: 'Program / Scope Name',
						name: 'program',
						type: 'string',
						default: '',
						description: 'Free-text program or engagement name recorded with the run',
					},
					{
						displayName: 'Safe Harbor Reference',
						name: 'safeHarbor',
						type: 'string',
						default: '',
						description: 'Reference to the authorisation / safe-harbor policy for this engagement',
					},
					{
						displayName: 'Timeout (Minutes)',
						name: 'timeoutMinutes',
						type: 'number',
						default: 30,
						description: 'Give up waiting after this many minutes (the run keeps going server-side)',
					},
				],
			},

			// ── Campaign: Get / Get Severity Summary ─────────────────────
			{
				displayName: 'Campaign ID',
				name: 'campaignId',
				type: 'string',
				default: '',
				required: true,
				description: 'The campaign to read (from a Launch output or List)',
				displayOptions: {
					show: { resource: ['campaign'], operation: ['get', 'getSeveritySummary'] },
				},
			},

			// ── Campaign: List filters ───────────────────────────────────
			{
				displayName: 'Filters',
				name: 'campaignFilters',
				type: 'collection',
				placeholder: 'Add Filter',
				default: {},
				displayOptions: { show: { resource: ['campaign'], operation: ['list'] } },
				options: [
					{
						displayName: 'Status',
						name: 'status',
						type: 'string',
						default: '',
						description: 'Filter by campaign status (running, completed, stopped, aborted)',
					},
					{
						displayName: 'Target ID',
						name: 'targetId',
						type: 'string',
						default: '',
						description: 'Filter by target ID',
					},
				],
			},

			// ── Finding: List ────────────────────────────────────────────
			{
				displayName: 'Filters',
				name: 'findingFilters',
				type: 'collection',
				placeholder: 'Add Filter',
				default: {},
				displayOptions: { show: { resource: ['finding'], operation: ['list'] } },
				options: [
					{
						displayName: 'Campaign ID',
						name: 'campaignId',
						type: 'string',
						default: '',
						description: 'Restrict to one campaign',
					},
					{
						displayName: 'Category',
						name: 'category',
						type: 'string',
						default: '',
					},
					{
						displayName: 'Project ID',
						name: 'projectId',
						type: 'string',
						default: '',
					},
					{
						displayName: 'Severity',
						name: 'severity',
						type: 'options',
						default: '',
						options: [
							{ name: 'Any', value: '' },
							{ name: 'Critical', value: 'critical' },
							{ name: 'High', value: 'high' },
							{ name: 'Info', value: 'info' },
							{ name: 'Low', value: 'low' },
							{ name: 'Medium', value: 'medium' },
						],
					},
					{
						displayName: 'Status',
						name: 'status',
						type: 'string',
						default: '',
						description: 'Filter by finding status (exploited, confirmed, unconfirmed, remediated)',
					},
					{
						displayName: 'Target ID',
						name: 'targetId',
						type: 'string',
						default: '',
					},
				],
			},

			// ── Finding: Get / Get Evidence Metadata ─────────────────────
			{
				displayName: 'Finding ID',
				name: 'findingId',
				type: 'string',
				default: '',
				required: true,
				placeholder: 'vuln_a03114',
				description: 'The finding to read',
				displayOptions: { show: { resource: ['finding'], operation: ['get', 'getEvidenceMeta'] } },
			},

			// ── Retest: Launch ───────────────────────────────────────────
			{
				displayName: 'Retest By',
				name: 'retestBy',
				type: 'options',
				default: 'campaign',
				description: 'Whether to retest the latest campaign on a target, or a specific base campaign',
				displayOptions: { show: { resource: ['retest'], operation: ['launch'] } },
				options: [
					{ name: 'Base Campaign', value: 'campaign' },
					{ name: 'Target', value: 'target' },
				],
			},
			{
				displayName: 'Base Campaign ID',
				name: 'baseCampaignId',
				type: 'string',
				default: '',
				required: true,
				description: 'The base campaign whose findings the retest verifies',
				displayOptions: { show: { resource: ['retest'], operation: ['launch'], retestBy: ['campaign'] } },
			},
			{
				displayName: 'Target ID',
				name: 'retestTargetId',
				type: 'string',
				default: '',
				required: true,
				description: 'The target to retest (uses its latest campaign as the baseline)',
				displayOptions: { show: { resource: ['retest'], operation: ['launch'], retestBy: ['target'] } },
			},
			{
				displayName: 'Retest Options',
				name: 'retestOptions',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				displayOptions: { show: { resource: ['retest'], operation: ['launch'] } },
				options: [
					{
						displayName: 'Finding IDs',
						name: 'findingIds',
						type: 'string',
						default: '',
						description: 'Comma-separated base finding IDs to limit the verdict to',
					},
					{
						displayName: 'Safe Harbor Reference',
						name: 'safeHarbor',
						type: 'string',
						default: '',
					},
				],
			},

			// ── Retest: Get ──────────────────────────────────────────────
			{
				displayName: 'Retest ID',
				name: 'retestId',
				type: 'string',
				default: '',
				required: true,
				description: 'The retest to read (from a Launch output)',
				displayOptions: { show: { resource: ['retest'], operation: ['get'] } },
			},

			// ── Metric: Get Timeseries ───────────────────────────────────
			{
				displayName: 'Options',
				name: 'timeseriesOptions',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				displayOptions: { show: { resource: ['metric'], operation: ['getTimeseries'] } },
				options: [
					{
						displayName: 'From (YYYY-MM-DD)',
						name: 'from',
						type: 'string',
						default: '',
					},
					{
						displayName: 'Group',
						name: 'group',
						type: 'options',
						default: 'day',
						options: [
							{ name: 'By Campaign', value: 'campaign' },
							{ name: 'By Day', value: 'day' },
						],
					},
					{
						displayName: 'Metric',
						name: 'metric',
						type: 'options',
						default: 'severity',
						options: [
							{ name: 'Campaigns', value: 'campaigns' },
							{ name: 'Category', value: 'category' },
							{ name: 'Severity', value: 'severity' },
							{ name: 'Status', value: 'status' },
						],
					},
					{
						displayName: 'Project ID',
						name: 'projectId',
						type: 'string',
						default: '',
					},
					{
						displayName: 'Target ID',
						name: 'targetId',
						type: 'string',
						default: '',
					},
					{
						displayName: 'To (YYYY-MM-DD)',
						name: 'to',
						type: 'string',
						default: '',
					},
				],
			},

			// ── Webhook: Register ────────────────────────────────────────
			{
				displayName: 'Webhook URL',
				name: 'webhookUrl',
				type: 'string',
				default: '',
				required: true,
				placeholder: 'https://n8n.example.com/webhook/darkmoon',
				description: 'HTTPS endpoint Darkmoon posts signed events to',
				displayOptions: { show: { resource: ['webhook'], operation: ['register'] } },
			},
			{
				displayName: 'Event Types',
				name: 'webhookEvents',
				type: 'string',
				default: '',
				placeholder: 'finding.exploited,campaign.completed',
				description: 'Comma-separated event types to receive. Leave empty for all events.',
				displayOptions: { show: { resource: ['webhook'], operation: ['register'] } },
			},

			// ── Webhook: Delete ──────────────────────────────────────────
			{
				displayName: 'Webhook ID',
				name: 'webhookId',
				type: 'string',
				default: '',
				required: true,
				description: 'The webhook registration to delete',
				displayOptions: { show: { resource: ['webhook'], operation: ['delete'] } },
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		const creds = await this.getCredentials('darkmoonApi');
		const node = this.getNode();
		const session = await authorize(this, creds as never);

		const clean = (obj: IDataObject): IDataObject => {
			const out: IDataObject = {};
			for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
			return out;
		};

		for (let i = 0; i < items.length; i++) {
			const resource = this.getNodeParameter('resource', i) as string;
			const operation = this.getNodeParameter('operation', i) as string;
			try {
				let json: Record<string, unknown> = {};

				if (resource === 'campaign' && operation === 'launch') {
					const target = this.getNodeParameter('target', i) as string;
					const wait = this.getNodeParameter('waitForCompletion', i) as boolean;
					const opt = this.getNodeParameter('options', i, {}) as Record<string, unknown>;
					const enableRemediation = this.getNodeParameter('enableRemediation', i, false) as boolean;
					const rem = enableRemediation
						? (this.getNodeParameter('remediation', i, {}) as Record<string, unknown>)
						: {};

					const credentialReference = String(rem.credentialReference || '').trim();
					if (enableRemediation && !credentialReference) {
						throw new NodeOperationError(
							node,
							'Remediation is enabled but no credential reference was provided. Set the opaque Darkmoon vault reference (not a token) so the remediation agent can push a fix pull request.',
							{ itemIndex: i },
						);
					}

					const body = clean({
						target,
						program: (opt.program as string) || undefined,
						targets: csv(opt.targets),
						out_of_scope: csv(opt.outOfScope),
						exclude: csv(opt.exclude),
						focus: csv(opt.focus),
						severity: (opt.severity as string) || undefined,
						safe_harbor: (opt.safeHarbor as string) || undefined,
						remediate: enableRemediation || undefined,
						credential_id: enableRemediation ? credentialReference : undefined,
						git_repo: enableRemediation ? String(rem.repositoryUrl || '').trim() || undefined : undefined,
						create_repo: enableRemediation ? Boolean(rem.createRepository) || undefined : undefined,
					});

					const result = await launchAndCorrelate(this, node, session, body, {
						wait,
						pollMs: Math.max(1, Number(opt.pollSeconds ?? 5)) * 1000,
						timeoutMs: Math.max(1, Number(opt.timeoutMinutes ?? 30)) * 60 * 1000,
					});
					const c = result.campaign as unknown as Record<string, unknown> | null;
					json = {
						status: result.status,
						waited: wait,
						run_id: result.runId,
						campaign_id: c ? c.id : null,
						overall_risk: c ? c.overallRisk ?? null : null,
						stats: c ? c.stats ?? {} : {},
						remediation_enabled: enableRemediation,
					};
				} else if (resource === 'campaign' && operation === 'get') {
					const campaignId = this.getNodeParameter('campaignId', i) as string;
					const body = await dm(this, node, session, 'GET', `/campaigns/${encodeURIComponent(campaignId)}`);
					json = normalizeCampaignSafe(body.data ?? body);
				} else if (resource === 'campaign' && operation === 'list') {
					const f = this.getNodeParameter('campaignFilters', i, {}) as Record<string, unknown>;
					const body = await dm(this, node, session, 'GET', '/campaigns', {
						qs: clean({ target_id: (f.targetId as string) || undefined, status: (f.status as string) || undefined }),
					});
					const rows = Array.isArray(body.data) ? (body.data as unknown[]) : [];
					json = { total: rows.length, campaigns: rows.map(normalizeCampaignSafe) };
				} else if (resource === 'campaign' && operation === 'getSeveritySummary') {
					const campaignId = this.getNodeParameter('campaignId', i) as string;
					const body = await dm(this, node, session, 'GET', `/campaigns/${encodeURIComponent(campaignId)}`);
					const camp = (body.data ?? body) as { stats?: unknown };
					json = { campaign_id: campaignId, ...severitySummaryOf(camp.stats) };
				} else if (resource === 'finding' && operation === 'list') {
					const f = this.getNodeParameter('findingFilters', i, {}) as Record<string, unknown>;
					const body = await dm(this, node, session, 'GET', '/vulnerabilities', {
						qs: clean({
							campaign_id: (f.campaignId as string) || undefined,
							project_id: (f.projectId as string) || undefined,
							target_id: (f.targetId as string) || undefined,
							severity: (f.severity as string) || undefined,
							category: (f.category as string) || undefined,
							status: (f.status as string) || undefined,
						}),
					});
					const rows = Array.isArray(body.data) ? (body.data as unknown[]) : [];
					json = { total: rows.length, findings: rows.map(sanitizeFinding) };
				} else if (resource === 'finding' && operation === 'get') {
					const findingId = this.getNodeParameter('findingId', i) as string;
					const body = await dm(this, node, session, 'GET', `/vulnerabilities/${encodeURIComponent(findingId)}`);
					json = sanitizeFinding(body.data ?? body);
				} else if (resource === 'finding' && operation === 'getEvidenceMeta') {
					const findingId = this.getNodeParameter('findingId', i) as string;
					const d = await dm(this, node, session, 'GET', `/vulnerabilities/${encodeURIComponent(findingId)}/evidence-meta`);
					const counts = (d.counts as IDataObject) || {};
					json = {
						vulnId: (d.vuln_id as string) ?? findingId,
						hasEvidence: Boolean(d.has_evidence),
						counts: {
							commands: Number(counts.commands ?? 0),
							payloads: Number(counts.payloads ?? 0),
							screenshots: Number(counts.screenshots ?? 0),
							logs: Number(counts.logs ?? 0),
							requests: Number(counts.requests ?? 0),
						},
						commandNames: Array.isArray(d.command_names) ? (d.command_names as string[]).map(String) : [],
						hasScreenshot: Boolean(d.has_screenshot),
						hasExtractedData: Boolean(d.has_extracted_data),
						redacted: d.redacted !== false,
					};
				} else if (resource === 'retest' && operation === 'launch') {
					const retestBy = this.getNodeParameter('retestBy', i) as string;
					const ro = this.getNodeParameter('retestOptions', i, {}) as Record<string, unknown>;
					const body = clean({
						finding_ids: csv(ro.findingIds),
						safe_harbor: (ro.safeHarbor as string) || undefined,
						campaign_id: retestBy === 'campaign' ? (this.getNodeParameter('baseCampaignId', i) as string) : undefined,
						target_id: retestBy === 'target' ? (this.getNodeParameter('retestTargetId', i) as string) : undefined,
					});
					const d = await dm(this, node, session, 'POST', '/retest', { body, okStatuses: [200, 201] });
					json = {
						retestId: d.retest_id,
						runId: d.run_id ?? null,
						baseCampaignId: d.base_campaign_id ?? null,
						targetId: d.target_id ?? null,
					};
				} else if (resource === 'retest' && operation === 'get') {
					const retestId = this.getNodeParameter('retestId', i) as string;
					const d = await dm(this, node, session, 'GET', `/retest/${encodeURIComponent(retestId)}`);
					const vs = (d.verdicts_summary as IDataObject) || {};
					json = {
						retestId: d.retest_id,
						baseCampaignId: d.base_campaign_id ?? null,
						newCampaignId: d.new_campaign_id ?? null,
						targetId: d.target_id ?? null,
						status: d.status === 'completed' ? 'completed' : 'running',
						verdictsSummary: {
							fixed: Number(vs.fixed ?? 0),
							still_present: Number(vs.still_present ?? 0),
							regressed: Number(vs.regressed ?? 0),
							new: Number(vs.new ?? 0),
						},
						findings: Array.isArray(d.findings)
							? (d.findings as IDataObject[]).map((v) => ({
									findingId: v.finding_id ?? null,
									newFindingId: v.new_finding_id ?? null,
									baseStatus: v.base_status ?? null,
									newStatus: v.new_status ?? null,
									severity: v.severity ?? null,
									verdict: v.verdict,
								}))
							: [],
					};
				} else if (resource === 'metric' && operation === 'getTimeseries') {
					const o = this.getNodeParameter('timeseriesOptions', i, {}) as Record<string, unknown>;
					const d = await dm(this, node, session, 'GET', '/metrics/timeseries', {
						qs: clean({
							metric: (o.metric as string) || 'severity',
							group: (o.group as string) || 'day',
							project_id: (o.projectId as string) || undefined,
							target_id: (o.targetId as string) || undefined,
							from: (o.from as string) || undefined,
							to: (o.to as string) || undefined,
						}),
						okStatuses: [200],
					});
					json = {
						metric: d.metric ?? 'severity',
						group: d.group ?? 'day',
						series: Array.isArray(d.series) ? d.series : [],
					};
				} else if (resource === 'webhook' && operation === 'register') {
					const url = this.getNodeParameter('webhookUrl', i) as string;
					const body = await dm(this, node, session, 'POST', '/webhooks', {
						body: { url, events: csv(this.getNodeParameter('webhookEvents', i, '')) || [], format: 'darkmoon' },
						okStatuses: [200, 201],
					});
					json = (body.data ?? body) as IDataObject;
				} else if (resource === 'webhook' && operation === 'list') {
					const body = await dm(this, node, session, 'GET', '/webhooks');
					const rows = Array.isArray(body.data) ? (body.data as IDataObject[]) : [];
					json = { total: rows.length, webhooks: rows };
				} else if (resource === 'webhook' && operation === 'delete') {
					const webhookId = this.getNodeParameter('webhookId', i) as string;
					json = { id: webhookId, deleted: await dmDelete(this, node, session, `/webhooks/${encodeURIComponent(webhookId)}`) };
				} else {
					throw new NodeOperationError(node, `Unsupported ${resource}: ${operation}`, {
						itemIndex: i,
					});
				}

				returnData.push({ json: { resource, operation, ...json }, pairedItem: { item: i } });
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({
						json: { resource, operation, error: (error as Error).message },
						pairedItem: { item: i },
					});
					continue;
				}
				throw new NodeApiError(node, error as JsonObject, { itemIndex: i });
			}
		}

		return [returnData];
	}
}
