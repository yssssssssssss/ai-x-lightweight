/// <reference lib="dom" />

import { createHash } from 'node:crypto';
import { imageSize } from 'image-size';
import {
  chromium,
  type Browser,
  type BrowserContext,
  type BrowserType,
  type Page,
} from 'playwright';
import { redactString } from './redaction.ts';
import { BrowserExecutionGate } from './browser-execution-gate.ts';
import {
  PublicWebAccessError,
  defaultResolveHost,
  normalizedHostname,
  parseBrowserUrl,
  resolvePublicTarget,
  validateBrowserTarget as validateTarget,
  type ResolveHost,
} from './public-web-access-policy.ts';
import {
  ToolInvocationError,
  throwIfToolInvocationAborted,
  toolAbortError,
  type ToolAdapter,
  type ToolInvokeOptions,
  type ToolInvokeResult,
  type ToolInvocationContext,
  type ToolMediaAttachment,
} from './tool-adapter.ts';

const MAX_INPUT_PAGES = 20;
const MAX_CAPTURED_PAGES = 6;
const MAX_PAGE_CONCURRENCY = 2;
const MAX_REQUESTS_PER_PAGE = 256;
const MAX_REQUESTS_PER_INVOCATION = 1_536;
const MAX_ASSET_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 40 * 1024 * 1024;
const MAX_CAPTURE_HEIGHT = 12_000;
const MAX_CAPTURE_WIDTH = 12_000;
const MAX_CAPTURE_PIXELS = 20_000_000;
const MIN_LARGE_CAPTURE_BYTES = 8 * 1024;
const PAGE_TIMEOUT_MS = 20_000;
const BROWSER_CLOSE_TIMEOUT_MS = 5_000;
const SECURITY_PROFILE = 'browser-controls-v1';

export type PlaywrightLauncher = Pick<BrowserType, 'launch'>;
export { validateTarget as validateBrowserTarget };

type CaptureMode = 'auto' | 'extracted_image' | 'element_screenshot' | 'full_page_screenshot';
type FinalCaptureMode = Exclude<CaptureMode, 'auto'>;
type FailureCode =
  | 'login_required'
  | 'captcha_required'
  | 'paywall'
  | 'robots_or_terms_blocked'
  | 'navigation_timeout'
  | 'no_capture_target'
  | 'unsupported_content';

const FAILURE_CODES = new Set<FailureCode>([
  'login_required',
  'captcha_required',
  'paywall',
  'robots_or_terms_blocked',
  'navigation_timeout',
  'no_capture_target',
  'unsupported_content',
]);

interface CaptureOptions {
  mode: CaptureMode;
  selector?: string;
  maxPages: number;
  uniqueHostnames: boolean;
  viewport: { width: number; height: number };
}

interface PageInput {
  sourceResultIndex: number;
  requestedUrl: string;
  url: URL;
  hostname: string;
}

interface PageFailure {
  source_result_index: number;
  requested_url: string;
  code: FailureCode;
  sanitized_message: string;
}

interface CaptureMetadata {
  attachment_id: string;
  source_result_index: number;
  requested_url: string;
  final_url: string;
  page_title: string;
  captured_at: string;
  capture_mode: FinalCaptureMode;
  selector?: string;
  viewport: { width: number; height: number };
  media_type: 'image/png';
  width: number;
  height: number;
  byte_size: number;
  content_sha256: string;
  truncated: boolean;
}

export interface CapturedPageVisual {
  bytes: Buffer;
  mediaType: 'image/png';
  width: number;
  height: number;
  captureMode: FinalCaptureMode;
  selector?: string;
  truncated: boolean;
}

export interface CapturePageVisualInput {
  mode: CaptureMode;
  selector?: string | null;
  viewport: { width: number; height: number };
}

interface AdapterOptions {
  gate?: BrowserExecutionGate;
  launcher?: PlaywrightLauncher;
  resolveHost?: ResolveHost;
  getEffectiveUid?: () => number | undefined;
  browserCloseTimeoutMs?: number;
  pageTimeoutMs?: number;
  now?: () => Date;
}

function captureError(code: FailureCode, message: string): Error & { code: FailureCode } {
  return Object.assign(new Error(message), { code });
}

function isFailureCode(error: unknown, code: FailureCode): boolean {
  return error !== null
    && typeof error === 'object'
    && 'code' in error
    && error.code === code;
}

function failureCodeFrom(error: unknown): FailureCode | null {
  if (error === null || typeof error !== 'object' || !('code' in error)) return null;
  return typeof error.code === 'string' && FAILURE_CODES.has(error.code as FailureCode)
    ? error.code as FailureCode
    : null;
}

function retryablePageFailureKind(
  error: unknown,
  timedOut: boolean,
): 'timeout' | 'network' | null {
  if (
    timedOut
    || isFailureCode(error, 'navigation_timeout')
    || error instanceof Error && error.name === 'TimeoutError'
  ) return 'timeout';
  const code = error !== null && typeof error === 'object' && 'code' in error
    ? String(error.code)
    : '';
  const message = error instanceof Error ? error.message : '';
  return /^(?:EAI_|ECONN|ENET|EHOST|ETIMEDOUT)|net::ERR_|target page, context or browser has been closed/iu.test(
    `${code} ${message}`,
  ) ? 'network' : null;
}

