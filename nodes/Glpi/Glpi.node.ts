import {
  INodeType,
  INodeTypeDescription,
  IExecuteFunctions,
  INodeExecutionData,
  IHttpRequestOptions,
  IDataObject,
  NodeOperationError,
  INodeProperties,
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

// Ensure operation values always follow "METHOD /path" format, regardless of
// whether the OpenAPI spec has operationIds. DefaultOperationParser.name() falls back to
// lodash.startCase(operationId) when an operationId is present, producing e.g.
// "Get Ticket By Id" instead of "GET /Assistance/Ticket/{id}". Overriding name() here
// guarantees execute() can always split on the first space to get method and path.
class OperationParser extends DefaultOperationParser {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  name(operation: any, context: OperationContext): string {
    return context.method.toUpperCase() + ' ' + context.pattern;
  }
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

// Pre-index routable properties (body/query/header) by operation value so that
// execute() can look them up in O(1) instead of scanning all properties on every call.
// The OpenAPI spec generates thousands of properties; iterating them all per item
// would make execution noticeably slow.
const operationPropertiesMap = new Map<string, INodeProperties[]>();
for (const prop of properties) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const routing = (prop as any).routing;
  const sendType: string | undefined = routing?.send?.type;
  if (!sendType || !['body', 'query', 'header'].includes(sendType)) continue;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ops: unknown = (prop as any).displayOptions?.show?.operation;
  if (!Array.isArray(ops)) continue;
  for (const op of ops as string[]) {
    if (!operationPropertiesMap.has(op)) operationPropertiesMap.set(op, []);
    operationPropertiesMap.get(op)!.push(prop);
  }
}

// Returns true for values that should be omitted from body/query params.
// n8n serializes uncompleted JSON fields as strings like "{}" or "[\n  {}\n]"
// before they reach execute(), so we must handle both raw and stringified forms.
const isEmptyValue = (val: unknown): boolean => {
  // Do NOT treat 0 as empty: it is a valid value in many GLPI fields
  // (e.g. entity=0 is the root entity, start=0 for pagination).
  if (val === undefined || val === null || val === '') return true;
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
    properties: properties,
    usableAsTool: true,
  };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const items = this.getInputData();
    const returnData: INodeExecutionData[] = [];

    // Read credentials once and obtain an OAuth2 access token before the item loop.
    // n8n's httpRequestWithAuthentication requires a token already stored in the credential
    // store (populated by clicking "Connect" in the UI). For GLPI's password grant there is
    // no browser consent screen and n8n does not auto-fetch the token, so we do it manually.
    // The token is fetched once and reused for all items in this execution.
    const credentials = await this.getCredentials('glpiOAuth2Api');
    const baseUrl = (credentials.glpiUrl as string).replace(/\/+$/, '');
    const tokenUrl = `${baseUrl}/api.php/token`;

    // Serialize body as a URL-encoded string to guarantee correct Content-Type handling
    // regardless of the n8n version (avoids ambiguity of object body + json:true).
    const tokenBodyEntries: Record<string, string> = {
      grant_type: 'password',
      username: credentials.username as string,
      password: credentials.password as string,
      scope: (credentials.scope as string) || 'api',
    };
    // Include client credentials only when provided (public clients omit them).
    if (credentials.clientId) tokenBodyEntries.client_id = credentials.clientId as string;
    if (credentials.clientSecret) tokenBodyEntries.client_secret = credentials.clientSecret as string;

    const tokenResponse = await this.helpers.httpRequest({
      method: 'POST',
      url: tokenUrl,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(tokenBodyEntries).toString(),
      json: true,
      skipSslCertificateValidation: !!(credentials.ignoreSSLIssues),
    });

    const accessToken = tokenResponse.access_token as string;
    if (!accessToken) {
      throw new NodeOperationError(
        this.getNode(),
        'OAuth2 token request succeeded but returned no access_token. Check GLPI credentials.',
      );
    }

    for (let i = 0; i < items.length; i++) {
      try {
        const operation = this.getNodeParameter('operation', i) as string;

        // OperationParser guarantees format "METHOD /path" (e.g. "GET /Assistance/Ticket").
        const operationParts = operation.split(' ');
        const method = operationParts[0];
        const pathPart = operationParts[1] || '';

        const validMethods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
        if (!validMethods.includes(method)) {
          throw new NodeOperationError(this.getNode(), `Invalid HTTP method parsed from operation: "${method}"`);
        }

        // Build path — OperationParser uses context.pattern which always starts with '/'.
        let path = pathPart.startsWith('/') ? pathPart : '/' + pathPart;

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
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${accessToken}`,
          },
          json: true,
          skipSslCertificateValidation: !!(credentials.ignoreSSLIssues),
        };

        // Use the pre-indexed map: O(1) lookup per operation instead of O(n) scan.
        const operationProps = operationPropertiesMap.get(operation) ?? [];
        const bodyData: IDataObject = {};
        const queryParams: IDataObject = {};

        for (const prop of operationProps) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const routing = (prop as any).routing;
          const sendType: string = routing.send.type;

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
          } catch (error) {
            // Re-throw real evaluation errors (e.g. invalid expression, type mismatch)
            // so they surface with a useful message instead of silently dropping the field.
            // Only swallow soft "parameter not available in this context" failures.
            if (error instanceof NodeOperationError) throw error;
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

        const response = await this.helpers.httpRequest(requestOptions);

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
