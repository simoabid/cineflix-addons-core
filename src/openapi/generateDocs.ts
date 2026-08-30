import { promises as fs } from 'node:fs';
import { buildOpenApiSpec, toYaml } from './spec.js';

async function generate() {
    const spec = buildOpenApiSpec();
    const yaml = toYaml(spec);

    await fs.mkdir('./docs', { recursive: true });
    await fs.writeFile(
        './docs/openapi.json',
        JSON.stringify(spec, null, 2),
        'utf-8'
    );
    await fs.writeFile('./docs/openapi.yaml', yaml, 'utf-8');
    console.log('[openapi] generated docs/openapi.json and docs/openapi.yaml');
}

generate().catch(console.error);
