/**
 * Unit tests for DarkmoonClient using a programmable mock transport.
 *
 * These cover the paths that are awkward to trigger against a live server:
 * remediation validation, HTTP error mapping (401/403/404/500), empty and
 * malformed responses, wait/poll timeouts, and — importantly — that no secret
 * (JWT, password, or credential value) ever leaks into an error message.
 *
 * Run: node test/unit.mjs   (no server required)
 */
import { DarkmoonClient, DarkmoonError } from '../dist/nodes/Darkmoon/DarkmoonClient.js';

let failures = 0;
function check(name, cond, detail) {
	const ok = !!cond;
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
	if (!ok) failures++;
}

// A mock transport driven by a routing table: [{ match(opts), response }].
function mockHttp(routes, sink) {
	return async (opts) => {
		if (sink) sink.push(opts);
		for (const r of routes) {
			if (r.match(opts)) return typeof r.response === 'function' ? r.response(opts) : r.response;
		}
		return { statusCode: 200, body: { data: [], total: 0 } };
	};
}
const ok = (body) => ({ statusCode: 200, body });
const err = (code, detail) => ({ statusCode: code, body: { detail } });
const noSleep = () => Promise.resolve();

async function run() {
	// ── remediation validation (case: missing credential ref) ──────────
	check(
		'validateRemediation throws when remediation on but no credential ref',
		(() => {
			try {
				DarkmoonClient.validateRemediation({ remediate: true, credential_id: '' });
				return false;
			} catch (e) {
				return e instanceof DarkmoonError && /credential reference/i.test(e.message);
			}
		})(),
	);
	check(
		'validateRemediation passes when remediation off',
		(() => {
			try {
				DarkmoonClient.validateRemediation({ remediate: false });
				return true;
			} catch {
				return false;
			}
		})(),
	);
	check(
		'validateRemediation passes with a credential ref',
		(() => {
			try {
				DarkmoonClient.validateRemediation({ remediate: true, credential_id: 'cred_x' });
				return true;
			} catch {
				return false;
			}
		})(),
	);

	// ── run WITHOUT remediation: body carries no remediation fields ─────
	{
		const sink = [];
		const c = new DarkmoonClient('http://x', mockHttp([
			{ match: (o) => o.url.endsWith('/run/campaign'), response: ok({ run_id: 'r1', pid: 1, command: 'TARGET: t' }) },
		], sink));
		await c.runCampaign({ target: 't' });
		const body = sink[0].body;
		check('run without remediation sends no REMEDIATE fields',
			body.remediate === undefined && body.credential_id === undefined && body.create_repo === undefined);
	}

	// ── run WITH remediation: opaque credential_id in body, no raw secret ──
	{
		const sink = [];
		const c = new DarkmoonClient('http://x', mockHttp([
			{ match: (o) => o.url.endsWith('/run/campaign'), response: ok({ run_id: 'r2', pid: 2, command: 'X REMEDIATE=1' }) },
		], sink));
		await c.runCampaign({ target: 't', remediate: true, credential_id: 'cred_ref_9', git_repo: 'https://g/r' });
		const body = sink[0].body;
		const serialized = JSON.stringify(body);
		check('run with remediation sends opaque credential_id', body.credential_id === 'cred_ref_9' && body.remediate === true);
		check('run body carries no raw token/password key', !/"(token|password|secret|api[_-]?key)"/i.test(serialized), serialized);
	}

	// ── empty response ─────────────────────────────────────────────────
	{
		const c = new DarkmoonClient('http://x', mockHttp([
			{ match: (o) => o.url.includes('/pull-requests'), response: ok({ data: [], total: 0 }) },
		]));
		const prs = await c.listPullRequests('camp_empty');
		check('empty PR list -> []', Array.isArray(prs) && prs.length === 0);
	}

	// ── HTTP error mapping 401 / 403 / 404 / 500 ───────────────────────
	for (const [code, where] of [[401, 'login'], [403, 'campaigns'], [500, 'campaigns']]) {
		const c = new DarkmoonClient('http://x', mockHttp([
			{ match: () => true, response: err(code, `boom-${code}`) },
		]));
		let caught = null;
		try {
			if (where === 'login') await c.login('u', 'p');
			else await c.listCampaigns();
		} catch (e) {
			caught = e;
		}
		check(`HTTP ${code} -> DarkmoonError with statusCode`, caught instanceof DarkmoonError && caught.statusCode === code, caught && caught.message);
	}
	{
		const c = new DarkmoonClient('http://x', mockHttp([
			{ match: (o) => o.url.includes('/pull-requests/'), response: err(404, 'Pull request pr_x not found') },
		]));
		let caught = null;
		try {
			await c.getPullRequest('pr_x');
		} catch (e) {
			caught = e;
		}
		check('HTTP 404 on getPullRequest -> DarkmoonError 404', caught instanceof DarkmoonError && caught.statusCode === 404, caught && caught.message);
	}

	// ── malformed API response (body is a string / missing data) ───────
	{
		const c = new DarkmoonClient('http://x', mockHttp([
			{ match: (o) => o.url.includes('/pull-requests'), response: { statusCode: 200, body: '<html>not json</html>' } },
		]));
		const prs = await c.listPullRequests();
		check('malformed PR response -> [] (no crash)', Array.isArray(prs) && prs.length === 0);
	}
	{
		const c = new DarkmoonClient('http://x', mockHttp([
			{ match: (o) => o.url.endsWith('/run/campaign'), response: ok({ nope: true }) },
		]));
		let caught = null;
		try {
			await c.runCampaign({ target: 't' });
		} catch (e) {
			caught = e;
		}
		check('run trigger without run_id -> error (no fake success)', caught instanceof DarkmoonError);
	}

	// ── timeouts (never loop forever) ──────────────────────────────────
	{
		const c = new DarkmoonClient('http://x', mockHttp([
			{ match: (o) => o.url.includes('/run/logs/'), response: ok({ data: [{ type: 'step' }], total: 1 }) },
		]));
		const res = await c.waitForRun('r', { pollMs: 1, timeoutMs: 10, sleep: noSleep });
		check('waitForRun times out with no terminal event', res.timedOut === true && res.terminal === null);
	}
	{
		const c = new DarkmoonClient('http://x', mockHttp([
			{ match: (o) => o.url.includes('/pull-requests'), response: ok({ data: [], total: 0 }) },
		]));
		const res = await c.waitForPullRequests('camp', { minCount: 1, pollMs: 1, timeoutMs: 10, sleep: noSleep });
		check('waitForPullRequests times out cleanly', res.timedOut === true && res.pullRequests.length === 0);
	}

	// ── NO secret leakage in errors ────────────────────────────────────
	{
		const SECRET_PW = 'S3cret-Passw0rd!';
		const TOKEN = 'jwt.header.signature.SECRET';
		const CRED = 'cred_ref_should_be_opaque';
		const c = new DarkmoonClient('http://x', mockHttp([
			{ match: (o) => o.url.endsWith('/auth/login'), response: ok({ token: TOKEN }) },
			{ match: (o) => o.url.endsWith('/run/campaign'), response: err(500, 'internal error') },
		]));
		await c.login('admin', SECRET_PW);
		let msg = '';
		try {
			await c.runCampaign({ target: 't', remediate: true, credential_id: CRED });
		} catch (e) {
			msg = String(e.message) + ' ' + String(e.stack || '');
		}
		check('error message does not leak the password', !msg.includes(SECRET_PW));
		check('error message does not leak the JWT', !msg.includes(TOKEN));
		check('DarkmoonError surfaces only the API detail', /internal error/.test(msg));
	}

	console.log(`\n${failures === 0 ? 'ALL UNIT TESTS PASSED' : failures + ' UNIT TEST(S) FAILED'}`);
	process.exit(failures === 0 ? 0 : 1);
}

run().catch((e) => {
	console.error('unit harness error:', e);
	process.exit(2);
});
