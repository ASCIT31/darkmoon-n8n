/**
 * Unit / integration tests for the Darkmoon n8n nodes.
 *
 * Drives the REAL bundled nodes (dist/) against the mock Darkmoon Pro API
 * (test/mock-darkmoon.mjs) through a lightweight fake n8n execution context.
 * Asserts every operation returns, the trigger de-duplicates via its cursor, and
 * — critically — that no evidence value or secret ever reaches the output.
 *
 * Run: node test/unit.mjs   (starts its own mock on an ephemeral port)
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const { Darkmoon } = await import('../dist/nodes/Darkmoon/Darkmoon.node.js');
const { DarkmoonTrigger } = await import('../dist/nodes/DarkmoonTrigger/DarkmoonTrigger.node.js');

let failures = 0;
function check(name, cond, detail) {
	const ok = !!cond;
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? '  — ' + detail : ''}`);
	if (!ok) failures++;
}

const PORT = 8199;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const CREDS = { baseUrl: BASE_URL, authMethod: 'token', token: 'mock-token' };
const FORBIDDEN = /sk-DEMOSHOP-DO-NOT-LEAK|DO-NOT-LEAK/;
const NODE = { id: 'n', name: 'Darkmoon', type: 'n8n-nodes-darkmoon.darkmoon', typeVersion: 1, position: [0, 0], parameters: {} };

// Minimal stand-in for n8n's this.helpers.httpRequest (returnFullResponse form).
async function httpRequest(o) {
	const url = new URL(o.url);
	for (const [k, v] of Object.entries(o.qs || {})) if (v !== undefined) url.searchParams.set(k, String(v));
	const r = await fetch(url, {
		method: o.method || 'GET',
		headers: o.headers || {},
		body: o.body ? JSON.stringify(o.body) : undefined,
	});
	const text = await r.text();
	let body; try { body = text ? JSON.parse(text) : {}; } catch { body = text; }
	return { statusCode: r.status, body };
}
const HELPERS = { httpRequest };

function execContext(params, items = [{ json: {} }]) {
	return {
		getInputData: () => items,
		getCredentials: async () => CREDS,
		getNode: () => NODE,
		helpers: HELPERS,
		continueOnFail: () => false,
		getNodeParameter: (name, _i, def) => (name in params ? params[name] : def),
	};
}

function pollContext(params, staticData, mode = 'trigger') {
	return {
		getCredentials: async () => CREDS,
		getNode: () => ({ ...NODE, name: 'Darkmoon Trigger', type: 'n8n-nodes-darkmoon.darkmoonTrigger' }),
		helpers: HELPERS,
		getMode: () => mode,
		getWorkflowStaticData: () => staticData,
		getNodeParameter: (name, def) => (name in params ? params[name] : def),
	};
}

async function runAction(params) {
	const out = await Darkmoon.prototype.execute.call(execContext(params));
	return out[0].map((x) => x.json);
}

// ── Start the mock ────────────────────────────────────────────────────
const mock = spawn(process.execPath, ['test/mock-darkmoon.mjs'], {
	env: { ...process.env, PORT: String(PORT) },
	stdio: ['ignore', 'pipe', 'inherit'],
});
await new Promise((resolve, reject) => {
	const t = setTimeout(() => reject(new Error('mock did not start')), 5000);
	mock.stdout.on('data', (d) => {
		if (String(d).includes('listening')) {
			clearTimeout(t);
			resolve();
		}
	});
});

try {
	// ── Static description sanity ─────────────────────────────────────
	const d = new Darkmoon();
	const resources = d.description.properties.find((p) => p.name === 'resource').options.map((o) => o.value);
	check('action exposes campaign/finding/retest/metric/webhook resources', ['campaign', 'finding', 'retest', 'metric', 'webhook'].every((r) => resources.includes(r)));
	const t = new DarkmoonTrigger();
	check('trigger is a polling trigger', t.description.polling === true);
	check('trigger declares a webhook path', t.description.webhooks?.length === 1);
	check('trigger exposes finding.exploited event', t.description.properties.find((p) => p.name === 'events').options.some((o) => o.value === 'finding.exploited'));

	// ── Campaign ──────────────────────────────────────────────────────
	const list = await runAction({ resource: 'campaign', operation: 'list', campaignFilters: {} });
	check('campaign list returns the demo campaign', list[0].total === 1 && list[0].campaigns[0].id === 'camp_demoshop01');

	const get = await runAction({ resource: 'campaign', operation: 'get', campaignId: 'camp_demoshop01' });
	check('campaign get returns normalized campaign', get[0].id === 'camp_demoshop01' && get[0].status === 'completed');

	const summary = await runAction({ resource: 'campaign', operation: 'getSeveritySummary', campaignId: 'camp_demoshop01' });
	check('severity summary has a critical count', Number(summary[0].critical) === 1, JSON.stringify(summary[0]));

	const launch = await runAction({
		resource: 'campaign',
		operation: 'launch',
		target: 'demo-shop.local',
		waitForCompletion: true,
		enableRemediation: false,
		options: { pollSeconds: 1, timeoutMinutes: 1 },
	});
	check('campaign launch + wait resolves to completed', launch[0].waited === true && launch[0].campaign_id === 'camp_demoshop01', JSON.stringify(launch[0]));

	// remediation guard
	const remErr = await Darkmoon.prototype.execute.call({
		...execContext({ resource: 'campaign', operation: 'launch', target: 'x', waitForCompletion: false, enableRemediation: true, remediation: {}, options: {} }),
		continueOnFail: () => true,
	});
	check('remediation without credential reference errors', /credential reference/i.test(remErr[0][0].json.error || ''));

	// ── Findings + redaction ──────────────────────────────────────────
	const findings = await runAction({ resource: 'finding', operation: 'list', findingFilters: { campaignId: 'camp_demoshop01' } });
	check('finding list returns 3 findings', findings[0].total === 3);
	const findingsStr = JSON.stringify(findings);
	check('finding list carries NO evidence secret', !FORBIDDEN.test(findingsStr));
	check('finding list carries no populated evidence object', findings[0].findings.every((f) => f.evidence == null || Object.keys(f.evidence).length === 0), findingsStr.slice(0, 300));

	const oneFinding = await runAction({ resource: 'finding', operation: 'get', findingId: 'vuln_demo001' });
	check('finding get carries NO secret', !FORBIDDEN.test(JSON.stringify(oneFinding)));

	const meta = await runAction({ resource: 'finding', operation: 'getEvidenceMeta', findingId: 'vuln_demo001' });
	check('evidence-meta returns counts only, no content', meta[0].hasEvidence === true && meta[0].counts.commands === 1 && !FORBIDDEN.test(JSON.stringify(meta)));

	// ── Retest ────────────────────────────────────────────────────────
	const rLaunch = await runAction({ resource: 'retest', operation: 'launch', retestBy: 'campaign', baseCampaignId: 'camp_demoshop01', retestOptions: {} });
	check('retest launch returns a retest id', rLaunch[0].retestId === 'rt_demo01');
	const rGet = await runAction({ resource: 'retest', operation: 'get', retestId: 'rt_demo01' });
	check('retest verdicts include fixed=1', rGet[0].verdictsSummary.fixed === 1 && rGet[0].findings.some((f) => f.verdict === 'fixed'));

	// ── Metrics ───────────────────────────────────────────────────────
	const ts = await runAction({ resource: 'metric', operation: 'getTimeseries', timeseriesOptions: { metric: 'severity', group: 'day' } });
	check('timeseries returns series', Array.isArray(ts[0].series) && ts[0].series.length === 2);

	// ── Webhooks ──────────────────────────────────────────────────────
	const reg = await runAction({ resource: 'webhook', operation: 'register', webhookUrl: 'https://n8n.example/webhook/x', webhookEvents: 'finding.exploited' });
	check('webhook register returns an id + secret', /^wh_/.test(reg[0].id) && typeof reg[0].secret === 'string');
	const whList = await runAction({ resource: 'webhook', operation: 'list' });
	check('webhook list masks the secret', whList[0].total === 1 && whList[0].webhooks[0].secret === 'set:xxxx');
	const del = await runAction({ resource: 'webhook', operation: 'delete', webhookId: reg[0].id });
	check('webhook delete confirms removal', del[0].deleted === true);

	// ── Trigger poll: first run primes, second run emits, third de-dups ─
	const staticData = {};
	const p1 = await DarkmoonTrigger.prototype.poll.call(pollContext({ mode: 'poll', events: [] }, staticData));
	check('trigger first poll primes the cursor (no emit)', p1 === null && staticData.primed === true && staticData.seen);
	// Reset the seen-cursor to force a real emit of the whole backlog.
	staticData.seen = { f: {}, c: {}, p: {} };
	const p2 = await DarkmoonTrigger.prototype.poll.call(pollContext({ mode: 'poll', events: [] }, staticData));
	check('trigger emits the event backlog', Array.isArray(p2) && p2[0].length >= 6, p2 ? String(p2[0].length) : 'null');
	check('trigger events carry no secret', !FORBIDDEN.test(JSON.stringify(p2)));
	const p3 = await DarkmoonTrigger.prototype.poll.call(pollContext({ mode: 'poll', events: [] }, staticData));
	check('trigger de-duplicates (no re-emit)', p3 === null, JSON.stringify(p3));
	// Event filter.
	staticData.seen = { f: {}, c: {}, p: {} };
	const p4 = await DarkmoonTrigger.prototype.poll.call(pollContext({ mode: 'poll', events: ['finding.exploited'] }, staticData));
	check('trigger filters to finding.exploited only', Array.isArray(p4) && p4[0].length === 1 && p4[0][0].json.event === 'finding.exploited');

	await sleep(50);
} catch (err) {
	check(`unexpected error: ${err.message}`, false, err.stack);
} finally {
	mock.kill();
}

console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : failures + ' TEST(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
