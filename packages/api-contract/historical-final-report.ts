import type {
  NativeFinalReport,
  SourceReference,
} from './native-skill-orchestration.ts';

export const HISTORICAL_FINAL_REPORT_VERSION = 'final-report-v1' as const;

export interface HistoricalFinalReportSkillReference {
  skillId: string;
  invocationId: string;
  status: 'completed' | 'completed_with_gaps';
  path: string;
}

export interface HistoricalFinalReportV1 {
  version: typeof HISTORICAL_FINAL_REPORT_VERSION;
  taskId: string;
  planVersionId: string;
  attemptId: string;
  mode: 'single_skill' | 'multi_skill';
  title: string;
  markdown: string;
  sources: SourceReference[];
  gaps: string[];
  skillReports: HistoricalFinalReportSkillReference[];
}

export type ControlFinalReport = NativeFinalReport | HistoricalFinalReportV1;

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const SAFE_REPORT_PATH = /^skill-results\/[A-Za-z0-9][A-Za-z0-9._%+-]*\.json$/u;
const SOURCE_TYPES = new Set<SourceReference['type']>(['user_input', 'knowledge', 'tool_result']);
const REPORT_STATUSES = new Set<HistoricalFinalReportSkillReference['status']>([
  'completed',
  'completed_with_gaps',
]);

function fail(field: string): never {
  throw new Error(`HistoricalFinalReportV1 ${field} is invalid`);
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(field);
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  field: string,
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of required) if (!Object.hasOwn(value, key)) fail(`${field}.${key}`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`${field}.${key}`);
}

function nonBlank(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) fail(field);
  return value;
}

function identifier(value: unknown, field: string): string {
  const parsed = nonBlank(value, field);
  if (!SAFE_ID.test(parsed)) fail(field);
  return parsed;
}

function uniqueStrings(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) fail(field);
  const parsed = value.map((item, index) => nonBlank(item, `${field}[${index}]`));
  if (new Set(parsed).size !== parsed.length) fail(field);
  return parsed;
}

function sourceReferences(value: unknown): SourceReference[] {
  if (!Array.isArray(value)) fail('sources');
  const parsed = value.map((candidate, index): SourceReference => {
    const field = `sources[${index}]`;
    const item = record(candidate, field);
    exactKeys(item, ['id', 'title', 'type'], ['url'], field);
    const id = identifier(item.id, `${field}.id`);
    if (!id.startsWith('S-')) fail(`${field}.id`);
    if (typeof item.type !== 'string' || !SOURCE_TYPES.has(item.type as SourceReference['type'])) {
      fail(`${field}.type`);
    }
    let url: string | undefined;
    if (item.url !== undefined) {
      url = nonBlank(item.url, `${field}.url`);
      try {
        if (new URL(url).protocol !== 'https:') fail(`${field}.url`);
      } catch {
        fail(`${field}.url`);
      }
    }
    return {
      id,
      title: nonBlank(item.title, `${field}.title`),
      type: item.type as SourceReference['type'],
      ...(url ? { url } : {}),
    };
  });
  if (new Set(parsed.map(({ id }) => id)).size !== parsed.length) fail('sources.id');
  return parsed;
}

export function parseHistoricalFinalReportV1(value: unknown): HistoricalFinalReportV1 {
  const root = record(value, 'value');
  exactKeys(
    root,
    ['version', 'taskId', 'planVersionId', 'attemptId', 'mode', 'title', 'markdown', 'sources', 'gaps', 'skillReports'],
    [],
    'value',
  );
  if (root.version !== HISTORICAL_FINAL_REPORT_VERSION) fail('version');
  if (root.mode !== 'single_skill' && root.mode !== 'multi_skill') fail('mode');
  if (!Array.isArray(root.skillReports) || root.skillReports.length === 0) fail('skillReports');
  const skillReports = root.skillReports.map((candidate, index): HistoricalFinalReportSkillReference => {
    const field = `skillReports[${index}]`;
    const item = record(candidate, field);
    exactKeys(item, ['skillId', 'invocationId', 'status', 'path'], [], field);
    if (typeof item.status !== 'string' || !REPORT_STATUSES.has(item.status as HistoricalFinalReportSkillReference['status'])) {
      fail(`${field}.status`);
    }
    const path = nonBlank(item.path, `${field}.path`);
    if (!SAFE_REPORT_PATH.test(path)) fail(`${field}.path`);
    return {
      skillId: identifier(item.skillId, `${field}.skillId`),
      invocationId: identifier(item.invocationId, `${field}.invocationId`),
      status: item.status as HistoricalFinalReportSkillReference['status'],
      path,
    };
  });
  if (new Set(skillReports.map(({ invocationId }) => invocationId)).size !== skillReports.length) {
    fail('skillReports.invocationId');
  }
  if (root.mode === 'single_skill' && skillReports.length !== 1) fail('skillReports');
  return {
    version: HISTORICAL_FINAL_REPORT_VERSION,
    taskId: identifier(root.taskId, 'taskId'),
    planVersionId: identifier(root.planVersionId, 'planVersionId'),
    attemptId: identifier(root.attemptId, 'attemptId'),
    mode: root.mode,
    title: nonBlank(root.title, 'title'),
    markdown: nonBlank(root.markdown, 'markdown'),
    sources: sourceReferences(root.sources),
    gaps: uniqueStrings(root.gaps, 'gaps'),
    skillReports,
  };
}
