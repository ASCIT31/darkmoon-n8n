import { createHmac, timingSafeEqual } from 'node:crypto';
import type {
	IDataObject,
	IHookFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	IPollFunctions,
	IWebhookFunctions,
	IWebhookResponseData,
	NodeConnectionType,
} from 'n8n-workflow';

import { authorize, dm, dmDelete, normalizeCampaignStatus } from '../Darkmoon/GenericFunctions';

/**
 * Darkmoon Trigger.
 *
 * Fires an n8n workflow on Darkmoon events (campaign.* / finding.* / pr.*).
 *
 * Two modes:
 *   - Poll (default, recommended): a polling trigger that reproduces the
 *     `streamEvents` taxonomy with a cloud-safe synthetic poll-and-diff. Each
 *     poll reads campaigns / findings / pull-requests, diffs them against a
 *     durable cursor kept in the workflow static data, and emits the resulting
 *     events. Works behind NAT and uses only n8n's own HTTP helper (no timers,
 *     no restricted globals).
 *   - Webhook: registers a Darkmoon Pro webhook that POSTs signed events to this
 *     node; the HMAC `X-Darkmoon-Signature` is verified.
 *
 * Events carry SAFE FIELDS ONLY (ids, severity, status, counts, timestamps).
 */

const EVENT_OPTIONS = [
	{ name: 'Campaign — Aborted', value: 'campaign.aborted' },
	{ name: 'Campaign — Completed', value: 'campaign.completed' },
	{ name: 'Campaign — Started', value: 'campaign.started' },
	{ name: 'Campaign — Stopped', value: 'campaign.stopped' },
	{ name: 'Finding — Confirmed', value: 'finding.confirmed' },
	{ name: 'Finding — Discovered', value: 'finding.discovered' },
	{ name: 'Finding — Exploited', value: 'finding.exploited' },
	{ name: 'Finding — Remediated', value: 'finding.remediated' },
	{ name: 'PR — Opened', value: 'pr.opened' },
	{ name: 'PR — Updated', value: 'pr.updated' },
];

const asArray = (v: unknown): IDataObject[] => (Array.isArray(v) ? (v as IDataObject[]) : []);

