/**
 * DarkmoonClient — dependency-free client for the Darkmoon Dashboard API.
 *
 * This module deliberately has NO n8n or third-party imports. It receives an
 * injected HTTP function so it can run both inside an n8n node (wrapping
 * `this.helpers.httpRequest`) and in a plain test harness (wrapping `fetch`).
 * This keeps the community-node package free of runtime dependencies and lets
 * the integration logic be tested end-to-end against a live API.
 *
 * The Darkmoon Dashboard API is a versioned FastAPI service. The endpoints used
 * here are read directly from Dark-Moon-Front-API (branch dev):
 *   POST   /api/v1/auth/login                  -> { token, ... }
 *   POST   /api/v1/run/campaign                -> { run_id, pid, command }
 *   GET    /api/v1/run/logs/{run_id}           -> { data: events[], total }
 *   DELETE /api/v1/run/{run_id}/stop           -> { message, run_id }
 *   GET    /api/v1/campaigns                   -> { data: campaigns[], total }
 *   GET    /api/v1/vulnerabilities?campaign_id -> { data, total, stats }
 *   GET    /api/v1/campaigns/{id}/report       -> { content, format }
 */

export interface HttpResponse {
	statusCode: number;
	body: any;
}

/**
 * Injected transport. Must resolve with the raw HTTP status and the parsed
 * JSON body (never throw on non-2xx — the client inspects statusCode itself so
 * error messages carry the API's own `detail`).
 */
export type HttpFn = (opts: {
	method: string;
	url: string;
	headers?: Record<string, string>;
	body?: unknown;
}) => Promise<HttpResponse>;

export interface RunPentestParams {
	target: string;
	program?: string;
	targets?: string[];
	out_of_scope?: string[];
	exclude?: string[];
	focus?: string[];
	severity?: string;
	format?: string;
	safe_harbor?: string;
}

export interface RunHandle {
	run_id: string;
	pid: number | null;
	command: string;
}

export interface RunEvent {
	type?: string;
	[k: string]: any;
}

export interface Campaign {
	id: string;
	target_id?: string;
	project_id?: string;
	session_id?: string;
	status?: string;
	date?: string;
	stats?: Record<string, any>;
	overall_risk?: string;
	[k: string]: any;
}

export interface Finding {
	id: string;
	title?: string;
	severity?: string;
	status?: string;
	category?: string;
	cvss_score?: number;
	[k: string]: any;
}

const TERMINAL_TYPES = new Set(['run_completed', 'run_error']);

export class DarkmoonError extends Error {
	statusCode?: number;
	constructor(message: string, statusCode?: number) {
		super(message);
		this.name = 'DarkmoonError';
		this.statusCode = statusCode;
	}
}

export class DarkmoonClient {
	private baseUrl: string;
	private http: HttpFn;
	private token: string | null = null;

	constructor(baseUrl: string, http: HttpFn) {
		// Normalise: strip a single trailing slash so path joins stay clean.
		this.baseUrl = baseUrl.replace(/\/+$/, '');
		this.http = http;
	}

	private url(path: string): string {
		return `${this.baseUrl}${path}`;
	}

	private authHeaders(): Record<string, string> {
		const h: Record<string, string> = { 'Content-Type': 'application/json' };
		if (this.token) h.Authorization = `Bearer ${this.token}`;
		return h;
	}

	private detail(res: HttpResponse, fallback: string): string {
		const d = res && res.body && (res.body.detail ?? res.body.message);
		return typeof d === 'string' && d.length ? d : fallback;
	}

	/** Authenticate and cache the JWT for subsequent calls. */
	async login(username: string, password: string): Promise<string> {
		const res = await this.http({
			method: 'POST',
			url: this.url('/api/v1/auth/login'),
			headers: { 'Content-Type': 'application/json' },
			body: { username, password },
		});
		if (res.statusCode !== 200 || !res.body || !res.body.token) {
			throw new DarkmoonError(
				this.detail(res, 'Darkmoon login failed'),
				res.statusCode,
			);
		}
		this.token = res.body.token as string;
		return this.token;
	}

	/** Set of campaign ids currently visible (used to detect the run's new campaign). */
	async listCampaigns(): Promise<Campaign[]> {
		const res = await this.http({
			method: 'GET',
			url: this.url('/api/v1/campaigns'),
			headers: this.authHeaders(),
		});
		if (res.statusCode !== 200) {
			throw new DarkmoonError(this.detail(res, 'Failed to list campaigns'), res.statusCode);
		}
		return (res.body && res.body.data) || [];
	}

	/** Start a pentest in the background. Returns the run handle. */
	async runCampaign(params: RunPentestParams): Promise<RunHandle> {
		const res = await this.http({
			method: 'POST',
			url: this.url('/api/v1/run/campaign'),
			headers: this.authHeaders(),
			body: params,
		});
		if (res.statusCode >= 400 || !res.body || !res.body.run_id) {
			throw new DarkmoonError(this.detail(res, 'Failed to start pentest run'), res.statusCode);
		}
		return res.body as RunHandle;
	}

