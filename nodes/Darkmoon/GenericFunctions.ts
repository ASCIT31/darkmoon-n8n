/**
 * Shared helpers for the Darkmoon action + trigger nodes.
 *
 * Design (verified-node compliant):
 *   - TRANSPORT is n8n's own `this.helpers.httpRequest` — the sanctioned way for a
 *     community node to make HTTP calls (no restricted globals, no timers, works
 *     under n8n Cloud restrictions).
 *   - The DATA MODEL is the shared client `@darkmoon_ai/client`: its PURE
 *     normalizers / redaction / verdict helpers are reused verbatim (bundled at
 *     build time as a devDependency, tree-shaken to the side-effect-free
 *     functions only). This keeps the node on the single shared contract — no
 *     bespoke parsing/normalization that could drift — while staying dependency
 *     free at runtime.
 *
 * Redaction posture: evidence is never emitted (findings are sanitized: `raw`
 * dropped, `evidence` nulled, then scrubbed); secrets are never logged; SCM
 * credentials travel only as opaque vault references.
 */
import {
	normalizeCampaign,
	normalizeFinding,
	normalizeCampaignStatus,
	severitySummaryFromStats,
	severitySummaryFromFindings,
	scrubDeep,
	scrubSecrets,
} from '@darkmoon_ai/client';
import type { Campaign, Finding, SeveritySummary } from '@darkmoon_ai/client';
import { sleep, NodeApiError } from 'n8n-workflow';
import type {
	IDataObject,
	IExecuteFunctions,
	IHookFunctions,
	IHttpRequestMethods,
	INode,
	IPollFunctions,
	IWebhookFunctions,
} from 'n8n-workflow';

/** Any n8n context that can make HTTP requests. */
export type RequestContext =
	| IExecuteFunctions
	| IPollFunctions
	| IHookFunctions
	| IWebhookFunctions;

export interface DarkmoonCreds {
	baseUrl: string;
	authMethod?: 'token' | 'password';
	token?: string;
	username?: string;
	password?: string;
}

export interface DmSession {
	apiBase: string;
	token: string;
}

interface DmResponse {
	status: number;
	body: IDataObject;
}

const TERMINAL_STATUSES = new Set(['completed', 'stopped', 'failed']);

/** Build the `/api/v1` base from a credential base URL (with or without the suffix). */
function apiBaseOf(baseUrl: string): string {
	const base = String(baseUrl || '').trim().replace(/\/+$/, '');
	if (!base) throw new Error('Darkmoon credential is missing the Base URL.');
	return /\/api\/v1$/.test(base) ? base : `${base}/api/v1`;
}

async function rawRequest(
	ctx: RequestContext,
	apiBase: string,
	token: string,
	method: IHttpRequestMethods,
	path: string,
	opts: { qs?: IDataObject; body?: IDataObject } = {},
): Promise<DmResponse> {
	const headers: IDataObject = { Accept: 'application/json' };
	if (token) headers.Authorization = `Bearer ${token}`;
	if (opts.body) headers['Content-Type'] = 'application/json';
	const response = (await ctx.helpers.httpRequest({
		method,
		url: `${apiBase}${path}`,
		headers,
		qs: opts.qs,
		body: opts.body,
		json: true,
		returnFullResponse: true,
		ignoreHttpStatusErrors: true,
	})) as { statusCode: number; body: IDataObject };
	return { status: response.statusCode, body: (response.body || {}) as IDataObject };
}

/** Resolve a bearer token (token auth) or log in (password auth). Never logs secrets. */
export async function authorize(ctx: RequestContext, creds: DarkmoonCreds): Promise<DmSession> {
	const apiBase = apiBaseOf(creds.baseUrl);
	const method = creds.authMethod || (creds.token ? 'token' : 'password');
	if (method === 'token') {
		const token = String(creds.token || '').trim();
		if (!token) throw new Error('Darkmoon credential is set to token auth but no API token was provided.');
		return { apiBase, token };
	}
	const res = await rawRequest(ctx, apiBase, '', 'POST', '/auth/login', {
		body: { username: String(creds.username || ''), password: String(creds.password || '') },
	});
	const token = res.status === 200 ? String((res.body as { token?: string }).token || '') : '';
	if (!token) throw new Error('Darkmoon login failed. Check the base URL and credentials.');
	return { apiBase, token };
}

/** Extract the API's own error `detail`, else a fallback. */
function detailOf(body: IDataObject, fallback: string): string {
	const d = (body?.detail ?? body?.message) as unknown;
	return typeof d === 'string' && d.length ? d : fallback;
}

