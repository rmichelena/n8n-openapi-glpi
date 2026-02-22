import {
  INodeType,
  INodeTypeDescription,
  IExecuteFunctions,
  INodeExecutionData,
  IHttpRequestOptions,
  IDataObject,
  NodeOperationError,
} from 'n8n-workflow';
import {
  N8NPropertiesBuilder,
  N8NPropertiesBuilderConfig,
  DefaultOperationParser,
  OperationContext,
} from '@devlikeapro/n8n-openapi-node';
import * as doc from './openapi.json';

/**
 * GLPI Node for n8n
 * This node provides integration with GLPI (Gestionnaire Libre de Parc Informatique)
 * IT Asset Management and Helpdesk System
 */

// Ensure option values match the displayed operation names so displayOptions work correctly
class OperationParser extends DefaultOperationParser {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  value(operation: any, context: OperationContext): string {
    return this.name(operation, context);
  }
}

// Configuration for the OpenAPI properties builder
const config: N8NPropertiesBuilderConfig = {
  operation: new OperationParser(),
};

// Create the properties builder instance with our OpenAPI document
const parser = new N8NPropertiesBuilder(doc, config);

// Generate all the properties (fields, operations, etc.) from the OpenAPI spec
const properties = parser.build();

// Returns true for values that should be omitted from body/query params.
// n8n serializes uncompleted JSON fields as strings like "{}" or "[\n  {}\n]"
// before they reach execute(), so we must handle both raw and stringified forms.
const isEmptyValue = (val: unknown): boolean => {
  if (val === undefined || val === null || val === '' || val === 0) return true;
  if (typeof val === 'string') {
    const t = val.trim();
    if (t === '{}' || t === '[]') return true;
    try { return isEmptyValue(JSON.parse(t)); } catch {}
  }
  if (Array.isArray(val)) {
    return val.length === 0 ||
      val.every(v => typeof v === 'object' && v !== null && Object.keys(v).length === 0);
  }
  if (typeof val === 'object') {
    return Object.keys(val as object).length === 0;
  }
  return false;
};

