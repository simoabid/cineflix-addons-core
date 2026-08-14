/**
 * OpenAPI documentation routes for addons-core.
 *
 *   GET /v1/openapi.json  - OpenAPI 3.1 schema specification (JSON)
 *   GET /v1/openapi.yaml  - OpenAPI 3.1 schema specification (YAML)
 *   GET /v1/docs          - Interactive Swagger / Scalar API documentation explorer
 */

import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../config.js';
import { buildOpenApiSpec, toYaml } from '../openapi/spec.js';

export function registerOpenApiRoutes(
    app: FastifyInstance,
    cfg: AppConfig,
    publicUrl: string
): void {
    const spec = buildOpenApiSpec(publicUrl);
    const yamlContent = toYaml(spec);

    app.get('/v1/openapi.json', async (_req, reply) => {
        return reply
            .header('Content-Type', 'application/json; charset=utf-8')
            .header('Cache-Control', 'public, max-age=3600')
            .code(200)
            .send(spec);
    });

    app.get('/v1/openapi.yaml', async (_req, reply) => {
        return reply
            .header('Content-Type', 'text/yaml; charset=utf-8')
            .header('Cache-Control', 'public, max-age=3600')
            .code(200)
            .send(yamlContent);
    });

    app.get('/v1/docs', async (_req, reply) => {
        const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>addons-core API Documentation</title>
    <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5.11.0/swagger-ui.css" />
    <style>
        body { margin: 0; background: #0f172a; color: #f8fafc; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
        .topbar { display: none; }
        .swagger-ui .info .title { color: #38bdf8; }
        .swagger-ui .scheme-container { background: #1e293b; box-shadow: none; border-bottom: 1px solid #334155; }
        .swagger-ui .opblock { border-radius: 8px; box-shadow: none; margin-bottom: 12px; }
        .swagger-ui select { background: #1e293b; color: #f8fafc; border: 1px solid #475569; }
        .swagger-ui input[type=text] { background: #1e293b; color: #f8fafc; border: 1px solid #475569; }
        .swagger-ui .btn { border-radius: 6px; }
    </style>
</head>
<body>
    <div id="swagger-ui"></div>
    <script src="https://unpkg.com/swagger-ui-dist@5.11.0/swagger-ui-bundle.js" crossorigin></script>
    <script>
        window.onload = () => {
            window.ui = SwaggerUIBundle({
                url: '/v1/openapi.json',
                dom_id: '#swagger-ui',
                deepLinking: true,
                presets: [
                    SwaggerUIBundle.presets.apis,
                    SwaggerUIBundle.SwaggerUIStandalonePreset
                ],
                layout: "BaseLayout"
            });
        };
    </script>
</body>
</html>`;

        return reply
            .header('Content-Type', 'text/html; charset=utf-8')
            .header('Cache-Control', 'public, max-age=3600')
            .code(200)
            .send(html);
    });
}
