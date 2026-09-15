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
						name: 'Run Pentest',
						value: 'runPentest',
						description: 'Start a pentest against a target and (optionally) wait for findings',
						action: 'Run a pentest',
					},
					{
						name: 'Get Findings',
						value: 'getFindings',
						description: 'Fetch the vulnerabilities of a campaign',
						action: 'Get findings for a campaign',
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
					});

					if (!wait) {
						returnData.push({
							json: { operation, ...handle, status: 'started', waited: false },
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
							waited: true,
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
