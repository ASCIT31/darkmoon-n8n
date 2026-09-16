import type {
	IExecuteFunctions,
	IHttpRequestMethods,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	NodeConnectionType,
} from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

import { DarkmoonClient, type HttpFn } from './DarkmoonClient';

export class Darkmoon implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Darkmoon',
		name: 'darkmoon',
		icon: 'file:darkmoon.svg',
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"]}}',
		description: 'Trigger a Darkmoon AI pentest and retrieve its findings',
		defaults: {
			name: 'Darkmoon',
		},
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
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				default: 'runPentest',
				options: [
					{
						name: 'Get Findings',
						value: 'getFindings',
						description: 'Fetch the vulnerabilities of a campaign',
						action: 'Get findings for a campaign',
					},
					{
						name: 'Get Pull Request',
						value: 'getPullRequest',
						description: 'Fetch one pull request record (diff summary, validation, linked findings)',
						action: 'Get a pull request',
					},
					{
						name: 'Get Pull Requests by Finding',
						value: 'getPullRequestsByFinding',
						description: 'Fetch the pull requests that address a specific finding',
						action: 'Get pull requests for a finding',
					},
					{
						name: 'Get Report',
						value: 'getReport',
						description: 'Fetch the markdown report of a campaign',
						action: 'Get the report for a campaign',
					},
					{
						name: 'List Campaigns',
						value: 'listCampaigns',
						description: 'List past and running campaigns',
						action: 'List campaigns',
					},
					{
						name: 'List Pull Requests',
						value: 'listPullRequests',
						description:
							'List the fix pull requests Darkmoon prepared. Optionally narrow to one campaign, or to given states/provider/repository.',
						action: 'List pull requests',
					},
					{
						name: 'Run Pentest',
						value: 'runPentest',
						description: 'Start a pentest against a target and (optionally) wait for findings',
						action: 'Run a pentest',
					},
				],
			},

			// ── Run Pentest ─────────────────────────────────────────────
			{
				displayName: 'Target',
				name: 'target',
				type: 'string',
				default: '',
				required: true,
				placeholder: 'http://juice-shop.lab:3000 or 10.0.0.5',
				description:
					'Primary target URL or host. Only test systems you are explicitly authorised to assess.',
				displayOptions: { show: { operation: ['runPentest'] } },
			},
			{
				displayName: 'Wait for Completion',
				name: 'waitForCompletion',
				type: 'boolean',
				default: true,
				description:
					'Whether to poll until the run finishes and return the findings. If off, returns the run_id immediately.',
				displayOptions: { show: { operation: ['runPentest'] } },
			},
			{
				displayName: 'Enable Remediation',
				name: 'enableRemediation',
				type: 'boolean',
				default: false,
				description:
					'Whether Darkmoon should also try to fix the issues it confirms and open a pull request with the fix for a human to review. It never merges anything. Leave off to only find issues. Requires a credential reference below.',
				displayOptions: { show: { operation: ['runPentest'] } },
			},
			{
				displayName: 'Remediation Settings',
				name: 'remediation',
				type: 'collection',
				placeholder: 'Add Setting',
				default: {},
				displayOptions: { show: { operation: ['runPentest'], enableRemediation: [true] } },
				options: [
					{
						displayName: 'Allow Darkmoon to Create the Repository',
						name: 'createRepository',
						type: 'boolean',
						default: false,
						description:
							'Whether to authorise Darkmoon to create the repository if it does not exist yet',
					},
					{
						displayName: 'Credential Reference',
						name: 'credentialReference',
						type: 'string',
						default: '',
						description: 'Opaque ID of a source-control credential already stored in Darkmoon\'s vault (create it in the Darkmoon dashboard, or via GET /api/v1/credentials). This is a reference, NOT a token — no secret is sent through the workflow.',
					},
					{
						displayName: 'Pull Request Wait Timeout (Minutes)',
						name: 'prTimeoutMinutes',
						type: 'number',
						default: 5,
						description: 'Stop waiting for pull requests after this many minutes',
					},
					{
						displayName: 'Repository URL',
						name: 'repositoryUrl',
						type: 'string',
						default: '',
						placeholder: 'https://github.com/acme/shop',
						description: 'Source repository the target was built from, where the fix PR is opened',
					},
					{
						displayName: 'Wait for Pull Requests',
						name: 'waitForPullRequests',
						type: 'boolean',
						default: true,
						description:
							'Whether to keep checking after the pentest until at least one pull request appears, then return them. Remediation runs during the pentest, so PRs are usually ready immediately.',
					},
				],
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				displayOptions: { show: { operation: ['runPentest'] } },
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
						name: 'out_of_scope',
						type: 'string',
						default: '',
						description: 'Comma-separated hosts/paths that must not be touched',
					},
					{
						displayName: 'Poll Interval (Seconds)',
						name: 'pollSeconds',
						type: 'number',
						default: 5,
						description: 'How often to poll the run log while waiting',
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
						name: 'safe_harbor',
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

			// ── Campaign id (getFindings / getReport) ───────────────────
			{
				displayName: 'Campaign ID',
				name: 'campaignId',
				type: 'string',
				default: '',
				required: true,
				description: 'The campaign to read (from Run Pentest output or List Campaigns)',
				displayOptions: { show: { operation: ['getFindings', 'getReport'] } },
			},

			// ── Pull request parameters ─────────────────────────────────
			{
				displayName: 'Campaign ID',
				name: 'prCampaignId',
				type: 'string',
				default: '',
				description:
					'Optional. Restrict to one campaign (the only filter the API applies server-side). Leave empty to list pull requests across all campaigns.',
				displayOptions: { show: { operation: ['listPullRequests'] } },
			},
			{
				displayName: 'Filters',
				name: 'prFilters',
				type: 'collection',
				placeholder: 'Add Filter',
				default: {},
				description: 'Applied client-side to the returned records (the API does not filter by these)',
				displayOptions: { show: { operation: ['listPullRequests'] } },
				options: [
					{
						displayName: 'Provider',
						name: 'provider',
						type: 'string',
						default: '',
						placeholder: 'github',
						description: 'Keep only pull requests from this SCM provider',
					},
					{
						displayName: 'Repository',
						name: 'repository',
						type: 'string',
						default: '',
						description: 'Keep only pull requests whose repository contains this text',
					},
					{
						displayName: 'State',
						name: 'state',
						type: 'multiOptions',
						default: [],
						description: 'Keep only pull requests in these states',
						options: [
							{ name: 'Closed', value: 'closed' },
							{ name: 'Draft', value: 'draft' },
							{ name: 'Error', value: 'error' },
							{ name: 'Merged', value: 'merged' },
							{ name: 'Open', value: 'open' },
							{ name: 'Proposed', value: 'proposed' },
						],
					},
				],
			},
			{
				displayName: 'Pull Request ID',
				name: 'prId',
				type: 'string',
				default: '',
				required: true,
				placeholder: 'pr_1a2b3c4d5e6f',
				description: 'The pull request to fetch',
				displayOptions: { show: { operation: ['getPullRequest'] } },
			},
			{
				displayName: 'Finding ID',
				name: 'findingId',
				type: 'string',
				default: '',
				required: true,
				placeholder: 'vuln_a03114',
				description: 'The finding whose pull requests you want',
				displayOptions: { show: { operation: ['getPullRequestsByFinding'] } },
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		const creds = await this.getCredentials('darkmoonApi');
		const baseUrl = String(creds.baseUrl || '').trim();

		// Adapt n8n's httpRequest into the client's transport contract:
		// never throw on HTTP status — return { statusCode, body } so the client
		// surfaces the API's own error `detail`.
		const http: HttpFn = async (opts) => {
			const response = (await this.helpers.httpRequest({
				method: opts.method as IHttpRequestMethods,
				url: opts.url,
				headers: opts.headers,
				body: opts.body as object | undefined,
				json: true,
				returnFullResponse: true,
				ignoreHttpStatusErrors: true,
			})) as { statusCode: number; body: unknown };
			return { statusCode: response.statusCode, body: response.body };
		};

		const client = new DarkmoonClient(baseUrl, http);
		await client.login(String(creds.username), String(creds.password));

		const csv = (v: unknown): string[] | undefined => {
			const s = String(v ?? '').trim();
			if (!s) return undefined;
			return s.split(',').map((x) => x.trim()).filter(Boolean);
		};

		for (let i = 0; i < items.length; i++) {
			const operation = this.getNodeParameter('operation', i) as string;
			try {
				if (operation === 'runPentest') {
					const target = this.getNodeParameter('target', i) as string;
					const wait = this.getNodeParameter('waitForCompletion', i) as boolean;
					const opt = this.getNodeParameter('options', i, {}) as Record<string, any>;
					const enableRemediation = this.getNodeParameter('enableRemediation', i, false) as boolean;
					const rem = enableRemediation
						? (this.getNodeParameter('remediation', i, {}) as Record<string, any>)
						: {};

					const credentialReference = String(rem.credentialReference || '').trim();
					// Fail fast if remediation is on but no credential reference is set.
					try {
						DarkmoonClient.validateRemediation({
							remediate: enableRemediation,
							credential_id: credentialReference,
						});
					} catch (e) {
						throw new NodeOperationError(this.getNode(), (e as Error).message, { itemIndex: i });
					}

					const beforeIds = new Set((await client.listCampaigns()).map((c) => c.id));

					const handle = await client.runCampaign({
						target,
						program: opt.program || undefined,
						targets: csv(opt.targets),
						out_of_scope: csv(opt.out_of_scope),
						exclude: csv(opt.exclude),
						focus: csv(opt.focus),
						severity: opt.severity || undefined,
						safe_harbor: opt.safe_harbor || undefined,
						// Remediation — opaque credential reference only, never a token.
						remediate: enableRemediation || undefined,
						credential_id: enableRemediation ? credentialReference : undefined,
						git_repo: enableRemediation ? String(rem.repositoryUrl || '').trim() || undefined : undefined,
						create_repo: enableRemediation ? Boolean(rem.createRepository) || undefined : undefined,
					});

					if (!wait) {
						returnData.push({
							json: {
								operation,
								...handle,
								status: 'started',
								waited: false,
								remediation_enabled: enableRemediation,
							},
							pairedItem: { item: i },
						});
						continue;
					}

					const { terminal, timedOut } = await client.waitForRun(handle.run_id, {
						pollMs: Math.max(1, Number(opt.pollSeconds ?? 5)) * 1000,
						timeoutMs: Math.max(1, Number(opt.timeoutMinutes ?? 30)) * 60 * 1000,
					});

					const campaign = await client.resolveRunCampaign(beforeIds, target);
					let findings: any = { data: [], total: 0, stats: {} };
					if (campaign) findings = await client.getFindings(campaign.id);

					// Pull requests: remediation runs during the pentest, so PRs are
					// usually present as soon as the run completes. We fetch them (and
					// optionally poll briefly) but NEVER merge or modify them.
					let pullRequests: any[] = [];
					let prTimedOut = false;
					if (enableRemediation && campaign) {
						const waitPr = rem.waitForPullRequests !== false;
						if (waitPr) {
							const res = await client.waitForPullRequests(campaign.id, {
								minCount: 1,
								pollMs: 5000,
								timeoutMs: Math.max(1, Number(rem.prTimeoutMinutes ?? 5)) * 60 * 1000,
							});
							pullRequests = res.pullRequests;
							prTimedOut = res.timedOut;
						} else {
							pullRequests = await client.listPullRequests(campaign.id);
						}
					}

					returnData.push({
						json: {
							operation,
							run_id: handle.run_id,
							command: handle.command,
							status: timedOut ? 'timeout' : terminal?.type || 'unknown',
							exit_code: terminal?.exit_code,
							campaign_id: campaign?.id ?? null,
							overall_risk: campaign?.overall_risk ?? null,
							total_findings: findings.total,
							stats: findings.stats,
							findings: findings.data,
							remediation_enabled: enableRemediation,
							pull_requests_timed_out: enableRemediation ? prTimedOut : undefined,
							total_pull_requests: enableRemediation ? pullRequests.length : undefined,
							pull_requests: enableRemediation ? pullRequests : undefined,
							waited: true,
						},
						pairedItem: { item: i },
					});
				} else if (operation === 'listPullRequests') {
					const prCampaignId = String(this.getNodeParameter('prCampaignId', i, '') as string).trim();
					const prFilters = this.getNodeParameter('prFilters', i, {}) as Record<string, any>;
					const all = await client.listPullRequests(prCampaignId || undefined);
					const filtered = DarkmoonClient.filterPullRequests(all, {
						state: Array.isArray(prFilters.state) ? prFilters.state : undefined,
						provider: prFilters.provider || undefined,
						repository: prFilters.repository || undefined,
					});
					returnData.push({
						json: {
							operation,
							campaign_id: prCampaignId || null,
							total: filtered.length,
							pull_requests: filtered,
						},
						pairedItem: { item: i },
					});
				} else if (operation === 'getPullRequest') {
					const prId = this.getNodeParameter('prId', i) as string;
					const pr = await client.getPullRequest(prId);
					returnData.push({
						json: { operation, ...pr },
						pairedItem: { item: i },
					});
				} else if (operation === 'getPullRequestsByFinding') {
					const findingId = this.getNodeParameter('findingId', i) as string;
					const prs = await client.getPullRequestsForFinding(findingId);
					returnData.push({
						json: {
							operation,
							finding_id: findingId,
							total: prs.length,
							pull_requests: prs,
						},
						pairedItem: { item: i },
					});
				} else if (operation === 'getFindings') {
					const campaignId = this.getNodeParameter('campaignId', i) as string;
					const findings = await client.getFindings(campaignId);
					returnData.push({
						json: { operation, campaign_id: campaignId, ...findings },
						pairedItem: { item: i },
					});
				} else if (operation === 'getReport') {
					const campaignId = this.getNodeParameter('campaignId', i) as string;
					const report = await client.getReport(campaignId);
					returnData.push({
						json: { operation, campaign_id: campaignId, ...report },
						pairedItem: { item: i },
					});
				} else if (operation === 'listCampaigns') {
					const campaigns = await client.listCampaigns();
					returnData.push({
						json: { operation, total: campaigns.length, campaigns },
						pairedItem: { item: i },
					});
				} else {
					throw new NodeOperationError(this.getNode(), `Unknown operation: ${operation}`);
				}
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({
						json: { error: (error as Error).message },
						pairedItem: { item: i },
					});
					continue;
				}
				throw error;
			}
		}

		return [returnData];
	}
}