async function runBounded<T>(
  factory: () => Promise<T>,
  toolId: string,
  context: ToolInvocationContext,
  deadlineAt: number,
  page?: Page,
): Promise<T> {
  throwIfToolInvocationAborted(toolId, context);
  if (Date.now() >= deadlineAt) {
    throw deadlineAt >= context.deadlineAt
      ? toolAbortError(toolId, context.signal, context.deadlineAt)
      : captureError('navigation_timeout', 'page processing timed out');
  }
  const operation = factory();
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const cancellation = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(toolAbortError(toolId, context.signal, context.deadlineAt));
    context.signal.addEventListener('abort', onAbort, { once: true });
    const rejectAtDeadline = () => {
      const remainingMs = deadlineAt - Date.now();
      if (remainingMs > 0) {
        timer = setTimeout(rejectAtDeadline, remainingMs);
        return;
      }
      reject(deadlineAt >= context.deadlineAt
        ? toolAbortError(toolId, context.signal, context.deadlineAt)
        : captureError('navigation_timeout', 'page processing timed out'));
    };
    timer = setTimeout(rejectAtDeadline, Math.max(0, deadlineAt - Date.now()));
    if (context.signal.aborted) onAbort();
  });
  try {
    return await Promise.race([operation, cancellation]);
  } catch (error) {
    if (page && (
      isFailureCode(error, 'navigation_timeout')
      || error instanceof ToolInvocationError && ['lease_lost', 'timeout'].includes(error.kind)
    )) {
      void closeQuietly(() => page.close());
      void operation.catch(() => undefined);
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) context.signal.removeEventListener('abort', onAbort);
  }
}

function boundedMessage(message: string): string {
  return redactString(message).replace(/[\r\n]+/gu, ' ').slice(0, 300);
}

function captureOptions(input: object): CaptureOptions {
  const record = input as { capture?: Record<string, unknown> };
  const capture = record.capture ?? {};
  const mode = capture.mode ?? 'auto';
  if (!['auto', 'extracted_image', 'element_screenshot', 'full_page_screenshot'].includes(String(mode))) {
    throw new ToolInvocationError('playwright-page-capture', {
      kind: 'schema', retryable: false, sanitizedMessage: 'capture mode is invalid',
    });
  }
  const selector = capture.selector;
  if (mode === 'element_screenshot' && (typeof selector !== 'string' || !selector.trim())) {
    throw new ToolInvocationError('playwright-page-capture', {
      kind: 'schema', retryable: false, sanitizedMessage: 'element_screenshot requires a CSS selector',
    });
  }
  if (typeof selector === 'string' && (selector.length > 512 || selector !== selector.trim())) {
    throw new ToolInvocationError('playwright-page-capture', {
      kind: 'schema', retryable: false, sanitizedMessage: 'capture selector is invalid',
    });
  }
  const viewportRecord = capture.viewport as Record<string, unknown> | undefined;
  const width = viewportRecord?.width ?? 1440;
  const height = viewportRecord?.height ?? 900;
  if (
    !Number.isInteger(width) || Number(width) < 1024 || Number(width) > 1920
    || !Number.isInteger(height) || Number(height) < 720 || Number(height) > 1200
  ) {
    throw new ToolInvocationError('playwright-page-capture', {
      kind: 'schema', retryable: false, sanitizedMessage: 'capture viewport is outside the supported range',
    });
  }
  const requestedMaxPages = capture.max_pages ?? MAX_CAPTURED_PAGES;
  if (!Number.isInteger(requestedMaxPages) || Number(requestedMaxPages) < 1 || Number(requestedMaxPages) > MAX_CAPTURED_PAGES) {
    throw new ToolInvocationError('playwright-page-capture', {
      kind: 'schema', retryable: false, sanitizedMessage: 'capture max_pages is outside the supported range',
    });
  }
  return {
    mode: mode as CaptureMode,
    ...(typeof selector === 'string' ? { selector } : {}),
    maxPages: Number(requestedMaxPages),
    uniqueHostnames: capture.unique_hostnames === true,
    viewport: { width: Number(width), height: Number(height) },
  };
}

function safeRequestedUrl(value: unknown, error?: unknown): string {
  if (error instanceof PublicWebAccessError && error.safeUrl) return error.safeUrl;
  if (typeof value !== 'string') return 'https://invalid.invalid/';
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'https://invalid.invalid/';
    return `${url.origin}${url.pathname}`;
  } catch {
    return 'https://invalid.invalid/';
  }
}

