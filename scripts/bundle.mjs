/**
 * Bundle step for the Darkmoon n8n community node.
 *
 * The node's TRANSPORT is n8n's own `this.helpers.httpRequest`; the shared client
 * `@darkmoon_ai/client` is used only for its PURE normalizers / redaction helpers.
 * esbuild bundles each node from its TypeScript SOURCE and tree-shakes the client
 * down to those side-effect-free functions, so the published package:
 *   - has ZERO runtime dependencies (the client stays a devDependency);
 *   - contains no restricted globals (no setTimeout/fs/child_process from the
 *     client's OSS or HTTP layers — those are never imported).
 * Node built-ins used by the node itself (node:crypto) and n8n's own packages are
 * kept external.
 */
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const entries = [
	['nodes/Darkmoon/Darkmoon.node.ts', 'dist/nodes/Darkmoon/Darkmoon.node.js'],
	['nodes/DarkmoonTrigger/DarkmoonTrigger.node.ts', 'dist/nodes/DarkmoonTrigger/DarkmoonTrigger.node.js'],
];

for (const [src, out] of entries) {
	await build({
		entryPoints: [src],
		bundle: true,
		platform: 'node',
		target: 'node20',
		format: 'cjs',
		outfile: out,
		allowOverwrite: true,
		sourcemap: false,
		minify: false,
		treeShaking: true,
		conditions: ['import', 'module'],
		mainFields: ['module', 'main'],
		// n8n provides these at runtime; keep node:crypto external too.
		external: ['n8n-workflow', 'n8n-core', 'node:crypto'],
		banner: {
			js: `// n8n-nodes-darkmoon v${pkg.version} — bundled (pure client helpers inlined), do not edit by hand.`,
		},
		logLevel: 'warning',
	});
	// eslint-disable-next-line no-console
	console.log(`Bundled ${out}`);
}
