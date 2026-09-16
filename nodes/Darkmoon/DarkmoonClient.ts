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
	// --- Remediation (Pro) — maps 1:1 to CampaignRunRequest -----------------
	// The remediation phase runs DURING the pentest and opens fix pull requests.
	// `credential_id` is an OPAQUE reference to a credential stored in Darkmoon's
	// encrypted vault (created via the dashboard / POST /api/v1/credentials) — it
	// is NOT a token. Raw SCM secrets never travel through this node.
	remediate?: boolean;
	credential_id?: string;
	git_repo?: string;
	create_repo?: boolean;
}

/** A pull-request record, exactly as stored by the remediation agent (pr_store.py). */
export interface PullRequest {
	id: string;
	campaign_id?: string;
	provider?: string;
	repo?: string;
	url?: string;
	number?: number | null;
	title?: string;
	state?: string; // proposed | draft | open | merged | closed | error
	branch?: string;
	base?: string;
	summary?: string;
	files_changed?: string[];
	diff_stat?: Record<string, any>;
	validation?: Record<string, any>;
	finding_ids?: string[];
	created_at?: number;
	updated_at?: number;
	created_by_agent?: string;
	[k: string]: any;
}

/** The exact PR states the store recognises (pr_store.PR_STATES). */
export const PR_STATES = ['proposed', 'draft', 'open', 'merged', 'closed', 'error'] as const;
export type PrState = (typeof PR_STATES)[number];

/** Client-side filter for a PR list (the API only filters by campaign_id server-side). */
export interface PullRequestFilter {
	state?: string[];
	provider?: string;
	repository?: string; // matched against the record's `repo` field
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

	// ── Pull requests (read-only — writes are created by the remediation agent) ──

	/**
	 * List pull requests. `campaignId` is the ONLY server-side filter the API
	 * accepts (GET /pull-requests?campaign_id=…). Any state/provider/repository
	 * narrowing is applied client-side via {@link filterPullRequests}.
	 */
	async listPullRequests(campaignId?: string): Promise<PullRequest[]> {
		const q = campaignId ? `?campaign_id=${encodeURIComponent(campaignId)}` : '';
		const res = await this.http({
			method: 'GET',
			url: this.url(`/api/v1/pull-requests${q}`),
			headers: this.authHeaders(),
		});
		if (res.statusCode !== 200) {
			throw new DarkmoonError(this.detail(res, 'Failed to list pull requests'), res.statusCode);
		}
		return Array.isArray(res.body && res.body.data) ? res.body.data : [];
	}

	async getPullRequest(prId: string): Promise<PullRequest> {
		const res = await this.http({
			method: 'GET',
			url: this.url(`/api/v1/pull-requests/${encodeURIComponent(prId)}`),
			headers: this.authHeaders(),
		});
		if (res.statusCode !== 200) {
			throw new DarkmoonError(this.detail(res, `Pull request ${prId} not found`), res.statusCode);
		}
		return (res.body && res.body.data) || {};
	}

	async getPullRequestsForFinding(vulnId: string): Promise<PullRequest[]> {
		const res = await this.http({
			method: 'GET',
			url: this.url(`/api/v1/pull-requests/finding/${encodeURIComponent(vulnId)}`),
			headers: this.authHeaders(),
		});
		if (res.statusCode !== 200) {
			throw new DarkmoonError(
				this.detail(res, `Failed to fetch pull requests for finding ${vulnId}`),
				res.statusCode,
			);
		}
		return Array.isArray(res.body && res.body.data) ? res.body.data : [];
	}

	/** Client-side narrowing of a PR list. The API does not filter by these fields. */
	static filterPullRequests(prs: PullRequest[], filter?: PullRequestFilter): PullRequest[] {
		if (!filter) return prs;
		let out = prs;
		if (filter.state && filter.state.length) {
			const want = new Set(filter.state.map((s) => s.toLowerCase()));
			out = out.filter((p) => want.has(String(p.state || '').toLowerCase()));
		}
		if (filter.provider) {
			const p = filter.provider.toLowerCase();
			out = out.filter((x) => String(x.provider || '').toLowerCase() === p);
		}
		if (filter.repository) {
			const r = filter.repository.toLowerCase();
			out = out.filter((x) => String(x.repo || '').toLowerCase().includes(r));
		}
		return out;
	}

	/**
	 * Wait until at least `minCount` pull requests exist for a campaign, or the
	 * timeout elapses. Remediation runs during the pentest, so PRs usually exist
	 * as soon as the run completes; this poller covers the case where linkage
	 * lags. It never loops forever — it stops at the timeout and reports it.
	 */
	async waitForPullRequests(
		campaignId: string,
		opts: {
			minCount?: number;
			pollMs?: number;
			timeoutMs?: number;
			sleep?: (ms: number) => Promise<void>;
		} = {},
	): Promise<{ pullRequests: PullRequest[]; timedOut: boolean }> {
		const minCount = opts.minCount ?? 1;
		const pollMs = opts.pollMs ?? 5000;
		const timeoutMs = opts.timeoutMs ?? 5 * 60 * 1000;
		const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
		const start = Date.now();
		let prs: PullRequest[] = [];
		while (Date.now() - start < timeoutMs) {
			prs = await this.listPullRequests(campaignId);
			if (prs.length >= minCount) return { pullRequests: prs, timedOut: false };
			await sleep(pollMs);
		}
		prs = await this.listPullRequests(campaignId);
		return { pullRequests: prs, timedOut: prs.length < minCount };
	}

	/**
	 * Guard for remediation parameters. When remediation is enabled a credential
	 * reference (opaque vault id) is required — this is validated before any
	 * request so the run is never started half-configured. Throws DarkmoonError.
	 */
	static validateRemediation(params: {
		remediate?: boolean;
		credential_id?: string;
	}): void {
		if (params.remediate && !String(params.credential_id || '').trim()) {
			throw new DarkmoonError(
				'Remediation is enabled but no credential reference was provided. ' +
					'Set the opaque Darkmoon credential reference (a vault id, not a token) ' +
					'so the remediation agent can push a fix pull request.',
			);
		}
	}
}
