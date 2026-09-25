/**
 * Mock Darkmoon Pro API — a dependency-free HTTP stub that speaks the exact wire
 * contract `@darkmoon_ai/client`'s ProHttpBackend expects. Used by both the local
 * unit tests and the Docker test lab (docker/). It serves a synthetic "Demo Shop"
 * campaign with ZEROED secrets: findings deliberately carry an `evidence` object
 * containing a fake token so tests can prove the node never emits it.
 *
 * Run: node test/mock-darkmoon.mjs   (PORT env, default 8000)
 */
import http from 'node:http';

const PORT = Number(process.env.PORT || 8000);

const CAMPAIGN = {
	id: 'camp_demoshop01',
	project_id: 'proj_demo',
	target_id: 'tgt_demoshop',
	session_id: 'ses_demoshop01abcdef',
	target: 'demo-shop.local',
	status: 'completed',
	overall_risk: 'high',
	date: '2026-09-25',
	duration_seconds: 412,
	stats: {
		total_findings: 3,
		critical: 1,
		high: 1,
		medium: 1,
		low: 0,
		info: 0,
		exploited: 1,
		confirmed: 1,
		unconfirmed: 1,
	},
};

// Findings intentionally include an evidence blob with a fake secret. The node
// must NEVER surface it (it fetches with includeEvidence:false).
const FAKE_SECRET = 'sk-DEMOSHOP-DO-NOT-LEAK-000000000000';
const FINDINGS = [
	{
		id: 'vuln_demo001',
		campaign_id: CAMPAIGN.id,
		target_id: CAMPAIGN.target_id,
		title: 'SQL injection in product search',
		severity: 'critical',
		status: 'exploited',
		category: 'injection',
		cve: 'CVE-2021-0000',
		cvss_score: 9.8,
		cvss_vector: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H',
		mitre_attack_id: 'T1190',
		endpoint: '/rest/products/search',
		discovered_by_agent: 'pentest',
		remediation: 'Use parameterised queries.',
		evidence: { commands: [`curl -H "Authorization: Bearer ${FAKE_SECRET}" ...`], extracted: FAKE_SECRET },
	},
	{
		id: 'vuln_demo002',
		campaign_id: CAMPAIGN.id,
		target_id: CAMPAIGN.target_id,
		title: 'Reflected XSS in feedback form',
		severity: 'high',
		status: 'confirmed',
		category: 'xss',
		cvss_score: 7.1,
		endpoint: '/feedback',
		discovered_by_agent: 'pentest',
		evidence: { payloads: ['<script>alert(1)</script>'], token: FAKE_SECRET },
	},
	{
		id: 'vuln_demo003',
		campaign_id: CAMPAIGN.id,
		target_id: CAMPAIGN.target_id,
		title: 'Verbose error message',
		severity: 'medium',
		status: 'unconfirmed',
		category: 'info-leak',
		endpoint: '/api/debug',
		discovered_by_agent: 'pentest',
		evidence: {},
	},
];

const WEBHOOKS = new Map();
let webhookSeq = 0;

// Synthetic event feed (safe fields only). seq is monotonic.
const EVENTS = [
	{ event: 'campaign.started', seq: 1, data: { campaign_id: CAMPAIGN.id, target: CAMPAIGN.target } },
	{ event: 'finding.discovered', seq: 2, data: { finding_id: 'vuln_demo001', severity: 'critical' } },
	{ event: 'finding.exploited', seq: 3, data: { finding_id: 'vuln_demo001', severity: 'critical', endpoint: '/rest/products/search' } },
	{ event: 'finding.confirmed', seq: 4, data: { finding_id: 'vuln_demo002', severity: 'high' } },
	{ event: 'pr.opened', seq: 5, data: { pr_id: 'pr_demo01', finding_ids: ['vuln_demo001'], state: 'open' } },
	{ event: 'campaign.completed', seq: 6, data: { campaign_id: CAMPAIGN.id, overall_risk: 'high', stats: CAMPAIGN.stats } },
	{ event: 'retest.completed', seq: 7, data: { retest_id: 'rt_demo01', verdicts: { fixed: 1, regressed: 0 } } },
];

