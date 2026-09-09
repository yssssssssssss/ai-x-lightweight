import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { afterEach, test } from 'node:test';
import { chromium, type Page } from 'playwright';
import { BrowserExecutionGate } from '../apps/orchestrator-runtime/src/runtime/browser-execution-gate.ts';
import { PublicWebAccessError } from '../apps/orchestrator-runtime/src/runtime/public-web-access-policy.ts';
import {
  PlaywrightPageCaptureAdapter,
  capturePageVisual,
  validateBrowserTarget,
  type PlaywrightLauncher,
} from '../apps/orchestrator-runtime/src/runtime/playwright-page-capture-adapter.ts';
import { ToolInvocationError, type ToolInvocationContext } from '../apps/orchestrator-runtime/src/runtime/tool-adapter.ts';
import { ToolRouter } from '../apps/orchestrator-runtime/src/runtime/tool-adapter.ts';
import type { ToolManifest } from '../apps/orchestrator-runtime/src/runtime/config-loader.ts';
import { buildRuntime } from '../apps/orchestrator-runtime/src/runtime/agent-runtime.ts';

const ORIGINAL_ENV = { ...process.env };
afterEach(() => { process.env = { ...ORIGINAL_ENV }; });

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

const manifest: ToolManifest = {
  id: 'playwright-page-capture',
  name: 'Playwright page capture',
  adapter_type: 'playwright',
  auth_required: false,
  risk_level: 'medium',
  timeout_seconds: 90,
  retry_policy: { max_attempts: 2, backoff_seconds: 1 },
  input_schema: 'tools/playwright-page-capture/input.schema.json',
  output_schema: 'tools/playwright-page-capture/output.schema.json',
};

function invocationContext(signal = new AbortController().signal): ToolInvocationContext {
  return { signal, deadlineAt: Date.now() + 90_000 };
}

function fakeLauncher(
  events: string[],
  captured: { launch?: object; context?: object },
  options: {
    bodyText?: string;
    pageUrl?: string;
    onGoto?: () => void;
    failBrowserClose?: boolean;
    triggerPopup?: boolean;
    triggerPopupOnClose?: boolean;
    triggerDownload?: boolean;
    disconnectControl?: { disconnect?: () => void };
    closeDelayMs?: number;
  } = {},
): PlaywrightLauncher {
  let connected = true;
  const waitForCloseDelay = () => options.closeDelayMs
    ? new Promise<void>((resolve) => setTimeout(resolve, options.closeDelayMs))
    : Promise.resolve();
  const handlers = new Map<string, (value: { close(): Promise<void>; cancel(): Promise<void> }) => void>();
  const page = {
    goto: async () => {
      options.onGoto?.();
      if (options.triggerPopup) {
        handlers.get('popup')?.({
          close: async () => { events.push('popup.close'); },
          cancel: async () => undefined,
        });
      }
      if (options.triggerDownload) {
        handlers.get('download')?.({
          close: async () => undefined,
          cancel: async () => { events.push('download.cancel'); },
        });
      }
      return { status: () => 200, headers: () => ({ 'content-type': 'text/html' }) };
    },
    url: () => options.pageUrl ?? 'https://example.com/product',
    title: async () => 'Example product',
    evaluate: async (fn: unknown) => {
      const source = String(fn);
      if (source.includes('innerText')) return options.bodyText ?? '';
      return { width: 1, height: 1 };
    },
    screenshot: async () => PNG_1X1,
    close: async () => {
      if (options.triggerPopupOnClose) {
        handlers.get('popup')?.({
          close: async () => { events.push('popup.close'); },
          cancel: async () => undefined,
        });
      }
      await waitForCloseDelay();
      events.push('page.close');
    },
    on: (event: string, handler: (value: { close(): Promise<void>; cancel(): Promise<void> }) => void) => {
      handlers.set(event, handler);
    },
  };
  const context = {
    route: async () => { events.push('context.route'); },
    routeWebSocket: async () => { events.push('context.routeWebSocket'); },
    on: () => undefined,
    newPage: async () => page,
    close: async () => { await waitForCloseDelay(); events.push('context.close'); },
  };
  return {
    launch: async (launchOptions: Parameters<PlaywrightLauncher['launch']>[0]) => {
      captured.launch = launchOptions;
      return {
        newContext: async (contextOptions: object) => {
          captured.context = contextOptions;
          return context;
        },
        close: async () => {
          await waitForCloseDelay();
          events.push('browser.close');
          if (options.failBrowserClose) throw new Error('browser close failed');
          connected = false;
        },
        once: (event: string, handler: () => void) => {
          if (event === 'disconnected' && options.disconnectControl) {
            options.disconnectControl.disconnect = () => {
              connected = false;
              handler();
            };
          }
        },
        isConnected: () => connected,
      };
    },
  } as unknown as PlaywrightLauncher;
}

async function toolError(promise: Promise<unknown>): Promise<ToolInvocationError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof ToolInvocationError);
    return error;
  }
  assert.fail('expected ToolInvocationError');
}

type TestRouteHandler = (route: {
  request(): {
    method(): string;
    url(): string;
    isNavigationRequest(): boolean;
    frame(): { page(): object };
  };
  continue(): Promise<void>;
  abort(): Promise<void>;
}) => Promise<void>;

function failingRouteLauncher(routeUrl: string): PlaywrightLauncher {
  let routeHandler: TestRouteHandler | undefined;
  let connected = true;
  const page = {
    goto: async () => {
      assert.ok(routeHandler);
      await routeHandler({
        request: () => ({
          method: () => 'GET',
          url: () => routeUrl,
          isNavigationRequest: () => false,
          frame: () => ({ page: () => page }),
        }),
        continue: async () => undefined,
        abort: async () => undefined,
      });
      throw new Error('net::ERR_FAILED');
    },
    close: async () => undefined,
    on: () => undefined,
  };
  return {
    launch: async () => ({
      newContext: async () => ({
        route: async (_pattern: string, handler: TestRouteHandler) => { routeHandler = handler; },
        routeWebSocket: async () => undefined,
        newPage: async () => page,
        close: async () => undefined,
      }),
      close: async () => { connected = false; },
      isConnected: () => connected,
    }),
  } as unknown as PlaywrightLauncher;
}

