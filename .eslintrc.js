/**
 * ESLint config for the Darkmoon n8n community node.
 * Uses eslint-plugin-n8n-nodes-base, the ruleset the n8n verification linter
 * (`npx @n8n/scan-community-package`) enforces.
 */
module.exports = {
	root: true,
	env: { browser: true, es6: true, node: true },
	parser: '@typescript-eslint/parser',
	parserOptions: {
		sourceType: 'module',
		extraFileExtensions: ['.json'],
	},
	ignorePatterns: ['.eslintrc.js', '**/*.js', '**/node_modules/**', '**/dist/**'],
	overrides: [
		{
			files: ['package.json'],
			plugins: ['eslint-plugin-n8n-nodes-base'],
			extends: ['plugin:n8n-nodes-base/community'],
			rules: {
				'n8n-nodes-base/community-package-json-name-still-default': 'off',
			},
		},
		{
			files: ['./credentials/**/*.ts'],
			parserOptions: { project: ['./tsconfig.json'] },
			plugins: ['eslint-plugin-n8n-nodes-base'],
			extends: ['plugin:n8n-nodes-base/credentials'],
			rules: {
				// Community-node credentials use a full HTTPS documentation URL
				// (enforced by cred-class-field-documentation-url-not-http-url).
				// The `-miscased` rule is meant for core-node slug URLs and
				// mis-fires on full URLs — the two rules are mutually exclusive,
				// so this one is disabled for community packages.
				'n8n-nodes-base/cred-class-field-documentation-url-miscased': 'off',
			},
		},
		{
			files: ['./nodes/**/*.ts'],
			parserOptions: { project: ['./tsconfig.json'] },
			plugins: ['eslint-plugin-n8n-nodes-base'],
			extends: ['plugin:n8n-nodes-base/nodes'],
		},
	],
};