	async getRunLog(runId: string): Promise<RunEvent[]> {
		const res = await this.http({
			method: 'GET',
			url: this.url(`/api/v1/run/logs/${encodeURIComponent(runId)}`),
			headers: this.authHeaders(),
		});
		if (res.statusCode === 404) return [];
		if (res.statusCode !== 200) {
			throw new DarkmoonError(this.detail(res, 'Failed to read run log'), res.statusCode);
		}
		return (res.body && res.body.data) || [];
	}

	async stopRun(runId: string): Promise<void> {
		await this.http({
			method: 'DELETE',
			url: this.url(`/api/v1/run/${encodeURIComponent(runId)}/stop`),
			headers: this.authHeaders(),
		});
	}

	/**
	 * Poll the run's JSONL log until a terminal event (run_completed / run_error)
	 * appears, or the timeout elapses. The log is the API's single source of
	 * truth for run state (see routes_run.py). Returns the final event list.
	 */
	async waitForRun(
		runId: string,
		opts: {
			pollMs?: number;
			timeoutMs?: number;
			onEvent?: (e: RunEvent) => void;
			sleep?: (ms: number) => Promise<void>;
		} = {},
	): Promise<{ events: RunEvent[]; terminal: RunEvent | null; timedOut: boolean }> {
		const pollMs = opts.pollMs ?? 3000;
		const timeoutMs = opts.timeoutMs ?? 30 * 60 * 1000;
		const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
		const start = Date.now();
		let seen = 0;
		while (Date.now() - start < timeoutMs) {
			const events = await this.getRunLog(runId);
			if (opts.onEvent) {
				for (let i = seen; i < events.length; i++) opts.onEvent(events[i]);
			}
			seen = events.length;
			const terminal = events.find((e) => TERMINAL_TYPES.has(e.type || ''));
			if (terminal) {
				return { events, terminal, timedOut: false };
			}
			await sleep(pollMs);
		}
		const events = await this.getRunLog(runId);
		return { events, terminal: null, timedOut: true };
	}

	/**
	 * Resolve the campaign produced by a run.
	 *
	 * The trigger endpoint returns a run_id, not a campaign_id — the pentest
	 * agent creates the campaign itself via dashboard_init_campaign. We correlate
	 * by diffing the campaign set captured before the run against the set after
	 * it, preferring a new campaign whose target host matches. If nothing is new
	 * (e.g. an existing target/campaign was reused), we fall back to the most
	 * recent campaign matching the target host.
	 */
	async resolveRunCampaign(
		beforeIds: Set<string>,
		targetHost: string,
	): Promise<Campaign | null> {
		const campaigns = await this.listCampaigns();
		const host = (targetHost || '').trim().toLowerCase();

		const fresh = campaigns.filter((c) => !beforeIds.has(c.id));
		const byDate = (a: Campaign, b: Campaign) =>
			String(b.date || '').localeCompare(String(a.date || ''));

		const matchesHost = async (c: Campaign): Promise<boolean> => {
			if (!host) return false;
			// Cheap match: campaign carries no host, but its id and target often do.
			if (String(c.id).toLowerCase().includes(host)) return true;
			return false;
		};

		if (fresh.length === 1) return fresh[0];
		if (fresh.length > 1) {
			for (const c of fresh.sort(byDate)) {
				if (await matchesHost(c)) return c;
			}
			return fresh.sort(byDate)[0];
		}
		// No new campaign: fall back to newest overall (best effort).
		const sorted = campaigns.slice().sort(byDate);
		return sorted.length ? sorted[0] : null;
	}

	async getFindings(
		campaignId: string,
	): Promise<{ data: Finding[]; total: number; stats: Record<string, any> }> {
		const res = await this.http({
			method: 'GET',
			url: this.url(
				`/api/v1/vulnerabilities?campaign_id=${encodeURIComponent(campaignId)}`,
			),
			headers: this.authHeaders(),
		});
		if (res.statusCode !== 200) {
			throw new DarkmoonError(this.detail(res, 'Failed to fetch findings'), res.statusCode);
		}
		return {
			data: (res.body && res.body.data) || [],
			total: (res.body && res.body.total) || 0,
			stats: (res.body && res.body.stats) || {},
		};
	}

	async getReport(campaignId: string): Promise<{ content: string; format: string }> {
		const res = await this.http({
			method: 'GET',
			url: this.url(`/api/v1/campaigns/${encodeURIComponent(campaignId)}/report`),
			headers: this.authHeaders(),
		});
		if (res.statusCode !== 200) {
			throw new DarkmoonError(this.detail(res, 'Failed to fetch report'), res.statusCode);
		}
		return {
			content: (res.body && res.body.content) || '',
			format: (res.body && res.body.format) || 'markdown',
		};
	}
}
