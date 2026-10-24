import { readFileSync } from 'node:fs';
import { Router } from 'express';
import swaggerUi from 'swagger-ui-express';

/** Interactive API reference (non-production only). Source of truth: docs/openapi.yaml. */
export function docsRoutes(): Router {
  const r = Router();
  let spec: string | null = null;
  try {
    spec = readFileSync(new URL('../../../docs/openapi.yaml', import.meta.url), 'utf8');
  } catch {
    spec = null;
  }
  r.get('/openapi.yaml', (_req, res) => {
    if (!spec) {
      res.status(404).end();
      return;
    }
    res.type('application/yaml').send(spec);
  });
  r.use(
    '/',
    swaggerUi.serve,
    swaggerUi.setup(undefined, {
      swaggerOptions: { url: '/docs/openapi.yaml' },
      customSiteTitle: 'BigBoss Live API',
    }),
  );
  return r;
}