async function normalizePages(
  input: object,
  uniqueHostnames: boolean,
  resolveHost: ResolveHost,
  toolId: string,
  context: ToolInvocationContext,
): Promise<{
  pages: PageInput[];
  failures: PageFailure[];
  retryableFailureKind: 'timeout' | 'network' | null;
}> {
  const rows = Array.isArray((input as { pages?: unknown }).pages)
    ? (input as { pages: unknown[] }).pages.slice(0, MAX_INPUT_PAGES)
    : [];
  const pages: PageInput[] = [];
  const failures: PageFailure[] = [];
  let retryableFailureKind: 'timeout' | 'network' | null = null;
  const seen = new Set<string>();
  for (const [sourceResultIndex, value] of rows.entries()) {
    const rawUrl = value && typeof value === 'object' ? (value as { url?: unknown }).url : undefined;
    try {
      if (typeof rawUrl !== 'string') throw new PublicWebAccessError('browser target URL is required');
      const url = await runBounded(
        () => validateTarget(rawUrl, resolveHost),
        toolId,
        context,
        context.deadlineAt,
      );
      const normalized = url.toString();
      if (seen.has(normalized)) continue;
      const hostname = normalizedHostname(url).toLowerCase().replace(/^www\./u, '');
      seen.add(normalized);
      pages.push({ sourceResultIndex, requestedUrl: normalized, url, hostname });
    } catch (error) {
      if (error instanceof ToolInvocationError) throw error;
      const failureKind = retryablePageFailureKind(error, false);
      retryableFailureKind ??= failureKind;
      failures.push({
        source_result_index: sourceResultIndex,
        requested_url: safeRequestedUrl(rawUrl, error),
        code: failureKind === 'timeout' ? 'navigation_timeout' : 'unsupported_content',
        sanitized_message: boundedMessage(
          error instanceof PublicWebAccessError
            ? error.message
            : failureKind === 'timeout'
              ? 'page URL validation timed out'
              : failureKind === 'network'
                ? 'page URL DNS resolution failed'
                : 'page URL is not eligible for capture',
        ),
      });
    }
  }
  if (uniqueHostnames) {
    const grouped = new Map<string, PageInput[]>();
    for (const page of pages) {
      const group = grouped.get(page.hostname) ?? [];
      group.push(page);
      grouped.set(page.hostname, group);
    }
    for (const group of grouped.values()) {
      group.sort((left, right) => {
        const score = (page: PageInput): number => {
          const path = page.url.pathname.toLowerCase();
          if (/(?:login|signin|auth|terms|privacy|membership|cookie|legal|return|cart)/u.test(path)) return 100;
          if (/(?:about|brand|product|collection|shop|home)/u.test(path)) return 10;
          if (path === '/' || path === '') return 20;
          return 30;
        };
        return score(left) - score(right) || left.sourceResultIndex - right.sourceResultIndex;
      });
    }
    const prioritized: PageInput[] = [];
    for (let candidateIndex = 0; ; candidateIndex += 1) {
      let added = false;
      for (const group of grouped.values()) {
        const page = group[candidateIndex];
        if (!page) continue;
        prioritized.push(page);
        added = true;
      }
      if (!added) break;
    }
    return { pages: prioritized, failures, retryableFailureKind };
  }
  return { pages, failures, retryableFailureKind };
}

function cropFor(width: number, height: number): { width: number; height: number; truncated: boolean } {
  const originalWidth = Math.max(1, Math.floor(width));
  const safeWidth = Math.min(originalWidth, MAX_CAPTURE_WIDTH);
  const pixelHeight = Math.max(1, Math.floor(MAX_CAPTURE_PIXELS / safeWidth));
  const boundedHeight = Math.min(Math.max(1, Math.floor(height)), MAX_CAPTURE_HEIGHT, pixelHeight);
  return {
    width: safeWidth,
    height: boundedHeight,
    truncated: safeWidth < originalWidth || boundedHeight < height,
  };
}

async function screenshotClip(
  page: Page,
  clip: { x: number; y: number; width: number; height: number },
): Promise<Buffer> {
  return page.screenshot({
    type: 'png',
    clip,
    animations: 'disabled',
    caret: 'hide',
    scale: 'css',
  });
}

async function elementCapture(page: Page, selector: string, mode: FinalCaptureMode): Promise<CapturedPageVisual> {
  const locator = page.locator(`css=${selector}`).first();
  if (await locator.count() === 0 || !(await locator.isVisible())) {
    throw captureError('no_capture_target', 'capture target is not visible');
  }
  const box = await locator.boundingBox();
  if (!box || box.width <= 0 || box.height <= 0) {
    throw captureError('no_capture_target', 'capture target has no visible bounds');
  }
  const crop = cropFor(box.width, box.height);
  const bytes = await screenshotClip(page, {
    x: Math.max(0, box.x),
    y: Math.max(0, box.y),
    width: crop.width,
    height: crop.height,
  });
  return inspectedCapture(bytes, mode, selector, crop.truncated);
}

async function fullPageCapture(page: Page): Promise<CapturedPageVisual> {
  const dimensions = await page.evaluate(() => ({
    width: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth ?? 0, window.innerWidth),
    height: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0, window.innerHeight),
  }));
  const crop = cropFor(dimensions.width, dimensions.height);
  const bytes = await screenshotClip(page, { x: 0, y: 0, width: crop.width, height: crop.height });
  return inspectedCapture(bytes, 'full_page_screenshot', undefined, crop.truncated);
}

function inspectedCapture(
  bytes: Buffer,
  captureMode: FinalCaptureMode,
  selector: string | undefined,
  truncated: boolean,
): CapturedPageVisual {
  if (bytes.byteLength > MAX_ASSET_BYTES) throw captureError('unsupported_content', 'capture exceeds 10 MiB');
  const dimensions = imageSize(bytes);
  if (!dimensions.width || !dimensions.height) throw captureError('unsupported_content', 'capture dimensions are unavailable');
  if (dimensions.height > MAX_CAPTURE_HEIGHT || dimensions.width * dimensions.height > MAX_CAPTURE_PIXELS) {
    throw captureError('unsupported_content', 'capture dimensions exceed the supported limit');
  }
  if (
    dimensions.width >= 1024
    && dimensions.height >= 720
    && bytes.byteLength < MIN_LARGE_CAPTURE_BYTES
  ) {
    throw captureError('unsupported_content', 'capture is empty or near blank');
  }
  return {
    bytes,
    mediaType: 'image/png',
    width: dimensions.width,
    height: dimensions.height,
    captureMode,
    ...(selector ? { selector } : {}),
    truncated,
  };
}