export class Glpi implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'GLPI',
    name: 'glpi',
    icon: 'file:glpi.svg',
    group: ['transform'],
    version: 1,
    subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
    description: 'Interact with GLPI - IT Asset Management and Helpdesk System',
    defaults: {
      name: 'GLPI',
    },
    inputs: ['main'],
    outputs: ['main'],
    credentials: [
      {
        name: 'glpiOAuth2Api',
        required: true,
      },
    ],
    requestDefaults: {
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      baseURL: '={{$credentials.glpiUrl}}/api.php',
    },
    properties: properties,
		usableAsTool: true,
  };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const items = this.getInputData();
    const returnData: INodeExecutionData[] = [];

    for (let i = 0; i < items.length; i++) {
      try {
        // Get the operation parameter from the OpenAPI-generated properties
        const operation = this.getNodeParameter('operation', i) as string;

        // Parse the operation to extract HTTP method and path.
        // The OperationParser makes value() === name(), so the format is e.g. "GET /Assistance/Ticket".
        // pathPart already starts with '/', so we must not prepend another '/'.
        const operationParts = operation.split(' ');
        const method = operationParts[0] as string;
        const pathPart = operationParts[1] || '';
        let path = pathPart.startsWith('/') ? pathPart : '/' + pathPart.replace(/-/g, '/');

        // Replace path parameters (e.g., {id}, {name}) with actual values
        const pathParamRegex = /\{([^}]+)\}/g;
        let match;
        while ((match = pathParamRegex.exec(path)) !== null) {
          const paramName = match[1];
          try {
            const paramValue = this.getNodeParameter(paramName, i) as string;
            path = path.replace(`{${paramName}}`, encodeURIComponent(paramValue));
          } catch {
            // Parameter not found, leave as is
          }
        }

        // Build the request options
        // Note: url is just the path, baseURL is set in requestDefaults
        const requestOptions: IHttpRequestOptions = {
          method: method as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
          url: path,
          headers: {
            'Accept': 'application/json',
          },
        };

        // Add Content-Type header and body for methods that support it
        if (['POST', 'PUT', 'PATCH'].includes(method)) {
          requestOptions.headers!['Content-Type'] = 'application/json';

          // Build body from OpenAPI-generated fields with routing.send.type === 'body'.
          // The builder creates one field per body property (e.g. name, content, status),
          // not a single 'requestBody' aggregate object.
          const bodyData: IDataObject = {};
          for (const prop of properties) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const propConfig = prop as any;
            const routing = propConfig.routing;
            if (routing?.send?.type === 'body') {
              const supportedOperations = propConfig.displayOptions?.show?.operation;
              if (Array.isArray(supportedOperations) && !supportedOperations.includes(operation)) {
                continue;
              }
              try {
                const value = this.getNodeParameter(prop.name, i);
                if (!isEmptyValue(value)) {
                  const bodyKey: string = routing.send.property ?? prop.name;
                  bodyData[bodyKey] = value;
                }
              } catch {
                // Property not applicable to this operation
              }
            }
          }
          if (Object.keys(bodyData).length > 0) {
            requestOptions.body = bodyData;
          }
        }

        // Add query parameters from the OpenAPI-generated fields.
        // The builder creates one field per query param (e.g. filter/start/limit/sort),
        // not a single "queryParameters" aggregate object.
        const queryParams: IDataObject = {};
        for (const prop of properties) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const propConfig = prop as any;
          const routing = propConfig.routing;
          if (routing?.send?.type === 'query') {
            const supportedOperations = propConfig.displayOptions?.show?.operation;
            if (Array.isArray(supportedOperations) && !supportedOperations.includes(operation)) {
              continue;
            }

            try {
              const value = this.getNodeParameter(prop.name, i);
              if (!isEmptyValue(value)) {
                const queryKey: string = routing.send.property ?? prop.name;
                queryParams[queryKey] = value;
              }
            } catch {
              // Property not applicable to this operation
            }
          }
        }
        if (Object.keys(queryParams).length > 0) {
          requestOptions.qs = queryParams;
        }

        // Add header parameters from OpenAPI spec (GLPI-specific headers)
        const headerParams = ['Accept-Language', 'GLPI-Entity', 'GLPI-Profile', 'GLPI-Entity-Recursive'];
        for (const headerName of headerParams) {
          try {
            const headerValue = this.getNodeParameter(headerName, i);
            if (headerValue !== undefined && headerValue !== null && headerValue !== '') {
              requestOptions.headers![headerName] = String(headerValue);
            }
          } catch {
            // Header parameter doesn't exist for this operation
          }
        }

        // Get credentials for OAuth2 authentication
        const credentials = await this.getCredentials('glpiOAuth2Api');

        // Get or refresh OAuth2 token manually
        let accessToken = '';
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const tokenData = credentials.oauthTokenData as any;

        // Check if we have a valid token
        if (tokenData && tokenData.access_token && tokenData.expires_at) {
          const now = Math.floor(Date.now() / 1000);
          if (tokenData.expires_at > now) {
            // Token is still valid
            accessToken = tokenData.access_token;
          }
        }

        // If no valid token, get a new one
        if (!accessToken) {
          try {
            const tokenResponse = await this.helpers.httpRequest({
              method: 'POST',
              url: credentials.accessTokenUrl as string,
              auth: {
                username: credentials.clientId as string,
                password: credentials.clientSecret as string,
              },
              body: {
                grant_type: 'password',
                username: credentials.username,
                password: credentials.password,
                scope: credentials.scope,
              },
              headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
              },
              json: true,
            });

            accessToken = tokenResponse.access_token;

            // TODO: Save token back to credentials for caching
            // This would require updating the credential, which is complex
          } catch (error) {
            const errorMessage = `OAuth2 token request failed: ${error instanceof Error ? error.message : String(error)}`;
            throw new NodeOperationError(this.getNode(), errorMessage);
          }
        }

        // Add the access token to the request
        requestOptions.headers!['Authorization'] = `Bearer ${accessToken}`;

        // Build full URL
        const fullUrl = `${credentials.glpiUrl}/api.php${path}`;
        requestOptions.url = fullUrl;

        // Ensure response is parsed as JSON
        requestOptions.json = true;

        // Execute the request with the access token
        const response = await this.helpers.httpRequest(requestOptions);

        // Handle the response
        if (Array.isArray(response)) {
          returnData.push(...response.map(item => ({ json: item })));
        } else {
          returnData.push({ json: response });
        }
      } catch (error) {
        if (this.continueOnFail()) {
          returnData.push({
            json: {
              error: error instanceof Error ? error.message : String(error),
            },
          });
          continue;
        }
        throw error;
      }
    }

    return [returnData];
  }
}
