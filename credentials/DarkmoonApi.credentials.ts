import type {
	IAuthenticateGeneric,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

/**
 * Darkmoon Dashboard API credentials.
 *
 * Darkmoon issues a short-lived JWT from POST /api/v1/auth/login. The node
 * performs that login at run time (a static token cannot be stored because it
 * expires), so this credential holds the base URL and the dashboard username /
 * password. The `test` request validates them against the real login endpoint.
 */
export class DarkmoonApi implements ICredentialType {
	name = 'darkmoonApi';

	displayName = 'Darkmoon API';

	documentationUrl = 'https://github.com/ASCIT31/n8n-nodes-darkmoon#credentials';

	properties: INodeProperties[] = [
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: 'http://localhost:8000',
			placeholder: 'http://darkmoon.internal:8000',
			description:
				'Base URL of the Darkmoon Dashboard API (the FastAPI service, typically on port 8000)',
			required: true,
		},
		{
			displayName: 'Username',
			name: 'username',
			type: 'string',
			default: 'admin',
			required: true,
		},
		{
			displayName: 'Password',
			name: 'password',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
		},
	];

	// Sends the credentials in the login request body for the credential test.
	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			body: {
				username: '={{$credentials.username}}',
				password: '={{$credentials.password}}',
			},
		},
	};

	// n8n's "Test" button hits the real login endpoint; a 200 means valid creds.
	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.baseUrl}}',
			url: '/api/v1/auth/login',
			method: 'POST',
			body: {
				username: '={{$credentials.username}}',
				password: '={{$credentials.password}}',
			},
		},
	};
}
