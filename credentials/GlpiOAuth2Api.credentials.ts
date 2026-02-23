import {
  ICredentialType,
  INodeProperties,
  Icon,
} from 'n8n-workflow';

/**
 * GLPI API Credentials for GLPI 11+
 *
 * Authentication is handled entirely by the node using OAuth2 password grant.
 * We do NOT extend oAuth2Api because:
 *   1. Password grant has no browser consent screen, so there is no "Connect" flow.
 *   2. n8n's httpRequestWithAuthentication requires a pre-stored token (oauthTokenData)
 *      that is only written after the user clicks "Connect" — which never appears for
 *      password grant in current n8n versions.
 * The node fetches the token manually at execution time and injects it as a Bearer header.
 */
export class GlpiOAuth2Api implements ICredentialType {
  name = 'glpiOAuth2Api';
  displayName = 'GLPI API';
  documentationUrl = 'https://glpi-developer-documentation.readthedocs.io/en/latest/devapi/hlapi/';
  icon: Icon = { light: 'file:../icons/glpi_white.svg', dark: 'file:../icons/glpi_color.svg' };

  properties: INodeProperties[] = [
    {
      displayName: 'GLPI URL',
      name: 'glpiUrl',
      type: 'string',
      default: '',
      placeholder: 'https://your-glpi.example.com',
      description: 'Base URL of your GLPI installation (without trailing slash)',
      required: true,
    },
    {
      displayName: 'Username',
      name: 'username',
      type: 'string',
      default: '',
      description: 'GLPI username',
      required: true,
    },
    {
      displayName: 'Password',
      name: 'password',
      type: 'string',
      typeOptions: {
        password: true,
      },
      default: '',
      description: 'GLPI password',
      required: true,
    },
    {
      displayName: 'Client ID',
      name: 'clientId',
      type: 'string',
      default: '',
      description: 'OAuth2 Client ID (optional — leave empty for public GLPI clients)',
    },
    {
      displayName: 'Client Secret',
      name: 'clientSecret',
      type: 'string',
      typeOptions: {
        password: true,
      },
      default: '',
      description: 'OAuth2 Client Secret (optional — leave empty for public GLPI clients)',
    },
    {
      displayName: 'Scope',
      name: 'scope',
      type: 'hidden',
      default: 'api',
    },
    {
      displayName: 'Ignore SSL Issues',
      name: 'ignoreSSLIssues',
      type: 'boolean',
      default: false,
      description: 'Whether to ignore SSL certificate validation errors (useful for self-signed certificates)',
    },
  ];
}