export async function capturePageVisual(page: Page, input: CapturePageVisualInput): Promise<CapturedPageVisual> {
  if (input.mode === 'element_screenshot') {
    const selector = input.selector?.trim();
    if (!selector || selector.length > 512) throw captureError('no_capture_target', 'a valid CSS selector is required');
    return elementCapture(page, selector, 'element_screenshot');
  }
  if (input.mode === 'extracted_image') {
    const images = page.locator('img');
    const index = await images.evaluateAll((elements) => {
      let best = -1;
      let score = 0;
      elements.forEach((element, current) => {
        const image = element as HTMLImageElement;
        const rect = image.getBoundingClientRect();
        const area = rect.width * rect.height;
        if (rect.width >= 200 && rect.height >= 120 && area > score) {
          best = current;
          score = area;
        }
      });
      return best;
    });
    if (index < 0) throw captureError('no_capture_target', 'no visible large image was found');
    const locator = images.nth(index);
    const box = await locator.boundingBox();
    if (!box) throw captureError('no_capture_target', 'image capture target has no visible bounds');
    const crop = cropFor(box.width, box.height);
    const bytes = await screenshotClip(page, {
      x: Math.max(0, box.x), y: Math.max(0, box.y), width: crop.width, height: crop.height,
    });
    return inspectedCapture(bytes, 'extracted_image', undefined, crop.truncated);
  }
  if (input.mode === 'auto') {
    for (const selector of ['main', 'article', '[role="main"]']) {
      const locator = page.locator(`css=${selector}`).first();
      if (await locator.count() > 0 && await locator.isVisible()) {
        return elementCapture(page, selector, 'element_screenshot');
      }
    }
  }
  return fullPageCapture(page);
}

async function installNetworkControls(
  browserContext: BrowserContext,
  resolveHost: ResolveHost,
  toolId: string,
  invocation: ToolInvocationContext,
  pageDeadlines: WeakMap<Page, number>,
): Promise<{
  wasBlocked(page: Page | undefined): boolean;
  networkFailed(page: Page | undefined): boolean;
  timedOut(page: Page | undefined): boolean;
}> {
  const blockedPages = new WeakSet<Page>();
  const networkFailedPages = new WeakSet<Page>();
  const timedOutPages = new WeakSet<Page>();
  const pageRequestCounts = new WeakMap<Page, number>();
  const inFlightDns = new Map<string, Promise<void>>();
  let detachedRequestCount = 0;
  let invocationRequestCount = 0;

  const consumeRequestBudget = (page: Page | undefined): void => {
    invocationRequestCount += 1;
    const pageRequestCount = page
      ? (pageRequestCounts.get(page) ?? 0) + 1
      : detachedRequestCount + 1;
    if (page) pageRequestCounts.set(page, pageRequestCount);
    else detachedRequestCount = pageRequestCount;
    if (
      pageRequestCount > MAX_REQUESTS_PER_PAGE
      || invocationRequestCount > MAX_REQUESTS_PER_INVOCATION
    ) {
      throw new PublicWebAccessError('browser request budget exceeded');
    }
  };

  const validateRequestTarget = async (value: string, navigation: boolean): Promise<void> => {
    const url = parseBrowserUrl(
      value,
      navigation ? 'browser target' : 'browser resource',
      { allowCredentialQuery: !navigation },
    );
    const hostname = normalizedHostname(url);
    let check = inFlightDns.get(hostname);
    if (!check) {
      check = resolvePublicTarget(url, resolveHost).then(() => undefined);
      inFlightDns.set(hostname, check);
      const clear = () => {
        if (inFlightDns.get(hostname) === check) inFlightDns.delete(hostname);
      };
      void check.then(clear, clear);
    }
    await check;
  };

  await browserContext.route('**/*', async (route) => {
    const request = route.request();
    let page: Page | undefined;
    try { page = request.frame().page(); } catch { /* non-page requests use the Tool deadline */ }
    try {
      if (request.method() !== 'GET' && request.method() !== 'HEAD') {
        throw new PublicWebAccessError('browser requests must use GET or HEAD');
      }
      consumeRequestBudget(page);
      await runBounded(
        () => validateRequestTarget(request.url(), request.isNavigationRequest()),
        toolId,
        invocation,
        page ? pageDeadlines.get(page) ?? invocation.deadlineAt : invocation.deadlineAt,
      );
    } catch (error) {
      if (page) {
        const failureKind = retryablePageFailureKind(error, false);
        if (isFailureCode(error, 'navigation_timeout') || failureKind === 'timeout') {
          timedOutPages.add(page);
        } else if (error instanceof PublicWebAccessError) {
          blockedPages.add(page);
        } else if (failureKind === 'network') {
          networkFailedPages.add(page);
        } else {
          blockedPages.add(page);
        }
      }
      await route.abort('blockedbyclient');
      return;
    }
    await route.continue();
  });
  await browserContext.routeWebSocket('**/*', (socket) => socket.close());
  return {
    wasBlocked: (page) => page !== undefined && blockedPages.has(page),
    networkFailed: (page) => page !== undefined && networkFailedPages.has(page),
    timedOut: (page) => page !== undefined && timedOutPages.has(page),
  };
}

