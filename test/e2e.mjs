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

	// ── 4. Full trigger -> remediation -> pull requests flow ───────────
	const before2 = new Set((await client.listCampaigns()).map((c) => c.id));
	const CRED_REF = 'cred_lab_ref_0001'; // opaque vault reference, NOT a token
	const remHandle = await client.runCampaign({
		target,
		focus: ['xss'],
		remediate: true,
		credential_id: CRED_REF,
		git_repo: 'https://github.com/acme/shop-lab',
	});
	check('remediation run command carries REMEDIATE', /REMEDIATE=1/.test(remHandle.command || ''), remHandle.command);
	check('remediation run passes CREDENTIAL_REF (opaque)', /CREDENTIAL_REF=cred_lab_ref_0001/.test(remHandle.command || ''), 'ref present');

	const rem = await client.waitForRun(remHandle.run_id, { pollMs: 1000, timeoutMs: 60000 });
	check('remediation run completes', !rem.timedOut && rem.terminal?.type === 'run_completed', rem.terminal?.type);

	const remCampaign = await client.resolveRunCampaign(before2, host);
	check('remediation campaign resolved', !!remCampaign && !before2.has(remCampaign.id), remCampaign?.id);

	if (remCampaign) {
		const { pullRequests, timedOut: prTimeout } = await client.waitForPullRequests(remCampaign.id, {
			minCount: 1,
			pollMs: 1000,
			timeoutMs: 30000,
		});
		check('remediation produced a pull request', !prTimeout && pullRequests.length >= 1, `prs=${pullRequests.length}`);

		const pr = pullRequests[0];
		check('PR record uses a real state', ['proposed', 'draft', 'open', 'merged', 'closed', 'error'].includes(pr.state), pr && pr.state);
		check('PR carries repo + url + finding link', !!pr.repo && !!pr.url && (pr.finding_ids || []).length >= 1, pr && `${pr.repo} ${pr.url}`);

		// List PRs — no filter (across campaigns)
		const all = await client.listPullRequests();
		check('listPullRequests (no filter) returns records', all.length >= 1, `total=${all.length}`);

		// List PRs — by campaign_id (server filter)
		const byCamp = await client.listPullRequests(remCampaign.id);
		check('listPullRequests by campaign_id', byCamp.length >= 1 && byCamp.every((p) => p.campaign_id === remCampaign.id), `total=${byCamp.length}`);

		// List PRs — by state (client-side filter)
		const openOnly = DarkmoonClient.filterPullRequests(byCamp, { state: ['open'] });
		check('client-side state filter keeps open PRs', openOnly.length >= 1 && openOnly.every((p) => p.state === 'open'), `open=${openOnly.length}`);
		const mergedOnly = DarkmoonClient.filterPullRequests(byCamp, { state: ['merged'] });
		check('client-side state filter excludes non-matching', mergedOnly.length === 0, `merged=${mergedOnly.length}`);

		// Get one PR
		const one = await client.getPullRequest(pr.id);
		check('getPullRequest returns the record', one.id === pr.id, one && one.id);

		// Get PRs by finding
		const fid = (pr.finding_ids || [])[0];
		if (fid) {
			const forFinding = await client.getPullRequestsForFinding(fid);
			check('getPullRequestsForFinding links back', forFinding.some((p) => p.id === pr.id), `count=${forFinding.length}`);
		}
	}

	console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : failures + ' TEST(S) FAILED'}`);
	process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
	console.error('E2E harness error:', err);
	process.exit(2);
});