/** Perform a request, throwing a NodeApiError with the API's detail on failure. */
export async function dm(
	ctx: RequestContext,
	node: INode,
	session: DmSession,
	method: IHttpRequestMethods,
	path: string,
	opts: { qs?: IDataObject; body?: IDataObject; okStatuses?: number[] } = {},
): Promise<IDataObject> {
	const res = await rawRequest(ctx, session.apiBase, session.token, method, path, opts);
	const ok = opts.okStatuses ?? [200, 201, 204];
	if (!ok.includes(res.status)) {
		throw new NodeApiError(
			node,
			{ message: detailOf(res.body, `Darkmoon API returned HTTP ${res.status}`) } as never,
			{ httpCode: String(res.status) },
		);
	}
	return res.body;
}

/** DELETE that treats 404 as "already gone". Returns true if something was removed. */
export async function dmDelete(
	ctx: RequestContext,
	node: INode,
	session: DmSession,
	path: string,
): Promise<boolean> {
	const res = await rawRequest(ctx, session.apiBase, session.token, 'DELETE', path, {});
	if (res.status >= 500) {
		throw new NodeApiError(node, { message: `Darkmoon API returned HTTP ${res.status}` } as never);
	}
	return res.status !== 404;
}

// ── Reused client normalizers + node-side redaction ────────────────────────

/** Sanitize a raw finding: normalize via the shared client, drop `raw`, null evidence, scrub. */
export function sanitizeFinding(rawFinding: unknown): Record<string, unknown> {
	const norm = normalizeFinding(rawFinding as never, 'pro', { includeEvidence: false }) as unknown as Record<string, unknown>;
	const rec = { ...norm };
	delete rec.raw;
	rec.evidence = null;
	return scrubDeep(rec as never) as Record<string, unknown>;
}

/** Normalize a raw campaign via the shared client and drop the internal `raw` mirror. */
export function normalizeCampaignSafe(rawCampaign: unknown): Record<string, unknown> {
	const rec = { ...(normalizeCampaign(rawCampaign as never, 'pro') as unknown as Record<string, unknown>) };
	delete rec.raw;
	return rec;
}

export function severitySummaryOf(stats: unknown, findings?: unknown[]): SeveritySummary {
	if (stats && typeof stats === 'object' && Object.keys(stats as object).length) {
		return severitySummaryFromStats(stats as never);
	}
	return severitySummaryFromFindings((findings || []).map((f) => normalizeFinding(f as never, 'pro')) as Finding[]);
}

export { normalizeCampaignStatus };

// ── Campaign correlation + completion polling (n8n `sleep` only, no timers) ──

/** List raw campaigns (unnormalized) for correlation/diffing. */
export async function listRawCampaigns(ctx: RequestContext, node: INode, s: DmSession): Promise<IDataObject[]> {
	const body = await dm(ctx, node, s, 'GET', '/campaigns');
	return Array.isArray(body.data) ? (body.data as IDataObject[]) : [];
}

/**
 * Launch a campaign and correlate the resulting campaign id by diffing the
 * campaign set captured before the run against the set after it appears.
 */
export async function launchAndCorrelate(
	ctx: RequestContext,
	node: INode,
	s: DmSession,
	body: IDataObject,
	opts: { pollMs: number; timeoutMs: number; wait: boolean },
): Promise<{ runId: string | null; campaign: Campaign | null; status: string }> {
	const before = new Set((await listRawCampaigns(ctx, node, s)).map((c) => String(c.id)));
	const launch = await dm(ctx, node, s, 'POST', '/run/campaign', { body });
	const runId = (launch.run_id as string) ?? null;
	if (!opts.wait) return { runId, campaign: null, status: 'started' };

	const start = Date.now();
	let rawCampaign: IDataObject | null = null;
	while (Date.now() - start < opts.timeoutMs) {
		const now = await listRawCampaigns(ctx, node, s);
		const fresh = now.filter((c) => !before.has(String(c.id)));
		const candidate = fresh[0] ?? now[0] ?? null;
		if (candidate) {
			rawCampaign = candidate;
			const status = normalizeCampaignStatus(String(candidate.status ?? ''));
			if (TERMINAL_STATUSES.has(status)) {
				return { runId, campaign: normalizeCampaign(candidate as never, 'pro'), status };
			}
		}
		await sleep(opts.pollMs);
	}
	return {
		runId,
		campaign: rawCampaign ? normalizeCampaign(rawCampaign as never, 'pro') : null,
		status: rawCampaign ? normalizeCampaignStatus(String(rawCampaign.status ?? '')) : 'timeout',
	};
}

// ── Misc ────────────────────────────────────────────────────────────────────

/** Split a comma-separated string into a trimmed, non-empty array (or undefined). */
export function csv(value: unknown): string[] | undefined {
	const s = String(value ?? '').trim();
	if (!s) return undefined;
	const parts = s.split(',').map((x) => x.trim()).filter(Boolean);
	return parts.length ? parts : undefined;
}

/** Scrub any object before it ever reaches a log line. */
export function safeForLog(value: unknown): unknown {
	try {
		return scrubSecrets(value as never);
	} catch {
		return '[unloggable]';
	}
}
