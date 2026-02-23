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

    // Read credentials once — URL only. Token lifecycle (obtain, cache, refresh)
    // is handled entirely by httpRequestWithAuthentication via the glpiOAuth2Api credential.
    const credentials = await this.getCredentials('glpiOAuth2Api');
    const baseUrl = (credentials.glpiUrl as string).replace(/\/+$/, '');

    for (let i = 0; i < items.length; i++) {
      try {
        const operation = this.getNodeParameter('operation', i) as string;

        // The OperationParser makes value() === name(), producing e.g. "GET /Assistance/Ticket".
        const operationParts = operation.split(' ');
        const method = operationParts[0];
        const pathPart = operationParts[1] || '';

        const validMethods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
        if (!validMethods.includes(method)) {
          throw new NodeOperationError(this.getNode(), `Invalid HTTP method parsed from operation: "${method}"`);
        }

        // Build path — pathPart already starts with '/' when coming from the name()-based parser.
        let path = pathPart.startsWith('/') ? pathPart : '/' + pathPart.replace(/-/g, '/');

        // Replace path parameters using replace+callback to avoid the lastIndex/mutation bug
        // that a while+exec loop with a stateful /g regex would produce.
        path = path.replace(/\{([^}]+)\}/g, (placeholder, paramName: string) => {
          try {
            return encodeURIComponent(this.getNodeParameter(paramName, i) as string);
          } catch {
            return placeholder;
          }
        });

        // Fail loudly if any path parameter went unresolved — a silent {id} in the URL
        // produces a cryptic 404 that is very hard to debug.
        const unresolved = path.match(/\{[^}]+\}/g);
        if (unresolved) {
          throw new NodeOperationError(
            this.getNode(),
            `Missing required path parameter(s): ${unresolved.join(', ')}`,
          );
        }

        const requestOptions: IHttpRequestOptions = {
          method: method as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
          url: `${baseUrl}/api.php${path}`,
          headers: { Accept: 'application/json' },
          json: true,
        };

        // Collect body / query / header params by reading each OpenAPI-generated property
        // that has routing.send metadata. The builder never creates aggregate objects like
        // 'requestBody' or 'queryParameters' — every field is its own property.
        const bodyData: IDataObject = {};
        const queryParams: IDataObject = {};

        for (const prop of properties) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const routing = (prop as any).routing;
          const sendType: string | undefined = routing?.send?.type;
          if (!sendType || !['body', 'query', 'header'].includes(sendType)) continue;

          // Skip properties that belong to a different operation.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const supported = (prop as any).displayOptions?.show?.operation;
          if (Array.isArray(supported) && !supported.includes(operation)) continue;

          try {
            const value = this.getNodeParameter(prop.name, i);
            if (isEmptyValue(value)) continue;

            const key: string = routing.send.property ?? prop.name;

            if (sendType === 'body') {
              bodyData[key] = value;
            } else if (sendType === 'query') {
              queryParams[key] = value;
            } else {
              // header — use the real header name from the spec, not the property name
              requestOptions.headers![key] = String(value);
            }
          } catch {
            // Property not applicable to this operation — safe to skip
          }
        }

        if (['POST', 'PUT', 'PATCH'].includes(method)) {
          requestOptions.headers!['Content-Type'] = 'application/json';
          if (Object.keys(bodyData).length > 0) {
            requestOptions.body = bodyData;
          }
        }

        if (Object.keys(queryParams).length > 0) {
          requestOptions.qs = queryParams;
        }

        // Let n8n handle OAuth2: token acquisition (password grant), caching,
        // refresh on expiry, SSL settings from the credential, and Basic Auth
        // vs body placement of client_id/client_secret per the credential config.
        const response = await this.helpers.httpRequestWithAuthentication(
          'glpiOAuth2Api',
          requestOptions,
        );

        if (Array.isArray(response)) {
          returnData.push(...response.map((item) => ({ json: item })));
        } else {
          returnData.push({ json: response as IDataObject });
        }
      } catch (error) {
        if (this.continueOnFail()) {
          returnData.push({
            json: { error: error instanceof Error ? error.message : String(error) },
          });
          continue;
        }
        throw error;
      }
    }

    return [returnData];
  }
}