function json(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
	res.end(payload);
}

async function readBody(req) {
	return await new Promise((resolve) => {
		let data = '';
		req.on('data', (c) => (data += c));
		req.on('end', () => {
			try {
				resolve(data ? JSON.parse(data) : {});
			} catch {
				resolve({});
			}
		});
	});
}

const server = http.createServer(async (req, res) => {
	const u = new URL(req.url, `http://localhost:${PORT}`);
	const p = u.pathname.replace(/\/+$/, '') || '/';
	const method = req.method || 'GET';

	if (method === 'OPTIONS') return json(res, 204, {});

	// ── System / auth ────────────────────────────────────────────────
	if (p === '/api/v1/system/info' && method === 'GET') {
		return json(res, 200, {
			service: 'darkmoon-mock',
			edition: 'pro',
			api_version: '1.0.0',
			product_version: '0.0.0-mock',
			contract_version: '1',
			capabilities: ['auth', 'campaigns', 'run', 'vulnerabilities', 'webhooks', 'retest', 'metrics', 'system'],
			features: { auth: true, sse_progress: true, remediation: true, scheduler: true },
		});
	}
	if (p === '/api/v1/auth/login' && method === 'POST') {
		return json(res, 200, { token: 'mock.jwt.token', must_change_password: false, user: { username: 'admin' } });
	}

	// ── Run / campaigns ──────────────────────────────────────────────
	if (p === '/api/v1/run/campaign' && method === 'POST') {
		await readBody(req);
		return json(res, 200, { run_id: 'run_demo01', pid: 4242, command: 'opencode run --agent pentest' });
	}
	if (p.startsWith('/api/v1/run/logs/') && method === 'GET') {
		return json(res, 200, { data: [{ type: 'run_started', session_id: CAMPAIGN.session_id }], total: 1 });
	}
	if (p === '/api/v1/campaigns' && method === 'GET') {
		return json(res, 200, { data: [CAMPAIGN], total: 1 });
	}
	if (p.match(/^\/api\/v1\/campaigns\/[^/]+\/report$/) && method === 'GET') {
		return json(res, 200, { campaign_id: CAMPAIGN.id, format: 'markdown', content: '# Demo Shop report\n\nRedacted body.' });
	}
	if (p.match(/^\/api\/v1\/campaigns\/[^/]+$/) && method === 'GET') {
		return json(res, 200, { data: CAMPAIGN });
	}

	// ── Vulnerabilities ──────────────────────────────────────────────
	if (p === '/api/v1/vulnerabilities' && method === 'GET') {
		return json(res, 200, { data: FINDINGS, total: FINDINGS.length, stats: CAMPAIGN.stats });
	}
	if (p.match(/^\/api\/v1\/vulnerabilities\/[^/]+\/evidence-meta$/) && method === 'GET') {
		const id = p.split('/')[4];
		return json(res, 200, {
			vuln_id: id,
			has_evidence: true,
			counts: { commands: 1, payloads: 1, screenshots: 0, logs: 2, requests: 1 },
			command_names: ['curl'],
			has_screenshot: false,
			has_extracted_data: true,
			redacted: true,
		});
	}
	if (p.match(/^\/api\/v1\/vulnerabilities\/[^/]+$/) && method === 'GET') {
		const id = p.split('/')[4];
		const f = FINDINGS.find((x) => x.id === id) || FINDINGS[0];
		return json(res, 200, { data: f });
	}

	// ── Pull requests (read-only) ────────────────────────────────────
	if (p === '/api/v1/pull-requests' && method === 'GET') {
		return json(res, 200, {
			data: [
				{
					id: 'pr_demo01',
					campaign_id: CAMPAIGN.id,
					provider: 'github',
					repo: 'acme/shop',
					number: 42,
					state: 'open',
					title: 'Fix SQL injection in product search',
					finding_ids: ['vuln_demo001'],
				},
			],
			total: 1,
		});
	}

	// ── Retest ───────────────────────────────────────────────────────
	if (p === '/api/v1/retest' && method === 'POST') {
		await readBody(req);
		return json(res, 200, { retest_id: 'rt_demo01', run_id: 'run_rt01', base_campaign_id: CAMPAIGN.id, target_id: CAMPAIGN.target_id });
	}
	if (p.match(/^\/api\/v1\/retest\/[^/]+$/) && method === 'GET') {
		return json(res, 200, {
			retest_id: 'rt_demo01',
			base_campaign_id: CAMPAIGN.id,
			new_campaign_id: 'camp_demoshop02',
			target_id: CAMPAIGN.target_id,
			run_id: 'run_rt01',
			status: 'completed',
			verdicts_summary: { fixed: 1, still_present: 1, regressed: 0, new: 1 },
			findings: [
				{ finding_id: 'vuln_demo001', new_finding_id: null, base_status: 'exploited', new_status: 'remediated', severity: 'critical', verdict: 'fixed' },
				{ finding_id: 'vuln_demo002', new_finding_id: 'vuln_demo004', base_status: 'confirmed', new_status: 'confirmed', severity: 'high', verdict: 'still_present' },
			],
		});
	}

	// ── Metrics timeseries ───────────────────────────────────────────
	if (p === '/api/v1/metrics/timeseries' && method === 'GET') {
		return json(res, 200, {
			metric: u.searchParams.get('metric') || 'severity',
			group: u.searchParams.get('group') || 'day',
			series: [
				{ key: 'critical', points: [{ t: '2026-09-24', value: 0 }, { t: '2026-09-25', value: 1 }] },
				{ key: 'high', points: [{ t: '2026-09-24', value: 2 }, { t: '2026-09-25', value: 1 }] },
			],
		});
	}

	// ── Webhooks ─────────────────────────────────────────────────────
	if (p === '/api/v1/webhooks' && method === 'POST') {
		const body = await readBody(req);
		const id = `wh_${++webhookSeq}`;
		const row = {
			id,
			url: body.url,
			events: body.events || [],
			format: body.format || 'darkmoon',
			enabled: true,
			created_at: new Date().toISOString(),
			secret: `whsec_${Math.random().toString(36).slice(2, 10)}`,
		};
		WEBHOOKS.set(id, row);
		return json(res, 200, { data: row });
	}
	if (p === '/api/v1/webhooks' && method === 'GET') {
		const list = [...WEBHOOKS.values()].map((w) => ({ ...w, secret: 'set:xxxx' }));
		return json(res, 200, { data: list });
	}
	if (p.match(/^\/api\/v1\/webhooks\/[^/]+$/) && method === 'DELETE') {
		const id = p.split('/')[4];
		if (!WEBHOOKS.has(id)) return json(res, 404, { detail: 'not found' });
		WEBHOOKS.delete(id);
		return json(res, 200, { message: 'deleted', id });
	}

	// ── Events SSE ───────────────────────────────────────────────────
	if (p === '/api/v1/events/stream' && method === 'GET') {
		const since = Number(u.searchParams.get('since') || 0);
		const filter = (u.searchParams.get('events') || '').split(',').filter(Boolean);
		res.writeHead(200, {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			Connection: 'keep-alive',
			'Access-Control-Allow-Origin': '*',
		});
		const due = EVENTS.filter((e) => e.seq > since && (!filter.length || filter.includes(e.event)));
		for (const e of due) {
			const env = { ...e, contract_version: '1', delivery_id: `del_${e.seq}`, ts: new Date().toISOString() };
			res.write(`event: ${e.event}\ndata: ${JSON.stringify(env)}\n\n`);
		}
		// Close after the backlog so pollers return promptly (real Pro keeps open).
		res.end();
		return;
	}

	return json(res, 404, { detail: `no mock route for ${method} ${p}` });
});

server.listen(PORT, () => {
	// eslint-disable-next-line no-console
	console.log(`[mock-darkmoon] listening on http://0.0.0.0:${PORT}`);
});
