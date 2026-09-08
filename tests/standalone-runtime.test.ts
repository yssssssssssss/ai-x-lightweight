import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

test('production app serves Web and API from one origin without swallowing API 404s', async () => {
  const webRoot = mkdtempSync(join(tmpdir(), 'ai-x-lightweight-web-'));
  mkdirSync(join(webRoot, 'assets'));
  writeFileSync(join(webRoot, 'index.html'), '<!doctype html><title>Standalone</title>');
  writeFileSync(join(webRoot, 'assets', 'app.js'), 'console.log("standalone")');
  process.env.JWT_SECRET = 'standalone-runtime-test-secret';

  const [{ createAgentApiApp }, { closePool }] = await Promise.all([
    import('../apps/agent-api/src/server.ts'),
    import('../database/db.ts'),
  ]);
  const server = createServer(createAgentApiApp({ webDistDir: webRoot }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const root = await fetch(`${baseUrl}/`);
    assert.equal(root.status, 200);
    assert.match(await root.text(), /Standalone/u);
    assert.equal(root.headers.get('cache-control'), 'no-cache');

    const deepLink = await fetch(`${baseUrl}/tasks/example`);
    assert.equal(deepLink.status, 200);
    assert.match(await deepLink.text(), /Standalone/u);

    const asset = await fetch(`${baseUrl}/assets/app.js`);
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get('cache-control') ?? '', /immutable/u);

    const health = await fetch(`${baseUrl}/api/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });

    const missingApi = await fetch(`${baseUrl}/api/not-found`);
    assert.equal(missingApi.status, 404);
    assert.doesNotMatch(await missingApi.text(), /Standalone/u);
  } finally {
    server.close();
    await once(server, 'close');
    await closePool();
    rmSync(webRoot, { recursive: true, force: true });
  }
});