function pageFailure(
  page: PageInput,
  error: unknown,
  networkBlocked: boolean,
  timedOut: boolean,
): PageFailure {
  const explicitCode = failureCodeFrom(error);
  const code = timedOut
    ? 'navigation_timeout'
    : explicitCode
      ? explicitCode
      : networkBlocked
    ? 'robots_or_terms_blocked'
      : error instanceof Error && error.name === 'TimeoutError'
        ? 'navigation_timeout'
        : 'unsupported_content';
  const messages: Record<FailureCode, string> = {
    login_required: 'page requires authentication',
    captcha_required: 'page requires human verification',
    paywall: 'page content is behind a paywall',
    robots_or_terms_blocked: 'page or resource was blocked by access policy',
    navigation_timeout: 'page navigation timed out',
    no_capture_target: 'page has no eligible capture target',
    unsupported_content: 'page content could not be captured safely',
  };
  return {
    source_result_index: page.sourceResultIndex,
    requested_url: page.requestedUrl,
    code,
    sanitized_message: messages[code],
  };
}

async function detectAccessBoundary(page: Page, status: number, contentType: string): Promise<void> {
  if (status === 401) throw captureError('login_required', 'page requires authentication');
  if (status === 402) throw captureError('paywall', 'page requires payment');
  if (status === 403 || status === 451) throw captureError('robots_or_terms_blocked', 'page access is blocked');
  if (!contentType.toLowerCase().includes('text/html') && !contentType.toLowerCase().includes('application/xhtml+xml')) {
    throw captureError('unsupported_content', 'page is not HTML content');
  }
  const text = await page.evaluate(() => (document.body?.innerText ?? '').slice(0, 5_000));
  if (/captcha|verify you are human|人机验证|验证码/iu.test(text)) {
    throw captureError('captcha_required', 'page requires human verification');
  }
  const loginPath = (() => {
    try { return /(?:^|\/)(?:login|signin|passport|auth)(?:\/|$)/iu.test(new URL(page.url()).pathname); }
    catch { return false; }
  })();
  if (
    loginPath
    || /(?:sign|log) in (?:to|and) (?:continue|view|access)|please (?:sign|log) in|登录后查看|请先登录/iu.test(text)
  ) {
    throw captureError('login_required', 'page requires authentication');
  }
  if (/subscribe to continue|paywall|订阅后阅读|付费阅读/iu.test(text)) {
    throw captureError('paywall', 'page content is behind a paywall');
  }
}

async function closeQuietly(close: (() => Promise<unknown>) | undefined): Promise<void> {
  if (!close) return;
  try { await close(); } catch { /* cleanup is best-effort; primary failure is preserved */ }
}

async function confirmedBrowserClose(browser: Browser): Promise<boolean> {
  try {
    if (browserIsDisconnected(browser)) return true;
    await browser.close();
  } catch {
    // A rejected close is safe only when Playwright confirms the process disconnected.
  }
  return browserIsDisconnected(browser);
}

async function confirmedContextClose(context: BrowserContext): Promise<boolean> {
  try {
    await context.close();
    return true;
  } catch {
    return false;
  }
}

async function confirmedPageClose(page: Page): Promise<boolean> {
  try {
    await page.close();
    return true;
  } catch {
    try { return page.isClosed(); } catch { return false; }
  }
}

function browserIsDisconnected(browser: Browser): boolean {
  try { return !browser.isConnected(); } catch { return false; }
}

async function waitForClose(
  closeAttempt: Promise<boolean>,
  timeoutMs: number,
): Promise<boolean | null> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      closeAttempt,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function releaseWhenBrowserDisconnects(
  browser: Browser,
  release: () => void,
): void {
  try { browser.once('disconnected', release); } catch { /* injected test Browsers may omit events */ }
}

function cleanupFailure(toolId: string, primaryError: unknown): ToolInvocationError {
  if (primaryError instanceof ToolInvocationError && primaryError.kind === 'lease_lost') {
    return new ToolInvocationError(toolId, {
      kind: 'lease_lost',
      retryable: primaryError.retryable,
      providerStatus: primaryError.providerStatus,
      sanitizedMessage: primaryError.sanitizedMessage,
      receipt: primaryError.receipt ?? undefined,
      details: { ...primaryError.details, recovery: 'restart_worker' },
    });
  }
  return new ToolInvocationError(toolId, {
    kind: 'safety',
    retryable: false,
    sanitizedMessage: 'Chromium cleanup could not be confirmed',
    details: {
      recovery: 'restart_worker',
      ...(primaryError instanceof ToolInvocationError
        ? {
            primaryKind: primaryError.kind,
            ...(typeof primaryError.details.abortReason === 'string'
              ? { abortReason: primaryError.details.abortReason }
              : {}),
          }
        : {}),
    },
  });
}

export class PlaywrightPageCaptureAdapter implements ToolAdapter {
  readonly adapterType = 'playwright' as const;
  readonly implementationId = 'playwright-page-capture-v1';
  readonly executionMode = 'real' as const;
  private readonly gate: BrowserExecutionGate;
  private readonly launcher: PlaywrightLauncher;
  private readonly resolveHost: ResolveHost;
  private readonly getEffectiveUid: () => number | undefined;
  private readonly browserCloseTimeoutMs: number;
  private readonly pageTimeoutMs: number;
  private readonly now: () => Date;