test('browser URL policy rejects unsafe targets and fragments without exposing fragment data', async () => {
  const publicDns = async () => ['93.184.216.34'];
  await assert.rejects(
    () => validateBrowserTarget('https://example.com/path#access_token=secret', publicDns),
    (error: unknown) => {
      assert.ok(error instanceof PublicWebAccessError);
      assert.match(error.message, /fragment/i);
      assert.equal(error.safeUrl, 'https://example.com/path');
      assert.doesNotMatch(error.safeUrl, /access_token|secret|#/i);
      return true;
    },
  );
  await assert.rejects(() => validateBrowserTarget('http://example.com', publicDns), /HTTPS/i);
  await assert.rejects(() => validateBrowserTarget('https://example.com:8443', publicDns), /port/i);
  await assert.rejects(() => validateBrowserTarget('https://user:pass@example.com', publicDns), /credentials/i);
  await assert.rejects(
    () => validateBrowserTarget('https://example.com/image?session_token=secret', publicDns),
    /credential/i,
  );
  await assert.rejects(
    () => validateBrowserTarget('https://metadata.example.test/latest', async () => ['169.254.169.254']),
    /public|private|metadata|address/i,
  );
  await assert.rejects(
    () => validateBrowserTarget('https://tunnel.example.test', async () => ['2002:c000:0204::1']),
    /public|reserved|address/i,
  );
});

test('capture modes keep CSS lineage honest and enforce pixel and byte bounds', async () => {
  const clips: Array<{ width: number; height: number }> = [];
  const elementLocator = {
    first() { return this; },
    count: async () => 1,
    isVisible: async () => true,
    boundingBox: async () => ({ x: 0, y: 0, width: 640, height: 360 }),
  };
  const elementPage = {
    locator: () => elementLocator,
    screenshot: async (options: { clip: { width: number; height: number } }) => {
      clips.push(options.clip);
      return PNG_1X1;
    },
  } as unknown as Page;
  const auto = await capturePageVisual(elementPage, {
    mode: 'auto',
    viewport: { width: 1440, height: 900 },
  });
  const element = await capturePageVisual(elementPage, {
    mode: 'element_screenshot',
    selector: '#hero',
    viewport: { width: 1440, height: 900 },
  });
  assert.equal(auto.captureMode, 'element_screenshot');
  assert.equal(auto.selector, 'main');
  assert.equal(element.selector, '#hero');

  const imagePage = {
    locator: () => ({
      evaluateAll: async () => 1,
      nth: () => ({ boundingBox: async () => ({ x: 0, y: 0, width: 800, height: 600 }) }),
    }),
    screenshot: async () => PNG_1X1,
  } as unknown as Page;
  const extracted = await capturePageVisual(imagePage, {
    mode: 'extracted_image',
    viewport: { width: 1440, height: 900 },
  });
  assert.equal(extracted.captureMode, 'extracted_image');
  assert.equal(extracted.selector, undefined);

  let fullPageClip: { width: number; height: number } | undefined;
  const fullPage = {
    evaluate: async () => ({ width: 50_000, height: 50_000 }),
    screenshot: async (options: { clip: { width: number; height: number } }) => {
      fullPageClip = options.clip;
      return PNG_1X1;
    },
  } as unknown as Page;
  const full = await capturePageVisual(fullPage, {
    mode: 'full_page_screenshot',
    viewport: { width: 1440, height: 900 },
  });
  assert.equal(full.truncated, true);
  assert.ok(fullPageClip);
  assert.ok(fullPageClip.width <= 12_000);
  assert.ok(fullPageClip.height <= 12_000);
  assert.ok(fullPageClip.width * fullPageClip.height <= 20_000_000);

  const oversizedPage = {
    locator: () => elementLocator,
    screenshot: async () => Buffer.alloc(10 * 1024 * 1024 + 1),
  } as unknown as Page;
  await assert.rejects(
    () => capturePageVisual(oversizedPage, {
      mode: 'element_screenshot',
      selector: '#hero',
      viewport: { width: 1440, height: 900 },
    }),
    /10 MiB/u,
  );
  assert.ok(clips.length >= 2);
});

test('invalid element selectors fail before Chromium starts', async () => {
  let launches = 0;
  const adapter = new PlaywrightPageCaptureAdapter({
    launcher: {
      launch: async () => {
        launches += 1;
        throw new Error('must not launch');
      },
    } as PlaywrightLauncher,
    getEffectiveUid: () => 501,
  });
  for (const capture of [
    { mode: 'element_screenshot' },
    { mode: 'element_screenshot', selector: 'x'.repeat(513) },
  ]) {
    const error = await toolError(adapter.invoke({
      toolId: manifest.id,
      manifest,
      context: invocationContext(),
      input: { pages: [{ url: 'https://example.com' }], capture },
    }));
    assert.equal(error.kind, 'schema');
  }
  assert.equal(launches, 0);
});

test('normalization records unsafe fallbacks while max_pages caps successful captures', async () => {
  const resolvedHosts: string[] = [];
  const adapter = new PlaywrightPageCaptureAdapter({
    launcher: fakeLauncher([], {}),
    resolveHost: async (hostname) => {
      resolvedHosts.push(hostname);
      return hostname === 'private.invalid' ? ['127.0.0.1'] : ['93.184.216.34'];
    },
    getEffectiveUid: () => 501,
  });
  const truncated = await adapter.invoke({
    toolId: manifest.id,
    manifest,
    context: invocationContext(),
    input: {
      pages: [
        { url: 'https://example.com/product' },
        { url: 'https://private.invalid/should-not-resolve' },
      ],
      capture: { mode: 'full_page_screenshot', max_pages: 1 },
    },
  });
  assert.equal(truncated.mediaAttachments?.length, 1);
  assert.equal(resolvedHosts.includes('private.invalid'), true);
  const fallbackFailures = (truncated.output as {
    failures: Array<{
      source_result_index: number;
      requested_url: string;
      code: string;
      sanitized_message: string;
    }>;
  }).failures;
  assert.equal(fallbackFailures.length, 1);
  const fallbackFailure = fallbackFailures[0]!;
  assert.equal(fallbackFailure.source_result_index, 1);
  assert.equal(fallbackFailure.requested_url, 'https://private.invalid/should-not-resolve');
  assert.equal(fallbackFailure.code, 'unsupported_content');
  assert.match(fallbackFailure.sanitized_message, /public addresses.*forbidden/u);

  const mixed = await adapter.invoke({
    toolId: manifest.id,
    manifest,
    context: invocationContext(),
    input: {
      pages: [
        { url: 'file:///etc/passwd' },
        { url: 'https://example.com/product' },
      ],
      capture: { mode: 'full_page_screenshot', max_pages: 2 },
    },
  });
  const failure = (mixed.output as { failures: Array<{ requested_url: string }> }).failures[0];
  assert.equal(failure?.requested_url, 'https://invalid.invalid/');
  assert.doesNotThrow(() => new URL(failure!.requested_url));
});

test('max_pages counts successful captures and continues through fallback candidates', async () => {
  const attemptedUrls: string[] = [];
  let connected = true;
  const launcher = {
    launch: async () => ({
      newContext: async () => ({
        route: async () => undefined,
        routeWebSocket: async () => undefined,
        on: () => undefined,
        newPage: async () => {
          let currentUrl = 'about:blank';
          return {
            goto: async (url: string) => {
              attemptedUrls.push(url);
              currentUrl = url;
              if (url.includes('/fails')) throw new Error('navigation failed');
              return { status: () => 200, headers: () => ({ 'content-type': 'text/html' }) };
            },
            url: () => currentUrl,
            title: async () => 'Captured page',
            evaluate: async (fn: unknown) => String(fn).includes('innerText')
              ? ''
              : { width: 1, height: 1 },
            screenshot: async () => PNG_1X1,
            close: async () => undefined,
            on: () => undefined,
          };
        },
        close: async () => undefined,
      }),
      close: async () => { connected = false; },
      isConnected: () => connected,
    }),
  } as unknown as PlaywrightLauncher;
  const adapter = new PlaywrightPageCaptureAdapter({
    launcher,
    resolveHost: async () => ['93.184.216.34'],
    getEffectiveUid: () => 501,
  });

  const result = await adapter.invoke({
    toolId: manifest.id,
    manifest,
    context: invocationContext(),
    input: {
      pages: [
        { url: 'https://example.com/fails' },
        { url: 'https://example.com/good-one' },
        { url: 'https://example.com/good-two' },
      ],
      capture: { mode: 'full_page_screenshot', max_pages: 2 },
    },
  });

  assert.deepEqual(attemptedUrls, [
    'https://example.com/fails',
    'https://example.com/good-one',
    'https://example.com/good-two',
  ]);
  assert.deepEqual(result.mediaAttachments?.map((attachment) => attachment.sourcePageUrl), [
    'https://example.com/good-one',
    'https://example.com/good-two',
  ]);
});

test('a transient DNS failure during normalization is retryable without launching Chromium', async () => {
  let launches = 0;
  const adapter = new PlaywrightPageCaptureAdapter({
    launcher: {
      launch: async () => { launches += 1; throw new Error('must not launch'); },
    } as PlaywrightLauncher,
    resolveHost: async () => {
      throw Object.assign(new Error('temporary DNS failure'), { code: 'EAI_AGAIN' });
    },
    getEffectiveUid: () => 501,
  });

  const error = await toolError(adapter.invoke({
    toolId: manifest.id,
    manifest,
    context: invocationContext(),
    input: { pages: [{ url: 'https://example.com/product' }] },
  }));

  assert.equal(error.kind, 'network');
  assert.equal(error.retryable, true);
  assert.equal(launches, 0);
  assert.equal(
    (error.details.page_failures as Array<{ code: string }>)[0]?.code,
    'unsupported_content',
  );
});

test('fragment URLs become a sanitized unsupported-content gap without launching Chromium', async () => {
  let launches = 0;
  const adapter = new PlaywrightPageCaptureAdapter({
    launcher: {
      launch: async () => { launches += 1; throw new Error('must not launch'); },
    } as PlaywrightLauncher,
    resolveHost: async () => ['93.184.216.34'],
    getEffectiveUid: () => 501,
  });

  const error = await toolError(adapter.invoke({
    toolId: manifest.id,
    manifest,
    context: invocationContext(),
    input: { pages: [{ url: 'https://example.com/product#access_token=secret' }] },
  }));

  assert.equal(launches, 0);
  assert.equal(error.retryable, false);
  assert.deepEqual(error.details.page_failures, [{
    source_result_index: 0,
    requested_url: 'https://example.com/product',
    code: 'unsupported_content',
    sanitized_message: 'browser target must not contain a fragment',
  }]);
  assert.doesNotMatch(JSON.stringify(error.details), /access_token|secret|#/i);
});

test('a route policy denial is terminal even when goto reports net::ERR_FAILED', async () => {
  const adapter = new PlaywrightPageCaptureAdapter({
    launcher: failingRouteLauncher('https://127.0.0.1/private'),
    resolveHost: async () => ['93.184.216.34'],
    getEffectiveUid: () => 501,
  });

  const error = await toolError(adapter.invoke({
    toolId: manifest.id,
    manifest,
    context: invocationContext(),
    input: { pages: [{ url: 'https://example.com/product' }] },
  }));

  assert.equal(error.kind, 'unknown');
  assert.equal(error.retryable, false);
  assert.equal(
    (error.details.page_failures as Array<{ code: string }>)[0]?.code,
    'robots_or_terms_blocked',
  );
});

test('a route DNS transport failure remains retryable and is not mislabeled as policy', async () => {
  const adapter = new PlaywrightPageCaptureAdapter({
    launcher: failingRouteLauncher('https://transient.invalid/image.png'),
    resolveHost: async (hostname) => {
      if (hostname === 'transient.invalid') {
        throw Object.assign(new Error('temporary DNS failure'), { code: 'EAI_AGAIN' });
      }
      return ['93.184.216.34'];
    },
    getEffectiveUid: () => 501,
  });

  const error = await toolError(adapter.invoke({
    toolId: manifest.id,
    manifest,
    context: invocationContext(),
    input: { pages: [{ url: 'https://example.com/product' }] },
  }));

  assert.equal(error.kind, 'network');
  assert.equal(error.retryable, true);
  assert.equal(
    (error.details.page_failures as Array<{ code: string }>)[0]?.code,
    'unsupported_content',
  );
});

test('popup and download attempts are closed and recorded as a page gap', async () => {
  const events: string[] = [];
  const adapter = new PlaywrightPageCaptureAdapter({
    launcher: fakeLauncher(events, {}, { triggerPopup: true, triggerDownload: true }),
    resolveHost: async () => ['93.184.216.34'],
    getEffectiveUid: () => 501,
  });
  const error = await toolError(adapter.invoke({
    toolId: manifest.id,
    manifest,
    context: invocationContext(),
    input: {
      pages: [{ url: 'https://example.com/product' }],
      capture: { mode: 'full_page_screenshot' },
    },
  }));
  assert.equal(error.retryable, false);
  assert.equal(
    (error.details.page_failures as Array<{ code: string }>)[0]?.code,
    'robots_or_terms_blocked',
  );
  assert.ok(events.includes('popup.close'));
  assert.ok(events.includes('download.cancel'));
});

test('a popup raised while the page closes invalidates the uncommitted capture', async () => {
  const events: string[] = [];
  const adapter = new PlaywrightPageCaptureAdapter({
    launcher: fakeLauncher(events, {}, { triggerPopupOnClose: true }),
    resolveHost: async () => ['93.184.216.34'],
    getEffectiveUid: () => 501,
  });

  const error = await toolError(adapter.invoke({
    toolId: manifest.id,
    manifest,
    context: invocationContext(),
    input: {
      pages: [{ url: 'https://example.com/product' }],
      capture: { mode: 'full_page_screenshot' },
    },
  }));

  assert.equal(error.retryable, false);
  assert.equal(
    (error.details.page_failures as Array<{ code: string }>)[0]?.code,
    'robots_or_terms_blocked',
  );
  assert.ok(events.includes('popup.close'));
});

test('page processing timeout closes the page and releases the Browser gate', async () => {
  let rejectBody: ((reason?: unknown) => void) | undefined;
  let connected = true;
  const gate = new BrowserExecutionGate({ maxActive: 1, maxQueued: 0, queueTimeoutMs: 1 });
  const page = {
    goto: async () => ({ status: () => 200, headers: () => ({ 'content-type': 'text/html' }) }),
    url: () => 'https://example.com/product',
    evaluate: async (fn: unknown) => {
      if (String(fn).includes('innerText')) {
        return new Promise<never>((_resolve, reject) => { rejectBody = reject; });
      }
      return { width: 1, height: 1 };
    },
    close: async () => { rejectBody?.(new Error('page closed')); },
    on: () => undefined,
  };
  const launcher = {
    launch: async () => ({
      newContext: async () => ({
        route: async () => undefined,
        routeWebSocket: async () => undefined,
        newPage: async () => page,
      }),
      close: async () => { connected = false; },
      isConnected: () => connected,
    }),
  } as unknown as PlaywrightLauncher;
  const adapter = new PlaywrightPageCaptureAdapter({
    gate,
    launcher,
    resolveHost: async () => ['93.184.216.34'],
    getEffectiveUid: () => 501,
    pageTimeoutMs: 10,
  });
  const error = await toolError(adapter.invoke({
    toolId: manifest.id,
    manifest,
    context: invocationContext(),
    input: {
      pages: [{ url: 'https://example.com/product' }],
      capture: { mode: 'full_page_screenshot' },
    },
  }));
  assert.equal(error.kind, 'timeout');
  assert.equal(error.retryable, true);
  assert.deepEqual(gate.stats(), { active: 0, queued: 0 });
});

test('adapter enforces browser controls and returns bytes only in the in-memory sidecar', async () => {
  const events: string[] = [];
  const captured: { launch?: Record<string, unknown>; context?: Record<string, unknown> } = {};
  const gate = new BrowserExecutionGate({ maxActive: 1, maxQueued: 1, queueTimeoutMs: 100 });
  const adapter = new PlaywrightPageCaptureAdapter({
    gate,
    launcher: fakeLauncher(events, captured, {
      bodyText: 'Product details and reviews. Sign in to your account from the navigation.',
      pageUrl: 'https://example.com/redirected-product',
    }),
    resolveHost: async () => ['93.184.216.34'],
    getEffectiveUid: () => 501,
    now: () => new Date('2026-08-19T08:00:00.000Z'),
  });

  const result = await adapter.invoke({
    toolId: manifest.id,
    manifest,
    context: invocationContext(),
    input: {
      pages: [{ title: 'Example', url: 'https://example.com/source-product', snippet: 'public source' }],
      capture: {
        mode: 'full_page_screenshot',
        max_pages: 6,
        viewport: { width: 1440, height: 900 },
      },
    },
  });

  assert.equal(captured.launch?.chromiumSandbox, true);
  assert.equal(captured.context?.serviceWorkers, 'block');
  assert.equal(captured.context?.acceptDownloads, false);
  assert.deepEqual(captured.context?.permissions, []);
  assert.equal(result.mediaAttachments?.length, 1);
  assert.equal(result.mediaAttachments?.[0]?.bytes, PNG_1X1);
  assert.equal(result.mediaAttachments?.[0]?.sourcePageUrl, 'https://example.com/source-product');
  const capture = (result.output as {
    captures: Array<{ requested_url: string; final_url: string }>;
  }).captures[0];
  assert.equal(capture?.requested_url, 'https://example.com/source-product');
  assert.equal(capture?.final_url, 'https://example.com/redirected-product');
  assert.equal(
    result.mediaAttachments?.[0]?.contentSha256,
    `sha256:${createHash('sha256').update(PNG_1X1).digest('hex')}`,
  );
  const serialized = JSON.stringify(result.output);
  assert.doesNotMatch(serialized, /iVBOR|base64|cookie|<html|\/tmp\//i);
  assert.equal((result.output as { security_profile: string }).security_profile, 'browser-controls-v1');
  assert.equal(events.at(-1), 'browser.close');
  assert.ok(events.includes('page.close'));
  assert.ok(events.indexOf('page.close') < events.indexOf('context.close'));
  assert.ok(events.indexOf('context.close') < events.indexOf('browser.close'));
  assert.deepEqual(gate.stats(), { active: 0, queued: 0 });
});

test('a launch that ignores the Tool deadline returns and quarantines the Gate slot', { timeout: 1_000 }, async (t) => {
  const realNow = Date.now.bind(Date);
  let deadlineAt = 0;
  let launchStarted = false;
  let injectedEarlyRead = false;
  t.mock.method(Date, 'now', () => {
    const now = realNow();
    if (launchStarted && !injectedEarlyRead && deadlineAt > 0 && now >= deadlineAt) {
      injectedEarlyRead = true;
      return deadlineAt - 1;
    }
    return now;
  });
  const gate = new BrowserExecutionGate({ maxActive: 1, maxQueued: 0, queueTimeoutMs: 1 });
  const adapter = new PlaywrightPageCaptureAdapter({
    gate,
    launcher: {
      launch: async () => {
        launchStarted = true;
        return new Promise<never>(() => {});
      },
    } as unknown as PlaywrightLauncher,
    resolveHost: async () => ['93.184.216.34'],
    getEffectiveUid: () => 501,
  });
  const context = invocationContext();
  deadlineAt = realNow() + 20;
  context.deadlineAt = deadlineAt;

  const error = await toolError(adapter.invoke({
    toolId: manifest.id,
    manifest,
    context,
    input: { pages: [{ url: 'https://example.com/product' }] },
  }));

  assert.equal(injectedEarlyRead, true);
  assert.equal(error.kind, 'safety');
  assert.equal(error.details.primaryKind, 'timeout');
  assert.equal(error.details.abortReason, 'deadline_exceeded');
  assert.equal(error.details.recovery, 'restart_worker');
  assert.deepEqual(gate.stats(), { active: 1, queued: 0 });
});

test('a newContext call that ignores the Tool deadline is stopped by closing Chromium', { timeout: 500 }, async () => {
  let connected = true;
  const gate = new BrowserExecutionGate({ maxActive: 1, maxQueued: 0, queueTimeoutMs: 1 });
  const adapter = new PlaywrightPageCaptureAdapter({
    gate,
    launcher: {
      launch: async () => ({
        newContext: async () => new Promise<never>(() => {}),
        close: async () => { connected = false; },
        isConnected: () => connected,
      }),
    } as unknown as PlaywrightLauncher,
    resolveHost: async () => ['93.184.216.34'],
    getEffectiveUid: () => 501,
  });
  const context = invocationContext();
  context.deadlineAt = Date.now() + 20;

  const error = await toolError(adapter.invoke({
    toolId: manifest.id,
    manifest,
    context,
    input: { pages: [{ url: 'https://example.com/product' }] },
  }));

  assert.equal(error.kind, 'timeout');
  assert.deepEqual(gate.stats(), { active: 0, queued: 0 });
});

test('a page and page.close that both ignore cancellation cannot outlive the page deadline', { timeout: 500 }, async () => {
  let connected = true;
  const gate = new BrowserExecutionGate({ maxActive: 1, maxQueued: 0, queueTimeoutMs: 1 });
  const page = {
    goto: async () => ({ status: () => 200, headers: () => ({ 'content-type': 'text/html' }) }),
    url: () => 'https://example.com/product',
    evaluate: async (fn: unknown) => String(fn).includes('innerText')
      ? new Promise<never>(() => {})
      : { width: 1, height: 1 },
    close: async () => new Promise<never>(() => {}),
    on: () => undefined,
  };
  const adapter = new PlaywrightPageCaptureAdapter({
    gate,
    launcher: {
      launch: async () => ({
        newContext: async () => ({
          route: async () => undefined,
          routeWebSocket: async () => undefined,
          newPage: async () => page,
          close: async () => undefined,
        }),
        close: async () => { connected = false; },
        isConnected: () => connected,
      }),
    } as unknown as PlaywrightLauncher,
    resolveHost: async () => ['93.184.216.34'],
    getEffectiveUid: () => 501,
    pageTimeoutMs: 10,
  });
  const context = invocationContext();
  context.deadlineAt = Date.now() + 50;

  const error = await toolError(adapter.invoke({
    toolId: manifest.id,
    manifest,
    context,
    input: {
      pages: [{ url: 'https://example.com/product' }],
      capture: { mode: 'full_page_screenshot' },
    },
  }));

  assert.equal(error.kind, 'timeout');
  assert.deepEqual(gate.stats(), { active: 0, queued: 0 });
});

test('adapter fails closed when the effective process user is unavailable or root', async () => {
  let launches = 0;
  for (const effectiveUid of [undefined, 0]) {
    const adapter = new PlaywrightPageCaptureAdapter({
      launcher: {
        launch: async () => {
          launches += 1;
          throw new Error('must not launch');
        },
      } as PlaywrightLauncher,
      resolveHost: async () => ['93.184.216.34'],
      getEffectiveUid: () => effectiveUid,
    });

    const error = await toolError(adapter.invoke({
      toolId: manifest.id,
      manifest,
      context: invocationContext(),
      input: { pages: [{ url: 'https://example.com' }] },
    }));
    assert.equal(error.kind, 'configuration');
  }
  assert.equal(launches, 0);
});

test('all terminal page failures are not retried', async () => {
  const adapter = new PlaywrightPageCaptureAdapter({
    launcher: fakeLauncher([], {}, { bodyText: 'Please sign in to continue.' }),
    resolveHost: async () => ['93.184.216.34'],
    getEffectiveUid: () => 501,
  });

  const error = await toolError(adapter.invoke({
    toolId: manifest.id,
    manifest,
    context: invocationContext(),
    input: {
      pages: [{ url: 'https://example.com/product' }],
      capture: { mode: 'full_page_screenshot' },
    },
  }));

  assert.equal(error.kind, 'unknown');
  assert.equal(error.retryable, false);
  assert.equal(
    (error.details.page_failures as Array<{ code: string }>)[0]?.code,
    'login_required',
  );
});

test('runtime abort closes Chromium before releasing the gate', async () => {
  const controller = new AbortController();
  const events: string[] = [];
  const gate = new BrowserExecutionGate({ maxActive: 1, maxQueued: 0, queueTimeoutMs: 1 });
  const adapter = new PlaywrightPageCaptureAdapter({
    gate,
    launcher: fakeLauncher(events, {}, {
      onGoto: () => controller.abort('lease_lost'),
      closeDelayMs: 5,
    }),
    resolveHost: async () => ['93.184.216.34'],
    getEffectiveUid: () => 501,
  });

  const error = await toolError(adapter.invoke({
    toolId: manifest.id,
    manifest,
    context: invocationContext(controller.signal),
    input: { pages: [{ url: 'https://example.com/product' }] },
  }));

  assert.equal(error.kind, 'lease_lost');
  assert.ok(events.includes('browser.close'));
  assert.ok(events.indexOf('page.close') < events.indexOf('context.close'));
  assert.ok(events.indexOf('context.close') < events.indexOf('browser.close'));
  assert.deepEqual(gate.stats(), { active: 0, queued: 0 });
});

test('a connected Browser with failed cleanup keeps its gate slot quarantined', async () => {
  const gate = new BrowserExecutionGate({ maxActive: 1, maxQueued: 0, queueTimeoutMs: 1 });
  const adapter = new PlaywrightPageCaptureAdapter({
    gate,
    launcher: fakeLauncher([], {}, { failBrowserClose: true }),
    resolveHost: async () => ['93.184.216.34'],
    getEffectiveUid: () => 501,
    browserCloseTimeoutMs: 10,
  });

  const error = await toolError(adapter.invoke({
    toolId: manifest.id,
    manifest,
    context: invocationContext(),
    input: {
      pages: [{ url: 'https://example.com/product' }],
      capture: { mode: 'full_page_screenshot' },
    },
  }));

  assert.equal(error.kind, 'safety', JSON.stringify({
    kind: error.kind,
    message: error.sanitizedMessage,
    details: error.details,
  }));
  assert.deepEqual(gate.stats(), { active: 1, queued: 0 });
});

test('a late Browser disconnect releases a quarantined Gate slot', async () => {
  const gate = new BrowserExecutionGate({ maxActive: 1, maxQueued: 0, queueTimeoutMs: 1 });
  const disconnectControl: { disconnect?: () => void } = {};
  const adapter = new PlaywrightPageCaptureAdapter({
    gate,
    launcher: fakeLauncher([], {}, { failBrowserClose: true, disconnectControl }),
    resolveHost: async () => ['93.184.216.34'],
    getEffectiveUid: () => 501,
    browserCloseTimeoutMs: 10,
  });

  const error = await toolError(adapter.invoke({
    toolId: manifest.id,
    manifest,
    context: invocationContext(),
    input: { pages: [{ url: 'https://example.com/product' }] },
  }));

  assert.equal(error.kind, 'safety');
  assert.deepEqual(gate.stats(), { active: 1, queued: 0 });
  assert.ok(disconnectControl.disconnect);
  disconnectControl.disconnect();
  assert.deepEqual(gate.stats(), { active: 0, queued: 0 });
});

test('Browser cleanup failure overrides a terminal page failure with safety', async () => {
  const gate = new BrowserExecutionGate({ maxActive: 1, maxQueued: 0, queueTimeoutMs: 1 });
  const adapter = new PlaywrightPageCaptureAdapter({
    gate,
    launcher: fakeLauncher([], {}, {
      bodyText: 'Please sign in to continue.',
      failBrowserClose: true,
    }),
    resolveHost: async () => ['93.184.216.34'],
    getEffectiveUid: () => 501,
    browserCloseTimeoutMs: 10,
  });

  const error = await toolError(adapter.invoke({
    toolId: manifest.id,
    manifest,
    context: invocationContext(),
    input: {
      pages: [{ url: 'https://example.com/product' }],
      capture: { mode: 'full_page_screenshot' },
    },
  }));

  assert.equal(error.kind, 'safety');
  assert.equal(error.details.primaryKind, 'unknown');
  assert.equal(error.details.recovery, 'restart_worker');
  assert.deepEqual(gate.stats(), { active: 1, queued: 0 });
});

test('Browser cleanup failure preserves lease_lost while quarantining the gate slot', async () => {
  const controller = new AbortController();
  const gate = new BrowserExecutionGate({ maxActive: 1, maxQueued: 0, queueTimeoutMs: 1 });
  const adapter = new PlaywrightPageCaptureAdapter({
    gate,
    launcher: fakeLauncher([], {}, {
      onGoto: () => controller.abort('lease_lost'),
      failBrowserClose: true,
    }),
    resolveHost: async () => ['93.184.216.34'],
    getEffectiveUid: () => 501,
    browserCloseTimeoutMs: 10,
  });

  const error = await toolError(adapter.invoke({
    toolId: manifest.id,
    manifest,
    context: invocationContext(controller.signal),
    input: { pages: [{ url: 'https://example.com/product' }] },
  }));

  assert.equal(error.kind, 'lease_lost');
  assert.equal(error.details.abortReason, 'lease_lost');
  assert.equal(error.details.recovery, 'restart_worker');
  assert.deepEqual(gate.stats(), { active: 1, queued: 0 });
});

test('network policy failures stay isolated to the page that caused them', async () => {
  type RouteHandler = (route: {
    request(): {
      method(): string;
      url(): string;
      isNavigationRequest(): boolean;
      frame(): { page(): object };
    };
    continue(): Promise<void>;
    abort(): Promise<void>;
  }) => Promise<void>;
  let routeHandler: RouteHandler | undefined;
  let continued = 0;
  let aborted = 0;
  let webSocketsClosed = 0;
  const response = { status: () => 200, headers: () => ({ 'content-type': 'text/html' }) };
  const commonPage = {
    url: () => 'https://example.com/product',
    title: async () => 'Example product',
    screenshot: async () => PNG_1X1,
    close: async () => undefined,
    on: () => undefined,
  };
  const firstPage = {
    ...commonPage,
    goto: async () => {
      assert.ok(routeHandler);
      const route = async (method: string, url: string, isNavigationRequest = false) => routeHandler!({
        request: () => ({
          method: () => method,
          url: () => url,
          isNavigationRequest: () => isNavigationRequest,
          frame: () => ({ page: () => firstPage }),
        }),
        continue: async () => { continued += 1; },
        abort: async () => { aborted += 1; },
      });
      await route('GET', 'https://cdn.example.com/image.png?signature=page-generated');
      await route('POST', 'https://example.com/beacon');
      await routeHandler({
        request: () => ({
          method: () => 'GET',
          url: () => 'https://blocked.invalid/image.png',
          isNavigationRequest: () => false,
          frame: () => ({ page: () => firstPage }),
        }),
        continue: async () => { continued += 1; },
        abort: async () => { aborted += 1; },
      });
      return response;
    },
    evaluate: async (fn: unknown) => String(fn).includes('innerText')
      ? ''
      : { width: 1, height: 1 },
  };
  const secondPage = {
    ...commonPage,
    goto: async () => response,
    evaluate: async (fn: unknown) => {
      if (String(fn).includes('innerText')) return '';
      throw new Error('page-specific rendering failure');
    },
  };
  const pageQueue = [firstPage, secondPage];
  let connected = true;
  const launcher = {
    launch: async () => ({
      newContext: async () => ({
        route: async (_pattern: string, handler: RouteHandler) => { routeHandler = handler; },
        routeWebSocket: async (
          _pattern: string,
          handler: (socket: { close(): void }) => void,
        ) => handler({ close: () => { webSocketsClosed += 1; } }),
        newPage: async () => pageQueue.shift(),
        close: async () => undefined,
      }),
      close: async () => { connected = false; },
      isConnected: () => connected,
    }),
  } as unknown as PlaywrightLauncher;
  const adapter = new PlaywrightPageCaptureAdapter({
    launcher,
    resolveHost: async (hostname) => hostname === 'blocked.invalid'
      ? ['127.0.0.1']
      : ['93.184.216.34'],
    getEffectiveUid: () => 501,
  });

  const result = await adapter.invoke({
    toolId: manifest.id,
    manifest,
    context: invocationContext(),
    input: {
      pages: [
        { url: 'https://example.com/first' },
        { url: 'https://example.com/second' },
      ],
      capture: { mode: 'full_page_screenshot', max_pages: 2 },
    },
  });

  assert.equal(result.mediaAttachments?.length, 1);
  assert.equal(continued, 1);
  assert.equal(aborted, 2);
  assert.equal(webSocketsClosed, 1);
  assert.deepEqual(
    (result.output as { failures: Array<{ source_result_index: number; code: string }> }).failures,
    [{
      source_result_index: 1,
      requested_url: 'https://example.com/second',
      code: 'unsupported_content',
      sanitized_message: 'page content could not be captured safely',
    }],
  );
});

test('route DNS checks coalesce only concurrent requests for the same host', async () => {
  let routeHandler: TestRouteHandler | undefined;
  let releaseFirstDns: ((addresses: string[]) => void) | undefined;
  let cdnResolutions = 0;
  const response = { status: () => 200, headers: () => ({ 'content-type': 'text/html' }) };
  const page = {
    goto: async () => {
      assert.ok(routeHandler);
      const route = (path: string) => routeHandler!({
        request: () => ({
          method: () => 'GET',
          url: () => `https://cdn.example.com/${path}`,
          isNavigationRequest: () => false,
          frame: () => ({ page: () => page }),
        }),
        continue: async () => undefined,
        abort: async () => undefined,
      });
      const first = route('one.png');
      const second = route('two.png');
      await Promise.resolve();
      assert.ok(releaseFirstDns);
      releaseFirstDns(['93.184.216.34']);
      await Promise.all([first, second]);
      await route('three.png');
      return response;
    },
    url: () => 'https://example.com/product',
    title: async () => 'Example product',
    evaluate: async (fn: unknown) => String(fn).includes('innerText') ? '' : { width: 1, height: 1 },
    screenshot: async () => PNG_1X1,
    close: async () => undefined,
    on: () => undefined,
  };
  let connected = true;
  const adapter = new PlaywrightPageCaptureAdapter({
    launcher: {
      launch: async () => ({
        newContext: async () => ({
          route: async (_pattern: string, handler: TestRouteHandler) => { routeHandler = handler; },
          routeWebSocket: async () => undefined,
          newPage: async () => page,
          close: async () => undefined,
        }),
        close: async () => { connected = false; },
        isConnected: () => connected,
      }),
    } as unknown as PlaywrightLauncher,
    resolveHost: async (hostname) => {
      if (hostname !== 'cdn.example.com') return ['93.184.216.34'];
      cdnResolutions += 1;
      if (cdnResolutions === 1) {
        return new Promise<string[]>((resolve) => { releaseFirstDns = resolve; });
      }
      return ['93.184.216.34'];
    },
    getEffectiveUid: () => 501,
  });

  await adapter.invoke({
    toolId: manifest.id,
    manifest,
    context: invocationContext(),
    input: {
      pages: [{ url: 'https://example.com/product' }],
      capture: { mode: 'full_page_screenshot' },
    },
  });

  assert.equal(cdnResolutions, 2);
});

test('route request budget blocks excess requests before another DNS lookup', async () => {
  let routeHandler: TestRouteHandler | undefined;
  let budgetResolutions = 0;
  let continued = 0;
  let aborted = 0;
  const response = { status: () => 200, headers: () => ({ 'content-type': 'text/html' }) };
  const page = {
    goto: async () => {
      assert.ok(routeHandler);
      for (let index = 0; index < 257; index += 1) {
        await routeHandler({
          request: () => ({
            method: () => 'GET',
            url: () => `https://budget.invalid/resource-${index}.png`,
            isNavigationRequest: () => false,
            frame: () => ({ page: () => page }),
          }),
          continue: async () => { continued += 1; },
          abort: async () => { aborted += 1; },
        });
      }
      return response;
    },
    url: () => 'https://example.com/product',
    title: async () => 'Example product',
    evaluate: async (fn: unknown) => String(fn).includes('innerText') ? '' : { width: 1, height: 1 },
    screenshot: async () => PNG_1X1,
    close: async () => undefined,
    on: () => undefined,
  };
  let connected = true;
  const adapter = new PlaywrightPageCaptureAdapter({
    launcher: {
      launch: async () => ({
        newContext: async () => ({
          route: async (_pattern: string, handler: TestRouteHandler) => { routeHandler = handler; },
          routeWebSocket: async () => undefined,
          newPage: async () => page,
          close: async () => undefined,
        }),
        close: async () => { connected = false; },
        isConnected: () => connected,
      }),
    } as unknown as PlaywrightLauncher,
    resolveHost: async (hostname) => {
      if (hostname === 'budget.invalid') budgetResolutions += 1;
      return ['93.184.216.34'];
    },
    getEffectiveUid: () => 501,
  });

  await adapter.invoke({
    toolId: manifest.id,
    manifest,
    context: invocationContext(),
    input: {
      pages: [{ url: 'https://example.com/product' }],
      capture: { mode: 'full_page_screenshot' },
    },
  });

  assert.equal(budgetResolutions, 256);
  assert.equal(continued, 256);
  assert.equal(aborted, 1);
});

test('route request budget is isolated per page so earlier candidates cannot starve fallbacks', async () => {
  let routeHandler: TestRouteHandler | undefined;
  let continued = 0;
  let aborted = 0;
  const response = { status: () => 200, headers: () => ({ 'content-type': 'text/html' }) };
  const page = () => {
    const current = {
      goto: async () => {
        assert.ok(routeHandler);
        for (let index = 0; index < 200; index += 1) {
          await routeHandler({
            request: () => ({
              method: () => 'GET',
              url: () => `https://budget.invalid/resource-${index}.png`,
              isNavigationRequest: () => false,
              frame: () => ({ page: () => current }),
            }),
            continue: async () => { continued += 1; },
            abort: async () => { aborted += 1; },
          });
        }
        return response;
      },
      url: () => 'https://example.com/product',
      title: async () => 'Example product',
      evaluate: async (fn: unknown) => String(fn).includes('innerText') ? '' : { width: 1, height: 1 },
      screenshot: async () => PNG_1X1,
      close: async () => undefined,
      on: () => undefined,
    };
    return current;
  };
  const pages = [page(), page()];
  let connected = true;
  const adapter = new PlaywrightPageCaptureAdapter({
    launcher: {
      launch: async () => ({
        newContext: async () => ({
          route: async (_pattern: string, handler: TestRouteHandler) => { routeHandler = handler; },
          routeWebSocket: async () => undefined,
          newPage: async () => pages.shift(),
          close: async () => undefined,
        }),
        close: async () => { connected = false; },
        isConnected: () => connected,
      }),
    } as unknown as PlaywrightLauncher,
    resolveHost: async () => ['93.184.216.34'],
    getEffectiveUid: () => 501,
  });

  const result = await adapter.invoke({
    toolId: manifest.id,
    manifest,
    context: invocationContext(),
    input: {
      pages: [
        { url: 'https://example.com/first' },
        { url: 'https://example.com/second' },
      ],
      capture: { mode: 'full_page_screenshot', max_pages: 2 },
    },
  });

  assert.equal(result.mediaAttachments?.length, 2);
  assert.equal(continued, 400);
  assert.equal(aborted, 0);
});

test('route request budget also enforces one bounded invocation total across fallbacks', async () => {
  let routeHandler: TestRouteHandler | undefined;
  let continued = 0;
  let aborted = 0;
  const response = { status: () => 200, headers: () => ({ 'content-type': 'text/html' }) };
  const page = (requestCount: number, failCapture = false) => {
    const current = {
      goto: async () => {
        assert.ok(routeHandler);
        for (let index = 0; index < requestCount; index += 1) {
          await routeHandler({
            request: () => ({
              method: () => 'GET',
              url: () => `https://budget.invalid/resource-${index}.png`,
              isNavigationRequest: () => false,
              frame: () => ({ page: () => current }),
            }),
            continue: async () => { continued += 1; },
            abort: async () => { aborted += 1; },
          });
        }
        return response;
      },
      url: () => 'https://example.com/product',
      title: async () => 'Example product',
      evaluate: async (fn: unknown) => String(fn).includes('innerText') ? '' : { width: 1, height: 1 },
      screenshot: async () => {
        if (failCapture) throw new Error('fixture capture failure');
        return PNG_1X1;
      },
      close: async () => undefined,
      on: () => undefined,
    };
    return current;
  };
  const pages = [page(250, true), ...Array.from({ length: 6 }, () => page(220))];
  let connected = true;
  const adapter = new PlaywrightPageCaptureAdapter({
    launcher: {
      launch: async () => ({
        newContext: async () => ({
          route: async (_pattern: string, handler: TestRouteHandler) => { routeHandler = handler; },
          routeWebSocket: async () => undefined,
          newPage: async () => pages.shift(),
          close: async () => undefined,
        }),
        close: async () => { connected = false; },
        isConnected: () => connected,
      }),
    } as unknown as PlaywrightLauncher,
    resolveHost: async () => ['93.184.216.34'],
    getEffectiveUid: () => 501,
  });

  const result = await adapter.invoke({
    toolId: manifest.id,
    manifest,
    context: invocationContext(),
    input: {
      pages: Array.from({ length: 7 }, (_, index) => ({ url: `https://source-${index}.example/product` })),
      capture: { mode: 'full_page_screenshot', max_pages: 6 },
    },
  });

  assert.equal(result.mediaAttachments?.length, 6);
  assert.equal(continued, 1_536);
  assert.equal(aborted, 34);
});

test('adapter does not launch after lease loss and preserves the abort reason', async () => {
  let launches = 0;
  const controller = new AbortController();
  controller.abort('lease_lost');
  const adapter = new PlaywrightPageCaptureAdapter({
    gate: new BrowserExecutionGate(),
    launcher: { launch: async () => { launches += 1; throw new Error('must not launch'); } } as PlaywrightLauncher,
    resolveHost: async () => ['93.184.216.34'],
    getEffectiveUid: () => 501,
  });

  const error = await toolError(adapter.invoke({
    toolId: manifest.id,
    manifest,
    context: invocationContext(controller.signal),
    input: { pages: [{ url: 'https://example.com' }] },
  }));
  assert.equal(error.kind, 'lease_lost');
  assert.equal(error.details.abortReason, 'lease_lost');
  assert.equal(launches, 0);
});

test('runtime registers Playwright only for the exact feature flag value 1', () => {
  for (const value of [undefined, '0', 'true']) {
    if (value === undefined) delete process.env.PLAYWRIGHT_CAPTURE_ENABLED;
    else process.env.PLAYWRIGHT_CAPTURE_ENABLED = value;
    const router = buildRuntime().deps.toolAdapter;
    assert.ok(router instanceof ToolRouter);
    assert.equal(router.resolve(manifest), null);
  }

  process.env.PLAYWRIGHT_CAPTURE_ENABLED = '1';
  const gate = new BrowserExecutionGate({ maxActive: 1, maxQueued: 0, queueTimeoutMs: 1 });
  const router = buildRuntime({ browserExecutionGate: gate }).deps.toolAdapter;
  assert.ok(router instanceof ToolRouter);
  assert.equal(router.resolve(manifest)?.implementationId, 'playwright-page-capture-v1');
});

test('real Chromium contract uses only about:blank and in-memory setContent', {
  skip: process.env.PLAYWRIGHT_CONTRACT !== '1' ? 'set PLAYWRIGHT_CONTRACT=1 in the isolated CI job' : false,
}, async () => {
  assert.notEqual(process.geteuid?.(), 0, 'Chromium contract must run with a non-root effective UID');
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true });
  const context = await browser.newContext({
    serviceWorkers: 'block',
    acceptDownloads: false,
    permissions: [],
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
  });
  const requests: string[] = [];
  await context.route('**/*', async (route) => {
    requests.push(route.request().url());
    await route.abort('blockedbyclient');
  });
  await context.routeWebSocket('**/*', (socket) => socket.close());
  const page = await context.newPage();
  await page.goto('about:blank');
  await page.setContent('<main style="width:640px;height:360px"><h1>Offline fixture</h1></main>');
  const capture = await capturePageVisual(page, {
    mode: 'element_screenshot',
    selector: 'main',
    viewport: { width: 1440, height: 900 },
  });

  assert.equal(capture.mediaType, 'image/png');
  assert.ok(capture.bytes.byteLength > 0);
  assert.deepEqual(requests, []);
  await page.close();
  await context.close();
  await browser.close();
  assert.equal(browser.isConnected(), false);
});
