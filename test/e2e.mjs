/**
 * End-to-end integration test for the Darkmoon n8n node's client logic.
 *
 * Drives the COMPILED DarkmoonClient (dist/) against a LIVE Darkmoon Dashboard
 * API (the real FastAPI service, started by run_local_api.sh). The `opencode`
 * pentest engine is replaced by test/stub_opencode, which exercises the real
 * dashboard write-path — so the trigger -> wait -> resolve campaign -> fetch
 * findings flow runs against real API code.
 *
 * Usage: BASE_URL=http://127.0.0.1:8000 node test/e2e.mjs
 */
import { DarkmoonClient } from '../dist/nodes/Darkmoon/DarkmoonClient.js';

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:8000';
const USER = process.env.DM_USER || 'admin';
const PASS = process.env.DM_PASS || 'admin';

// fetch-based transport conforming to the client's HttpFn contract.
const http = async ({ method, url, headers, body }) => {
	const res = await fetch(url, {
		method,
		headers,
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	let parsed = null;
	const text = await res.text();
	try {
		parsed = text ? JSON.parse(text) : null;
	} catch {
		parsed = text;
	}
	return { statusCode: res.status, body: parsed };
};

let failures = 0;
function check(name, cond, detail) {
	const ok = !!cond;
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
	if (!ok) failures++;
}

async function main() {
	const client = new DarkmoonClient(BASE_URL, http);

	// ── 1. Auth ────────────────────────────────────────────────────────
	const token = await client.login(USER, PASS);
	check('login returns a JWT', typeof token === 'string' && token.split('.').length === 3);

	// ── 2. Findings retrieval against real sample data (camp_pro = 19) ──
	const pro = await client.getFindings('camp_pro');
	check('getFindings(camp_pro) returns findings', pro.total === 19, `total=${pro.total}`);
	check(
		'findings carry severity + title',
		pro.data.length > 0 && pro.data[0].title && pro.data[0].severity,
		pro.data[0] && `${pro.data[0].severity}: ${pro.data[0].title}`,
	);
	check(
		'stats aggregate by severity',
		pro.stats && typeof pro.stats.by_severity === 'object',
		JSON.stringify(pro.stats.by_severity),
	);

	const campaigns = await client.listCampaigns();
	check('listCampaigns includes camp_pro', campaigns.some((c) => c.id === 'camp_pro'), `count=${campaigns.length}`);

	// ── 3. Full trigger -> results flow (stub engine, authorised lab) ──
	const target = process.env.DM_TARGET || 'http://juice-shop.dmlab:3000';
	const host = target.replace(/^https?:\/\//, '').split('/')[0].split(':')[0];
	const beforeIds = new Set((await client.listCampaigns()).map((c) => c.id));

	const handle = await client.runCampaign({ target, focus: ['xss'] });
	check('runCampaign returns a run_id', typeof handle.run_id === 'string' && handle.run_id.length > 0, handle.run_id);
	check('run command echoes TARGET', /TARGET:/.test(handle.command || ''), handle.command);

	const { terminal, timedOut } = await client.waitForRun(handle.run_id, {
		pollMs: 1000,
		timeoutMs: 60000,
	});
	check('run reaches a terminal event', !timedOut && terminal && terminal.type === 'run_completed', terminal && terminal.type);

	const campaign = await client.resolveRunCampaign(beforeIds, host);
	check('a new campaign is resolved for the run', !!campaign && !beforeIds.has(campaign.id), campaign && campaign.id);

	if (campaign) {
		const findings = await client.getFindings(campaign.id);
		check('run produced at least one finding', findings.total >= 1, `total=${findings.total}`);
		check(
			'finding is the stub XSS fixture',
			findings.data.some((f) => /xss/i.test(f.category || '') || /xss/i.test(f.title || '')),
			findings.data[0] && findings.data[0].title,
		);

		// getReport against the run's own campaign (finalize auto-generates the body).
		const report = await client.getReport(campaign.id);
		check(
			'getReport returns a markdown report',
			typeof report.content === 'string' && report.content.length > 0,
			`len=${report.content.length}`,
		);
	}

	console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : failures + ' TEST(S) FAILED'}`);
	process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
	console.error('E2E harness error:', err);
	process.exit(2);
});