  constructor(options: AdapterOptions = {}) {
    this.gate = options.gate ?? new BrowserExecutionGate();
    this.launcher = options.launcher ?? chromium;
    this.resolveHost = options.resolveHost ?? defaultResolveHost;
    this.getEffectiveUid = options.getEffectiveUid ?? (() => process.geteuid?.());
    this.browserCloseTimeoutMs = options.browserCloseTimeoutMs ?? BROWSER_CLOSE_TIMEOUT_MS;
    this.pageTimeoutMs = options.pageTimeoutMs ?? PAGE_TIMEOUT_MS;
    this.now = options.now ?? (() => new Date());
  }

  endpointHost(): null { return null; }

  async invoke(options: ToolInvokeOptions): Promise<ToolInvokeResult> {
    const start = performance.now();
    throwIfToolInvocationAborted(options.toolId, options.context);
    const uid = this.getEffectiveUid();
    if (!Number.isInteger(uid) || Number(uid) <= 0) {
      throw new ToolInvocationError(options.toolId, {
        kind: 'configuration', retryable: false, sanitizedMessage: 'Chromium requires a verified non-root user',
      });
    }
    const capture = captureOptions(options.input);
    const normalized = await normalizePages(
      options.input,
      capture.uniqueHostnames,
      this.resolveHost,
      options.toolId,
      options.context,
    );
    if (normalized.pages.length === 0) {
      const retryable = normalized.retryableFailureKind !== null;
      throw new ToolInvocationError(options.toolId, {
        kind: normalized.retryableFailureKind ?? 'unknown',
        retryable,
        sanitizedMessage: 'no eligible public pages were provided',
        details: { page_failures: normalized.failures },
      });
    }

    const gateLease = await this.gate.acquire(options.toolId, options.context);
    let browser: Browser | undefined;
    let context: BrowserContext | undefined;
    let launchAttempt: Promise<Browser> | undefined;
    let launchSettled = false;
    let launchedBrowser: Browser | undefined;
    let primaryError: unknown;
    let recoveryDeadlineAt: number | undefined;
    const cleanupDeadline = () => {
      const recovering = options.context.signal.aborted || Date.now() >= options.context.deadlineAt;
      if (recovering) {
        recoveryDeadlineAt ??= Date.now() + this.browserCloseTimeoutMs;
        return recoveryDeadlineAt;
      }
      return Math.min(
        options.context.deadlineAt,
        Date.now() + this.browserCloseTimeoutMs,
      );
    };
    try {
      throwIfToolInvocationAborted(options.toolId, options.context);
      try {
        launchAttempt = this.launcher.launch({
          headless: true,
          chromiumSandbox: true,
          timeout: Math.max(1, options.context.deadlineAt - Date.now()),
        }).then(
          (value) => {
            launchSettled = true;
            launchedBrowser = value;
            return value;
          },
          (error: unknown) => {
            launchSettled = true;
            throw error;
          },
        );
        browser = await runBounded(
          () => launchAttempt!,
          options.toolId,
          options.context,
          options.context.deadlineAt,
        );
        throwIfToolInvocationAborted(options.toolId, options.context);
        context = await runBounded(
          () => browser!.newContext({
            viewport: capture.viewport,
            deviceScaleFactor: 1,
            serviceWorkers: 'block',
            acceptDownloads: false,
            permissions: [],
          }),
          options.toolId,
          options.context,
          options.context.deadlineAt,
        );
        throwIfToolInvocationAborted(options.toolId, options.context);
      } catch (error) {
        if (error instanceof ToolInvocationError) throw error;
        if (options.context.signal.aborted || Date.now() >= options.context.deadlineAt) {
          throw toolAbortError(options.toolId, options.context.signal, options.context.deadlineAt);
        }
        throw new ToolInvocationError(options.toolId, {
          kind: 'configuration', retryable: false, sanitizedMessage: 'Chromium sandbox could not be started',
        });
      }
      const pageDeadlines = new WeakMap<Page, number>();
      const controls = await runBounded(
        () => installNetworkControls(
          context!,
          this.resolveHost,
          options.toolId,
          options.context,
          pageDeadlines,
        ),
        options.toolId,
        options.context,
        options.context.deadlineAt,
      );
      const captures: CaptureMetadata[] = [];
      const attachments: ToolMediaAttachment[] = [];
      const failures = [...normalized.failures];
      let retryableFailureKind = normalized.retryableFailureKind;
      const interactionBlocked = new WeakSet<Page>();
      const backgroundClosures = new Set<Promise<void>>();
      const scheduleClosure = (close: () => Promise<unknown>, deadlineAt: number) => {
        let task!: Promise<void>;
        task = runBounded(close, options.toolId, options.context, deadlineAt)
          .then(() => undefined, () => undefined)
          .finally(() => backgroundClosures.delete(task));
        backgroundClosures.add(task);
      };
      let totalBytes = 0;

      const processPage = async (pageInput: PageInput): Promise<boolean> => {
          let page: Page | undefined;
          let pageDeadlineAt = options.context.deadlineAt;
          let pageCloseConfirmed = true;
          let candidate: {
            metadata: CaptureMetadata;
            attachment: ToolMediaAttachment;
          } | undefined;
          try {
            throwIfToolInvocationAborted(options.toolId, options.context);
            page = await runBounded(
              () => context!.newPage(),
              options.toolId,
              options.context,
              options.context.deadlineAt,
            );
            pageDeadlineAt = Math.min(options.context.deadlineAt, Date.now() + this.pageTimeoutMs);
            pageDeadlines.set(page, pageDeadlineAt);
            page.on('popup', (popup) => {
              interactionBlocked.add(page!);
              scheduleClosure(() => popup.close(), pageDeadlineAt);
            });
            page.on('download', (download) => {
              interactionBlocked.add(page!);
              scheduleClosure(() => download.cancel(), pageDeadlineAt);
            });
            const response = await runBounded(
              () => page!.goto(pageInput.url.toString(), {
                waitUntil: 'domcontentloaded',
                timeout: Math.max(1, pageDeadlineAt - Date.now()),
              }),
              options.toolId,
              options.context,
              pageDeadlineAt,
              page,
            );
            throwIfToolInvocationAborted(options.toolId, options.context);
            if (!response) throw captureError('unsupported_content', 'page navigation returned no response');
            await runBounded(
              () => detectAccessBoundary(page!, response.status(), response.headers()['content-type'] ?? ''),
              options.toolId,
              options.context,
              pageDeadlineAt,
              page,
            );
            const beforeCaptureUrl = await runBounded(
              () => validateTarget(page!.url(), this.resolveHost),
              options.toolId,
              options.context,
              pageDeadlineAt,
            );
            const visual = await runBounded(
              () => capturePageVisual(page!, {
                mode: capture.mode,
                selector: capture.selector,
                viewport: capture.viewport,
              }),
              options.toolId,
              options.context,
              pageDeadlineAt,
              page,
            );
            const finalUrl = await runBounded(
              () => validateTarget(page!.url(), this.resolveHost),
              options.toolId,
              options.context,
              pageDeadlineAt,
            );
            if (beforeCaptureUrl.toString() !== finalUrl.toString()) {
              throw captureError('unsupported_content', 'page URL changed during capture');
            }
            const attachmentId = `capture-${pageInput.sourceResultIndex + 1}`;
            const capturedAt = this.now().toISOString();
            const contentSha256 = `sha256:${createHash('sha256').update(visual.bytes).digest('hex')}`;
            const pageTitle = boundedMessage(await runBounded(
              () => page!.title(),
              options.toolId,
              options.context,
              pageDeadlineAt,
              page,
            ));
            candidate = {
              metadata: {
                attachment_id: attachmentId,
                source_result_index: pageInput.sourceResultIndex,
                requested_url: pageInput.requestedUrl,
                final_url: finalUrl.toString(),
                page_title: pageTitle,
                captured_at: capturedAt,
                capture_mode: visual.captureMode,
                ...(visual.selector ? { selector: visual.selector } : {}),
                viewport: capture.viewport,
                media_type: visual.mediaType,
                width: visual.width,
                height: visual.height,
                byte_size: visual.bytes.byteLength,
                content_sha256: contentSha256,
                truncated: visual.truncated,
              },
              attachment: {
                attachmentId,
                bytes: visual.bytes,
                mediaType: visual.mediaType,
                contentSha256,
                sourcePageUrl: pageInput.requestedUrl,
                capturedAt,
                captureMode: visual.captureMode,
                ...(visual.selector ? { selector: visual.selector } : {}),
                viewport: capture.viewport,
                width: visual.width,
                height: visual.height,
              },
            };
          } catch (error) {
            if (options.context.signal.aborted || Date.now() >= options.context.deadlineAt) {
              throw toolAbortError(options.toolId, options.context.signal, options.context.deadlineAt);
            }
            const routeFailureKind = controls.timedOut(page)
              ? 'timeout'
              : controls.wasBlocked(page)
                  ? null
                  : controls.networkFailed(page)
                    ? 'network'
                  : retryablePageFailureKind(error, false);
            retryableFailureKind ??= routeFailureKind;
            failures.push(pageFailure(
              pageInput,
              error,
              controls.wasBlocked(page),
              controls.timedOut(page),
            ));
          } finally {
            if (page) {
              const closeAttempt = confirmedPageClose(page);
              const remaining = Math.max(0, cleanupDeadline() - Date.now());
              const closeResult = await waitForClose(closeAttempt, remaining);
              pageCloseConfirmed = closeResult === true;
            }
          }
          if (!candidate) return false;
          if (!pageCloseConfirmed) {
            const timedOut = Date.now() >= pageDeadlineAt;
            if (timedOut) retryableFailureKind ??= 'timeout';
            failures.push(pageFailure(
              pageInput,
              captureError(
                timedOut ? 'navigation_timeout' : 'unsupported_content',
                'page cleanup could not be confirmed',
              ),
              false,
              timedOut,
            ));
            return false;
          }
          if (page && interactionBlocked.has(page)) {
            failures.push(pageFailure(
              pageInput,
              captureError('robots_or_terms_blocked', 'page attempted a popup or download'),
              true,
              false,
            ));
            return false;
          }
          const nextTotalBytes = totalBytes + candidate.attachment.bytes.byteLength;
          if (nextTotalBytes > MAX_TOTAL_BYTES) {
            failures.push(pageFailure(
              pageInput,
              captureError('unsupported_content', 'capture sidecar exceeds 40 MiB'),
              false,
              false,
            ));
            return false;
          }
          totalBytes = nextTotalBytes;
          captures.push(candidate.metadata);
          attachments.push(candidate.attachment);
          return true;
      };

      const candidateGroups = new Map<string, { pages: PageInput[]; cursor: number; active: boolean; succeeded: boolean }>();
      for (const page of normalized.pages) {
        const key = capture.uniqueHostnames ? page.hostname : String(page.sourceResultIndex);
        const group = candidateGroups.get(key) ?? { pages: [], cursor: 0, active: false, succeeded: false };
        group.pages.push(page);
        candidateGroups.set(key, group);
      }
      let activeCandidates = 0;
      const reserved = new Map<PageInput, { pages: PageInput[]; cursor: number; active: boolean; succeeded: boolean }>();
      const reservePage = (): PageInput | undefined => {
        if (captures.length + activeCandidates >= capture.maxPages) return undefined;
        for (const group of candidateGroups.values()) {
          if (group.active || group.succeeded || group.cursor >= group.pages.length) continue;
          group.active = true;
          const page = group.pages[group.cursor++]!;
          reserved.set(page, group);
          activeCandidates += 1;
          return page;
        }
        return undefined;
      };
      const worker = async () => {
        while (true) {
          const pageInput = reservePage();
          if (!pageInput) return;
          const group = reserved.get(pageInput)!;
          try {
            group.succeeded = await processPage(pageInput);
          } finally {
            group.active = false;
            reserved.delete(pageInput);
            activeCandidates -= 1;
          }
        }
      };
      const workerResults = await Promise.allSettled(Array.from(
        { length: Math.min(MAX_PAGE_CONCURRENCY, normalized.pages.length) },
        () => worker(),
      ));
      await Promise.all([...backgroundClosures]);
      const rejectedWorker = workerResults.find((result) => result.status === 'rejected');
      if (rejectedWorker?.status === 'rejected') throw rejectedWorker.reason;
      throwIfToolInvocationAborted(options.toolId, options.context);
      captures.sort((left, right) => left.source_result_index - right.source_result_index);
      attachments.sort((left, right) => {
        const leftCapture = captures.findIndex(({ attachment_id }) => attachment_id === left.attachmentId);
        const rightCapture = captures.findIndex(({ attachment_id }) => attachment_id === right.attachmentId);
        return leftCapture - rightCapture;
      });
      failures.sort((left, right) => left.source_result_index - right.source_result_index);
      if (captures.length === 0) {
        const retryable = retryableFailureKind !== null;
        throw new ToolInvocationError(options.toolId, {
          kind: retryableFailureKind ?? 'unknown',
          retryable,
          sanitizedMessage: 'all eligible pages failed capture',
          details: { page_failures: failures },
        });
      }
      const latencyMs = Math.round(performance.now() - start);
      return {
        output: { captures, failures, security_profile: SECURITY_PROFILE },
        mediaAttachments: attachments,
        latencyMs,
        receipt: {
          declaredAdapterType: options.manifest.adapter_type,
          resolvedAdapterType: 'playwright',
          implementationId: this.implementationId,
          executionMode: 'real',
          endpointHost: null,
          status: 'ok',
          latencyMs,
          ...(options.attemptId ? { attemptId: options.attemptId } : {}),
          ...(options.retryOf === undefined ? {} : { retryOf: options.retryOf }),
        },
      };
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      if (!browser) {
        if (launchedBrowser) {
          releaseWhenBrowserDisconnects(launchedBrowser, () => gateLease.release());
          const lateClose = confirmedBrowserClose(launchedBrowser);
          if (browserIsDisconnected(launchedBrowser)) gateLease.release();
          else void lateClose.then((closed) => { if (closed) gateLease.release(); });
          if (!browserIsDisconnected(launchedBrowser)) {
            throw cleanupFailure(options.toolId, primaryError);
          }
        } else if (launchSettled || !launchAttempt) {
          gateLease.release();
        } else {
          const lateClose = launchAttempt.then(
            (lateBrowser) => {
              releaseWhenBrowserDisconnects(lateBrowser, () => gateLease.release());
              return confirmedBrowserClose(lateBrowser);
            },
            () => true,
          );
          void lateClose.then((closed) => { if (closed) gateLease.release(); });
          throw cleanupFailure(options.toolId, primaryError);
        }
      } else {
        let released = false;
        const release = () => {
          if (released) return;
          released = true;
          gateLease.release();
        };
        releaseWhenBrowserDisconnects(browser, release);
        const cleanupDeadlineAt = cleanupDeadline();
        if (context) {
          await waitForClose(
            confirmedContextClose(context),
            Math.max(0, cleanupDeadlineAt - Date.now()),
          );
        }
        const finalClose = confirmedBrowserClose(browser);
        const closed = await waitForClose(
          finalClose,
          Math.max(0, cleanupDeadlineAt - Date.now()),
        );
        if (closed === true || closed === null && browserIsDisconnected(browser)) {
          release();
        } else {
          void finalClose.then((eventuallyClosed) => { if (eventuallyClosed) release(); });
          throw cleanupFailure(options.toolId, primaryError);
        }
      }
    }
  }
}
