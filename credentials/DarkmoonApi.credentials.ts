import type {
	IAuthenticateGeneric,
	Icon,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

/**
 * Darkmoon Dashboard (Pro REST) API credentials.
 *
 * Two authentication methods are supported:
 *   - API Token (recommended): a Darkmoon Pro bearer token / §DARKMOON_REQUIRE_AUTH_WRITES
 *     token. No password is stored; the token is injected as `Authorization: Bearer`.
 *   - Username / Password: the node logs in at run time (POST /auth/login) and
 *     caches the short-lived JWT in memory only.
 *
 * All fields are stored with n8n's credential encryption. Secrets are never logged.
 * The "Test" button calls GET /api/v1/system/info, which confirms the Base URL
 * points at a real Darkmoon API and reports its edition and contract version.
 */
export class DarkmoonApi implements ICredentialType {
	name = 'darkmoonApi';

	displayName = 'Darkmoon API';

	icon: Icon = { light: 'file:darkmoon.svg', dark: 'file:darkmoon.svg' };

	documentationUrl = 'https://github.com/ASCIT31/darkmoon-n8n#credentials';

	properties: INodeProperties[] = [
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: 'http://localhost:8000',
			placeholder: 'https://darkmoon.internal:8000',
			description:
				'Base URL of the Darkmoon Dashboard (Pro REST) API, with or without the /api/v1 suffix',
			required: true,
		},
		{
			displayName: 'Authentication',
			name: 'authMethod',
			type: 'options',
			default: 'token',
			options: [
				{
					name: 'API Token (Bearer)',
					value: 'token',
					description: 'Recommended. A Darkmoon Pro bearer token is stored and sent as a header.',
				},
				{
					name: 'Username and Password',
					value: 'password',
					description: 'The node logs in at run time and caches the short-lived JWT in memory.',
				},
			],
		},
		{
			displayName: 'API Token',
			name: 'token',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			description: 'Darkmoon Pro bearer token. Never logged; stored encrypted by n8n.',
			displayOptions: { show: { authMethod: ['token'] } },
		},
		{
			displayName: 'Username',
			name: 'username',
			type: 'string',
			default: 'admin',
			displayOptions: { show: { authMethod: ['password'] } },
		},
		{
			displayName: 'Password',
			name: 'password',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			displayOptions: { show: { authMethod: ['password'] } },
		},
	];

	// Inject the bearer token on every request when token auth is selected.
	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.token}}',
			},
		},
	};

	// The "Test" button confirms the Base URL is a reachable Darkmoon API
	// (GET /api/v1/system/info returns 200 with edition + contract version).
	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.baseUrl}}',
			url: '/api/v1/system/info',
			method: 'GET',
		},
	};
}