export class DarkmoonTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Darkmoon Trigger',
		name: 'darkmoonTrigger',
		icon: { light: 'file:darkmoon.svg', dark: 'file:darkmoon.svg' },
		group: ['trigger'],
		version: 1,
		subtitle: '={{$parameter["mode"]}}',
		description: 'Starts a workflow when Darkmoon emits campaign, finding or PR events',
		defaults: {
			name: 'Darkmoon Trigger',
		},
		polling: true,
		inputs: [],
		outputs: ['main'] as NodeConnectionType[],
		credentials: [
			{
				name: 'darkmoonApi',
				required: true,
			},
		],
		webhooks: [
			{
				name: 'default',
				httpMethod: 'POST',
				responseMode: 'onReceived',
				path: 'darkmoon',
			},
		],
		properties: [
			{
				displayName: 'Mode',
				name: 'mode',
				type: 'options',
				default: 'poll',
				description: 'How this trigger receives events',
				options: [
					{
						name: 'Poll (Recommended)',
						value: 'poll',
						description: 'Poll the Darkmoon API on a schedule and diff for new events. Works behind NAT.',
					},
					{
						name: 'Webhook',
						value: 'webhook',
						description: 'Register a Darkmoon Pro webhook that posts signed events to this node',
					},
				],
			},
			{
				displayName: 'Events',
				name: 'events',
				type: 'multiOptions',
				default: [],
				description: 'Event types to react to. Leave empty for all events.',
				options: EVENT_OPTIONS,
			},
		],
	};

	webhookMethods = {
		default: {
			async checkExists(this: IHookFunctions): Promise<boolean> {
				if ((this.getNodeParameter('mode', 'poll') as string) !== 'webhook') return true;
				const staticData = this.getWorkflowStaticData('node');
				const webhookId = staticData.webhookId as string | undefined;
				if (!webhookId) return false;
				const session = await authorize(this, (await this.getCredentials('darkmoonApi')) as never);
				const body = await dm(this, this.getNode(), session, 'GET', '/webhooks');
				return asArray(body.data).some((h) => String(h.id) === webhookId);
			},
			async create(this: IHookFunctions): Promise<boolean> {
				if ((this.getNodeParameter('mode', 'poll') as string) !== 'webhook') return true;
				const session = await authorize(this, (await this.getCredentials('darkmoonApi')) as never);
				const url = this.getNodeWebhookUrl('default') as string;
				const events = this.getNodeParameter('events', []) as string[];
				const body = await dm(this, this.getNode(), session, 'POST', '/webhooks', {
					body: { url, events, format: 'darkmoon' },
					okStatuses: [200, 201],
				});
				const reg = (body.data ?? body) as IDataObject;
				const staticData = this.getWorkflowStaticData('node');
				staticData.webhookId = String(reg.id);
				// The signing secret is returned unmasked ONLY on create; store it now.
				if (typeof reg.secret === 'string') staticData.webhookSecret = reg.secret;
				return true;
			},
			async delete(this: IHookFunctions): Promise<boolean> {
				const staticData = this.getWorkflowStaticData('node');
				const webhookId = staticData.webhookId as string | undefined;
				if (!webhookId) return true;
				try {
					const session = await authorize(this, (await this.getCredentials('darkmoonApi')) as never);
					await dmDelete(this, this.getNode(), session, `/webhooks/${encodeURIComponent(webhookId)}`);
				} catch (error) {
					// The workflow is being deactivated; surface the failure without aborting.
					this.logger.warn(`Darkmoon: could not delete webhook ${webhookId}: ${(error as Error).message}`);
				}
				delete staticData.webhookId;
				delete staticData.webhookSecret;
				return true;
			},
		},
	};

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		const req = this.getRequestObject();
		const staticData = this.getWorkflowStaticData('node');
		const secret = staticData.webhookSecret as string | undefined;
		const body = (req.body ?? {}) as IDataObject;

		if (secret) {
			const header = String(this.getHeaderData()['x-darkmoon-signature'] ?? '').replace(/^sha256=/, '');
			const raw = (req as unknown as { rawBody?: Buffer }).rawBody;
			const payload = raw ? raw.toString('utf8') : JSON.stringify(body);
			const expected = createHmac('sha256', secret).update(payload).digest('hex');
			const ok =
				header.length === expected.length &&
				timingSafeEqual(Buffer.from(header), Buffer.from(expected));
			if (!ok) {
				return { webhookResponse: { status: 401, body: 'invalid signature' } as never };
			}
		}

		const selected = this.getNodeParameter('events', []) as string[];
		const eventType = String(body.event ?? '');
		if (selected.length && eventType && !selected.includes(eventType)) {
			return { noWebhookResponse: true };
		}
		return { workflowData: [[{ json: body }]] };
	}

	async poll(this: IPollFunctions): Promise<INodeExecutionData[][] | null> {
		if ((this.getNodeParameter('mode', 'poll') as string) !== 'poll') return null;

		const node = this.getNode();
		const session = await authorize(this, (await this.getCredentials('darkmoonApi')) as never);
		const selected = this.getNodeParameter('events', []) as string[];
		const staticData = this.getWorkflowStaticData('node');
		const seen = (staticData.seen ??= { f: {}, c: {}, p: {} }) as {
			f: Record<string, string>;
			c: Record<string, string>;
			p: Record<string, string>;
		};
		const firstRun = !staticData.primed;
		const isManual = this.getMode() === 'manual';

		const events: IDataObject[] = [];
		const want = (e: string) => !selected.length || selected.includes(e);
		const emit = (event: string, data: IDataObject) => {
			if (want(event)) events.push({ event, data, ts: new Date().toISOString() });
		};

		// Findings → finding.discovered / .confirmed / .exploited / .remediated
		const findings = asArray((await dm(this, node, session, 'GET', '/vulnerabilities')).data);
		for (const f of findings) {
			const id = String(f.id);
			const status = String(f.status ?? 'unconfirmed').toLowerCase();
			const data: IDataObject = {
				finding_id: id,
				severity: f.severity ?? null,
				status,
				category: f.category ?? null,
				endpoint: f.endpoint ?? null,
				campaign_id: f.campaign_id ?? null,
			};
			const prev = seen.f[id];
			if (prev === undefined) emit('finding.discovered', data);
			if (prev !== status) {
				if (status === 'exploited') emit('finding.exploited', data);
				else if (status === 'confirmed') emit('finding.confirmed', data);
				else if (status === 'remediated') emit('finding.remediated', data);
			}
			seen.f[id] = status;
		}

		// Campaigns → campaign.started / .completed / .stopped / .aborted
		const campaigns = asArray((await dm(this, node, session, 'GET', '/campaigns')).data);
		for (const c of campaigns) {
			const id = String(c.id);
			const status = normalizeCampaignStatus(String(c.status ?? ''));
			const prev = seen.c[id];
			if (prev !== status) {
				const map: Record<string, string> = {
					completed: 'campaign.completed',
					stopped: 'campaign.stopped',
					failed: 'campaign.aborted',
					running: 'campaign.started',
				};
				const ev = map[status];
				if (ev) emit(ev, { campaign_id: id, status, overall_risk: c.overall_risk ?? null, stats: c.stats ?? {} });
			}
			seen.c[id] = status;
		}

		// Pull-requests → pr.opened / pr.updated (best effort; 404 when unavailable)
		const prBody = await dm(this, node, session, 'GET', '/pull-requests', { okStatuses: [200, 404] });
		for (const p of asArray(prBody.data)) {
			const id = String(p.id);
			const state = String(p.state ?? 'proposed').toLowerCase();
			const data: IDataObject = { pr_id: id, state, campaign_id: p.campaign_id ?? null, provider: p.provider ?? null };
			const prev = seen.p[id];
			if (prev === undefined) emit('pr.opened', data);
			else if (prev !== state) emit('pr.updated', data);
			seen.p[id] = state;
		}

		staticData.primed = true;

		// First activation only primes the cursor (no historical replay storm),
		// unless the user is manually testing and wants to see a sample.
		if (firstRun && !isManual) return null;
		if (!events.length) return null;
		return [events.map((e) => ({ json: e }))];
	}
}
