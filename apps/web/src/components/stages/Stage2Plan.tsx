import { useState } from 'react';
import {
  COMPETITIVE_WEIGHT_TITLE,
  extractCompetitiveScoringWeights,
} from '../../../../orchestrator-runtime/src/report/competitive-weight-chart.ts';
import type { NativeSkillInvocation } from '../../../../../packages/api-contract/native-skill-orchestration.ts';
import type { CurrentPlanStep } from '../../../../../packages/api-contract/research-deliverable.ts';
import type {
  DatasetUpload,
  DocumentUpload,
  PlanResponse,
  PlanStep,
  PendingUpload,
  VisualUpload,
} from '../../api/client.ts';
import { MultiSkillPlanSummary } from '../MultiSkillPlanSummary.tsx';
import { multiSkillPlanViewModel } from '../../multi-skill-view-model.ts';
import { Header } from './Stage1Understand.tsx';
import {
  buildPlanConfirmationPayload,
  parseDatasetColumns,
  reconcileDatasetColumnMetadata,
} from './stage2-plan-confirmation.ts';

const IMAGE_FILE_ACCEPT = '.jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp';
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const MAX_VISUAL_FILES = 12;
const MAX_DOCUMENT_FILES = 20;

function pendingInputLabel(input: PendingUpload): string {
  return input.label;
}

function pendingInputQuestion(input: PendingUpload, fallback?: string): string {
  return fallback ?? input.label;
}

// 段2 · 待执行计划(HITL 硬闸门):步骤列表 + 假设可就地编辑 + 待传图片 + 确认按钮。
// locked=true 时(已进入执行)隐藏确认按钮、禁用编辑。
export function Stage2Plan({
  plan, locked, revising, onConfirm, onRevise,
}: {
  plan: PlanResponse;
  locked: boolean;
  revising: boolean;
  onConfirm: (
    confirmationAnswers: Record<string, unknown>,
    inputValues: Record<string, unknown>,
    visualUploads: VisualUpload[],
    datasetUploads: DatasetUpload[],
    documentUploads: DocumentUpload[],
    waivedInputKeys: string[],
  ) => Promise<void>;
  onRevise: (instruction: string) => void;
}) {
  const confirmations = 'confirmations' in plan.task
    ? confirmationRequirements(plan.task.confirmations)
    : [];
  const scoringWeights = extractCompetitiveScoringWeights(plan.plan);
  const resourceGaps = plan.plan.skill_invocations?.flatMap((invocation) => (
    'resource_gaps' in invocation && Array.isArray(invocation.resource_gaps)
      ? invocation.resource_gaps.map((gap) => ({ ...gap, skillId: invocation.skill_id }))
      : []
  )) ?? [];
  const nativeInvocations = (plan.plan.skill_invocations ?? []).filter(
    (invocation): invocation is NativeSkillInvocation => 'run_spec' in invocation,
  );
  const nativeToolBindings = nativeInvocations.flatMap(({ skill_id: skillId, run_spec: runSpec }) => (
    runSpec.tool_bindings.map((binding) => ({ ...binding, skillId }))
  ));
  const nativeKnowledge = nativeInvocations.flatMap(({ skill_id: skillId, run_spec: runSpec }) => (
    runSpec.selected_references.map((reference) => ({ ...reference, skillId }))
  ));
  const nativeRequirementByKey = new Map(nativeInvocations.flatMap(({ run_spec: runSpec }) => (
    runSpec.input_requirements.map((requirement) => [requirement.key, requirement] as const)
  )));
  const portfolio = multiSkillPlanViewModel(plan.plan);
  const orchestrationLabel = plan.plan.execution_contract_version === 'native-skill-execution-plan-v1'
    ? plan.plan.mode === 'multi_skill' ? '多项能力协作' : '单项能力执行'
    : plan.plan.execution_contract_version === 'current-execution-plan-v3'
      ? '多项能力协作'
      : '单项能力执行';
  const [assumptions, setAssumptions] = useState(plan.task.assumptions);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [confirmed, setConfirmed] = useState(false);
  const [images, setImages] = useState<Record<string, File[]>>({});
  const [datasets, setDatasets] = useState<Record<string, DatasetUpload | undefined>>({});
  const [documents, setDocuments] = useState<Record<string, File[]>>({});
  const [datasetColumns, setDatasetColumns] = useState<Record<string, string[]>>({});
  const [datasetHeaderErrors, setDatasetHeaderErrors] = useState<Record<string, string | undefined>>({});
  const [values, setValues] = useState<Record<string, string>>({});
  const [waivedInputKeys, setWaivedInputKeys] = useState<string[]>([]);
  const [revisionInstruction, setRevisionInstruction] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const formLocked = locked || confirmed || submitting;

  function edit(key: string, value: string) {
    setAssumptions((prev) => prev.map((a) => (a.key === key ? { ...a, value } : a)));
  }

  function pickImages(pu: PendingUpload, files: File[]): void {
    if (files.length > MAX_VISUAL_FILES) {
      setImages((previous) => ({ ...previous, [pu.role]: [] }));
      setSubmitError(`每项图片材料最多上传 ${MAX_VISUAL_FILES} 张`);
      return;
    }
    if (files.some(({ size }) => size > MAX_UPLOAD_BYTES)) {
      setImages((previous) => ({ ...previous, [pu.role]: [] }));
      setSubmitError('单张图片不能超过 10 MiB');
      return;
    }
    setSubmitError('');
    setImages((previous) => ({
      ...previous,
      [pu.role]: pu.multiple ? files : files.slice(0, 1),
    }));
  }

  function pickDocuments(input: PendingUpload, files: File[]): void {
    if (files.length > MAX_DOCUMENT_FILES) {
      setDocuments((previous) => ({ ...previous, [input.role]: [] }));
      setSubmitError(`每项文档材料最多上传 ${MAX_DOCUMENT_FILES} 个文件`);
      return;
    }
    if (files.some(({ size }) => size > MAX_UPLOAD_BYTES)) {
      setDocuments((previous) => ({ ...previous, [input.role]: [] }));
      setSubmitError('单个文档不能超过 10 MiB');
      return;
    }
    setSubmitError('');
    setDocuments((previous) => ({
      ...previous,
      [input.role]: input.multiple ? files : files.slice(0, 1),
    }));
  }

  async function pickDataset(role: string, file: File | undefined): Promise<void> {
    if (!file) {
      setDatasets((previous) => ({ ...previous, [role]: undefined }));
      setDatasetColumns((previous) => ({ ...previous, [role]: [] }));
      setDatasetHeaderErrors((previous) => ({ ...previous, [role]: undefined }));
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setDatasets((previous) => ({ ...previous, [role]: undefined }));
      setDatasetColumns((previous) => ({ ...previous, [role]: [] }));
      setDatasetHeaderErrors((previous) => ({ ...previous, [role]: 'CSV 文件不能超过 10 MiB' }));
      return;
    }
    let columns: string[];
    setSubmitError('');
    try {
      columns = parseDatasetColumns(await file.text());
      setDatasetHeaderErrors((previous) => ({ ...previous, [role]: undefined }));
    } catch (error) {
      columns = [];
      setDatasetHeaderErrors((previous) => ({
        ...previous,
        [role]: error instanceof Error ? error.message : '无法读取 CSV 表头',
      }));
    }
    setDatasetColumns((previous) => ({ ...previous, [role]: columns }));
    setDatasets((previous) => {
      const metadata = reconcileDatasetColumnMetadata({
        rowMeaning: previous[role]?.metadata.rowMeaning ?? '',
        timeRange: previous[role]?.metadata.timeRange ?? '',
        fieldNotes: previous[role]?.metadata.fieldNotes ?? {},
        units: previous[role]?.metadata.units ?? {},
        sampling: previous[role]?.metadata.sampling ?? '',
        piiConfirmedAbsent: previous[role]?.metadata.piiConfirmedAbsent ?? false,
      }, columns);
      return { ...previous, [role]: { role, file, metadata } };
    });
  }

  function editDatasetMetadata(
    role: string,
    field: 'rowMeaning' | 'timeRange' | 'sampling' | 'piiConfirmedAbsent',
    value: string | boolean,
  ): void {
    setDatasets((previous) => {
      const current = previous[role];
      if (!current) return previous;
      return {
        ...previous,
        [role]: { ...current, metadata: { ...current.metadata, [field]: value } },
      };
    });
  }

  function editDatasetColumnMetadata(
    role: string,
    field: 'fieldNotes' | 'units',
    column: string,
    value: string,
  ): void {
    setDatasets((previous) => {
      const current = previous[role];
      if (!current) return previous;
      return {
        ...previous,
        [role]: {
          ...current,
          metadata: {
            ...current.metadata,
            [field]: { ...current.metadata[field], [column]: value },
          },
        },
      };
    });
  }

  async function confirm(): Promise<void> {
    if (submitting || missingAnswers.length > 0 || missingInputs.length > 0 || (portfolio?.uncoveredRequiredDemandIds.length ?? 0) > 0) return;
    const payload = buildPlanConfirmationPayload({
      confirmationAnswers: answers,
      pending,
      values,
      images,
      datasets,
      documents,
      waivedInputKeys: effectiveWaivedInputKeys,
    });
    setSubmitting(true);
    setSubmitError('');
    try {
      await onConfirm(
        payload.confirmationAnswers,
        payload.inputValues,
        payload.visualUploads,
        payload.datasetUploads,
        payload.documentUploads ?? [],
        payload.waivedInputKeys ?? [],
      );
      setConfirmed(true);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : '信息上传或确认失败，请重试');
    } finally {
      setSubmitting(false);
    }
  }

  const pending = plan.pendingUploads ?? [];
  const hideLegacyDesignImage = pending.some(({ role, kind }) => role === 'jd_screenshots' && kind === 'visual');
  const visiblePending = pending.filter(({ role }) => !(hideLegacyDesignImage && role === 'designImage'));
  const implicitWaivedInputKeys = hideLegacyDesignImage
    ? pending.filter(({ role }) => role === 'designImage').map(({ role }) => role)
    : [];
  const effectiveWaivedInputKeys = [...new Set([...waivedInputKeys, ...implicitWaivedInputKeys])];
  const nativeInputs = plan.plan.resolved_inputs;
  const pendingRequirementByKey = new Map(
    nativeInputs?.pending.map((item) => [item.requirement.key, item]) ?? [],
  );
  const waivedSet = new Set(effectiveWaivedInputKeys);
  const missingAnswers = confirmations.filter(({ key }) => !answers[key]?.trim());
  const missingInputs = visiblePending.filter((input) => {
    const requirement = pendingRequirementByKey.get(input.role)?.requirement;
    if (requirement?.required === false && waivedSet.has(input.role)) return false;
    if (input.kind === 'document') return (documents[input.role] ?? []).length === 0;
    if (input.kind === 'visual') return (images[input.role] ?? []).length === 0;
    if (input.kind === 'value') {
      const raw = values[input.role] ?? '';
      return input.multiple
        ? raw.split('\n').every((item) => item.trim() === '')
        : raw.trim() === '';
    }
    if (input.kind === 'dataset') {
      const dataset = datasets[input.role];
      return !dataset
        || Boolean(datasetHeaderErrors[input.role])
        || !dataset.metadata.rowMeaning.trim()
        || !dataset.metadata.timeRange.trim()
        || !dataset.metadata.sampling.trim();
    }
    return true;
  });

  function optionalWaiver(role: string) {
    const item = pendingRequirementByKey.get(role);
    if (item?.requirement.required !== false) return null;
    return (
      <label style={{ display: 'flex', gap: 7, alignItems: 'center', color: 'var(--text-dim)', fontSize: 12 }}>
        <input
          type="checkbox"
          checked={waivedSet.has(role)}
          disabled={formLocked}
          onChange={(event) => setWaivedInputKeys((previous) => event.target.checked
            ? [...new Set([...previous, role])]
            : previous.filter((key) => key !== role))}
        />
        暂时无法提供，继续执行并在报告中标记资料缺口
      </label>
    );
  }

  return (
    <section className="stage-card">
      <Header n="2" title="补充信息并确认" note={submitting ? '正在上传并确认…' : locked ? '内容已锁定' : '一次提交本次分析所需信息'} />
      <p style={{ margin: '-2px 0 12px', color: 'var(--text-faint)', fontSize: 12 }}>
        运行模式：{orchestrationLabel}
      </p>

      <MultiSkillPlanSummary plan={plan.plan} />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {plan.plan.steps.map((s) => <StepRow key={s.step_no} step={s} />)}
      </div>

      {scoringWeights.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <div style={{ marginBottom: 6, color: 'var(--text-faint)', fontSize: 12 }}>
            {COMPETITIVE_WEIGHT_TITLE}
          </div>
          <dl style={{ margin: 0, borderTop: '1px solid var(--border-soft)' }}>
            {scoringWeights.map(({ dimension, percentage }) => (
              <div
                key={dimension}
                style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: 16, padding: '7px 0', borderBottom: '1px solid var(--border-soft)', fontSize: 13 }}
              >
                <dt style={{ minWidth: 0, color: 'var(--text-dim)' }}>{dimension}</dt>
                <dd style={{ margin: 0, fontFamily: 'var(--mono)', fontVariantNumeric: 'tabular-nums' }}>{percentage}%</dd>
              </div>
            ))}
          </dl>
        </div>
      )}

      {nativeToolBindings.length > 0 && (
        <div style={{ marginTop: 16, padding: '10px 12px', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }}>
          <strong>外部能力状态</strong>
          <div>
            已接入 {nativeToolBindings.filter(({ status }) => status === 'bound').length} 项
            {nativeToolBindings.some(({ status }) => status !== 'bound')
              ? `；尚未接入 ${nativeToolBindings.filter(({ status }) => status !== 'bound').length} 项，报告将标明相应资料缺口`
              : ''}
          </div>
        </div>
      )}

      {nativeKnowledge.length > 0 && (
        <div style={{ marginTop: 16, padding: '10px 12px', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }}>
          <strong>分析方法与知识</strong>
          <div>已冻结 {nativeKnowledge.length} 份本次分析所需材料。</div>
        </div>
      )}

      {resourceGaps.length > 0 && (
        <div style={{ marginTop: 16, padding: '10px 12px', border: '1px solid rgba(251,191,36,.3)', borderRadius: 8, color: 'var(--warn)', fontSize: 12 }}>
          <strong>知识资源缺口</strong>
          <div>部分可选知识材料暂不可用，报告将标明相应资料缺口。</div>
        </div>
      )}

      <div style={{ marginTop: 16 }}>
        <div style={{ fontSize: 12, color: 'var(--text-faint)', marginBottom: 6 }}>系统假设(可点击编辑)</div>
        {assumptions.map((a, index) => (
          <div key={a.key} style={{ display: 'flex', gap: 8, marginBottom: 6, fontSize: 13 }}>
            <span style={{ color: 'var(--text-dim)', width: 120, flexShrink: 0 }}>补充条件 {index + 1}</span>
            {a.editable && !formLocked ? (
              <input
                value={a.value}
                onChange={(e) => edit(a.key, e.target.value)}
                style={{ flex: 1, background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)', padding: '4px 8px', fontSize: 13 }}
              />
            ) : (
              <span style={{ flex: 1 }}>{a.value}</span>
            )}
          </div>
        ))}
      </div>

      {confirmations.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <div style={{ fontSize: 12, color: 'var(--text-faint)', marginBottom: 8 }}>确认项（必须由你明确回答）</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {confirmations.map((confirmation) => (
              <label key={confirmation.key} style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: 13 }}>
                <span>{confirmation.question ?? confirmation.key}</span>
                {confirmation.suggestion !== undefined && (
                  <span style={{ color: 'var(--text-faint)', fontSize: 12 }}>
                    建议（不会自动采用）：{formatSuggestion(confirmation.suggestion)}
                  </span>
                )}
                <input
                  required
                  disabled={formLocked}
                  value={answers[confirmation.key] ?? ''}
                  onChange={(event) => setAnswers((previous) => ({
                    ...previous,
                    [confirmation.key]: event.target.value,
                  }))}
                  placeholder="请输入你的明确回答"
                  style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)', padding: '7px 9px', fontSize: 13 }}
                />
              </label>
            ))}
          </div>
        </div>
      )}

      {nativeInputs && nativeInputs.resolved.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <div style={{ fontSize: 12, color: 'var(--text-faint)', marginBottom: 6 }}>已解析输入（可通过重新生成计划纠正）</div>
          <ul style={{ margin: 0, paddingLeft: 20 }}>
            {nativeInputs.resolved.map((input) => (
              <li key={input.key}>
                {nativeRequirementByKey.get(input.key)?.label ?? '已提供输入'}
                {' '}· {input.source === 'conversation' ? '来自当前需求' : input.source === 'upload' ? '来自上传材料' : '来自已授权数据'}
              </li>
            ))}
          </ul>
        </div>
      )}

      {visiblePending.some((input) => input.kind === 'value') && !locked && (
        <div style={{ marginTop: 16 }}>
          <div style={{ fontSize: 12, color: 'var(--text-faint)', marginBottom: 6 }}>待补充输入</div>
          {visiblePending.filter((input) => input.kind === 'value').map((input) => (
            <label key={input.role} style={{ display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 10, fontSize: 13 }}>
              <span>
                {pendingInputQuestion(input, pendingRequirementByKey.get(input.role)?.requirement.question)}
                <span style={{ color: 'var(--text-faint)', fontSize: 11 }}>
                  {' '}· {pendingRequirementByKey.get(input.role)?.requirement.required === false ? '可选' : '必需'}
                  {' '}· 将用于本次分析
                </span>
              </span>
              {input.multiple ? (
                <textarea
                  disabled={formLocked || waivedSet.has(input.role)}
                  value={values[input.role] ?? ''}
                  onChange={(event) => setValues((previous) => ({ ...previous, [input.role]: event.target.value }))}
                  placeholder="每行填写一个值"
                  rows={3}
                  style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)', padding: '7px 9px', fontSize: 13, resize: 'vertical' }}
                />
              ) : (
                <input
                  required={pendingRequirementByKey.get(input.role)?.requirement.required !== false}
                  disabled={formLocked || waivedSet.has(input.role)}
                  value={values[input.role] ?? ''}
                  onChange={(event) => setValues((previous) => ({ ...previous, [input.role]: event.target.value }))}
                  placeholder="请输入"
                  style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)', padding: '7px 9px', fontSize: 13 }}
                />
              )}
              {optionalWaiver(input.role)}
            </label>
          ))}
        </div>
      )}

      {visiblePending.some((input) => input.kind === 'document') && !locked && (
        <div style={{ marginTop: 16 }}>
          <div style={{ fontSize: 12, color: 'var(--text-faint)', marginBottom: 6 }}>
            待上传业务材料（支持 Markdown 和 TXT）
          </div>
          {visiblePending.filter((input) => input.kind === 'document').map((documentInput) => (
            <div key={documentInput.role} style={{ display: 'grid', gap: 7, marginBottom: 14, padding: 12, border: '1px solid var(--border)', borderRadius: 8 }}>
              <span style={{ fontSize: 13 }}>
                {pendingInputQuestion(documentInput, pendingRequirementByKey.get(documentInput.role)?.requirement.question)}
                {' '}· {pendingRequirementByKey.get(documentInput.role)?.requirement.required === false ? '可选' : '必需'}
              </span>
              <input
                type="file"
                accept=".md,.txt,text/markdown,text/plain"
                multiple={documentInput.multiple}
                disabled={formLocked || waivedSet.has(documentInput.role)}
                onChange={(event) => pickDocuments(
                  documentInput,
                  Array.from(event.currentTarget.files ?? []),
                )}
              />
              {(documents[documentInput.role] ?? []).length > 0 && (
                <span style={{ color: 'var(--text-dim)', fontSize: 12 }}>
                  已选择：{documents[documentInput.role]!.map(({ name }) => name).join('、')}
                </span>
              )}
              {optionalWaiver(documentInput.role)}
            </div>
          ))}
        </div>
      )}

      {visiblePending.some((input) => input.kind === 'dataset') && !locked && (
        <div style={{ marginTop: 16 }}>
          <div style={{ fontSize: 12, color: 'var(--text-faint)', marginBottom: 6 }}>待上传 CSV 数据</div>
          {visiblePending.filter((input) => input.kind === 'dataset').map((datasetInput) => {
            const selected = datasets[datasetInput.role];
            return (
              <div key={datasetInput.role} style={{ display: 'grid', gap: 7, marginBottom: 14, padding: 12, border: '1px solid var(--border)', borderRadius: 8 }}>
                <span style={{ fontSize: 13 }}>
                  {pendingInputQuestion(datasetInput, pendingRequirementByKey.get(datasetInput.role)?.requirement.question)}
                  {' '}· {pendingRequirementByKey.get(datasetInput.role)?.requirement.required === false ? '可选' : '必需'}
                </span>
                <input
                  type="file"
                  accept=".csv,text/csv"
                  disabled={formLocked || waivedSet.has(datasetInput.role)}
                  onChange={(event) => {
                    void pickDataset(datasetInput.role, event.currentTarget.files?.[0]);
                  }}
                />
                <input
                  value={selected?.metadata.rowMeaning ?? ''}
                  disabled={!selected || formLocked}
                  onChange={(event) => editDatasetMetadata(datasetInput.role, 'rowMeaning', event.target.value)}
                  placeholder="一行代表什么，例如：一条用户研究记录"
                />
                <input
                  value={selected?.metadata.timeRange ?? ''}
                  disabled={!selected || formLocked}
                  onChange={(event) => editDatasetMetadata(datasetInput.role, 'timeRange', event.target.value)}
                  placeholder="数据时间范围，例如：2026-Q3"
                />
                <input
                  value={selected?.metadata.sampling ?? ''}
                  disabled={!selected || formLocked}
                  onChange={(event) => editDatasetMetadata(datasetInput.role, 'sampling', event.target.value)}
                  placeholder="样本或采集方式"
                />
                {datasetHeaderErrors[datasetInput.role] ? (
                  <span role="alert" style={{ color: 'var(--danger)', fontSize: 12 }}>
                    {datasetHeaderErrors[datasetInput.role]}
                  </span>
                ) : null}
                {selected && (datasetColumns[datasetInput.role]?.length ?? 0) > 0 ? (
                  <fieldset
                    disabled={formLocked}
                    style={{ display: 'grid', gap: 8, margin: '3px 0', padding: 10, border: '1px solid var(--border-soft)', borderRadius: 7 }}
                  >
                    <legend style={{ padding: '0 5px', color: 'var(--text-faint)', fontSize: 12 }}>
                      字段说明与单位（选填）
                    </legend>
                    {datasetColumns[datasetInput.role]!.map((column) => (
                      <div
                        key={column}
                        className="dataset-field-row"
                        style={{ gap: 7, alignItems: 'center' }}
                      >
                        <code style={{ minWidth: 0, overflowWrap: 'anywhere', color: 'var(--text-dim)', fontSize: 11 }}>{column}</code>
                        <input
                          value={selected.metadata.fieldNotes[column] ?? ''}
                          onChange={(event) => editDatasetColumnMetadata(datasetInput.role, 'fieldNotes', column, event.target.value)}
                          placeholder="字段含义"
                          aria-label={`${column} 字段含义`}
                        />
                        <input
                          value={selected.metadata.units[column] ?? ''}
                          onChange={(event) => editDatasetColumnMetadata(datasetInput.role, 'units', column, event.target.value)}
                          placeholder="单位"
                          aria-label={`${column} 单位`}
                        />
                      </div>
                    ))}
                  </fieldset>
                ) : null}
                {optionalWaiver(datasetInput.role)}
              </div>
            );
          })}
        </div>
      )}

      {visiblePending.some((input) => input.kind === 'visual') && !locked && (
        <div style={{ marginTop: 16 }}>
          <div style={{ fontSize: 12, color: 'var(--text-faint)', marginBottom: 6 }}>待上传图片</div>
          <p id="visual-upload-guidance" style={{ margin: '0 0 10px', color: 'var(--text-dim)', fontSize: 12 }}>
            请从本机选择 JPG、PNG 或 WebP 图片；不支持用图片 URL 或本机文件路径代替上传。单张最大 10 MiB。
          </p>
          {visiblePending.filter((input) => input.kind === 'visual').map((pu) => (
            <div key={pu.role} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6, fontSize: 13 }}>
              <span style={{ color: 'var(--text-dim)', flex: 1 }}>
                {pendingInputQuestion(pu, pendingRequirementByKey.get(pu.role)?.requirement.question)}
                <span style={{ color: 'var(--text-faint)', fontSize: 11 }}>
                  {' '}· {pendingRequirementByKey.get(pu.role)?.requirement.required === false ? '可选' : '必需'}
                  {' '}· {pu.multiple ? '可选择多张，最多 12 张' : '请选择 1 张'}
                  {' '}· 同一图片会自动用于所有需要它的分析能力
                </span>
              </span>
              {(images[pu.role] ?? []).length > 0 && (
                <span style={{ color: 'var(--text-dim)', fontSize: 12 }}>
                  已选择 {images[pu.role]!.length} 张：{images[pu.role]!.map(({ name }) => name).join('、')}
                </span>
              )}
              <input
                type="file"
                accept={IMAGE_FILE_ACCEPT}
                multiple={pu.multiple}
                aria-describedby="visual-upload-guidance"
                disabled={formLocked || waivedSet.has(pu.role)}
                onChange={(event) => {
                  pickImages(pu, Array.from(event.currentTarget.files ?? []));
                }}
                style={{ fontSize: 12, color: 'var(--text-dim)' }}
              />
              {optionalWaiver(pu.role)}
            </div>
          ))}
        </div>
      )}

      {!locked && !confirmed && (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 8, marginTop: 18 }}>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              className="btn-primary"
              onClick={() => { void confirm(); }}
              disabled={submitting || revising || missingAnswers.length > 0 || missingInputs.length > 0 || (portfolio?.uncoveredRequiredDemandIds.length ?? 0) > 0}
            >
              {submitting ? '正在上传并确认…' : '✓ 确认并继续'}
            </button>
            <button
              className="btn-ghost"
              onClick={() => onRevise(revisionInstruction.trim())}
              disabled={submitting || revising || revisionInstruction.trim() === ''}
            >
              {revising ? '正在重新生成…' : '重新生成计划'}
            </button>
          </div>
          <textarea
            value={revisionInstruction}
            onChange={(event) => setRevisionInstruction(event.target.value)}
            disabled={submitting || revising}
            placeholder="填写调整要求；可用 $skill-name 指定技能"
            rows={2}
            aria-label="计划调整要求"
            style={{ width: '100%', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)', padding: '7px 9px', fontSize: 13, resize: 'vertical' }}
          />
          {submitError && (
            <span role="alert" style={{ color: 'var(--danger)', fontSize: 12 }}>
              {submitError}
            </span>
          )}
          {(missingAnswers.length > 0 || missingInputs.length > 0 || (portfolio?.uncoveredRequiredDemandIds.length ?? 0) > 0) && (
            <span role="alert" style={{ color: 'var(--warn)', fontSize: 12 }}>
              {missingAnswers.length > 0 && `请先回答全部确认项：${missingAnswers.map(({ question, key }) => question ?? key).join('、')}`}
              {missingAnswers.length > 0 && (missingInputs.length > 0 || (portfolio?.uncoveredRequiredDemandIds.length ?? 0) > 0) ? '；' : ''}
              {missingInputs.length > 0 && `请先补充全部输入：${missingInputs.map(pendingInputLabel).join('、')}`}
              {missingInputs.length > 0 && (portfolio?.uncoveredRequiredDemandIds.length ?? 0) > 0 ? '；' : ''}
              {(portfolio?.uncoveredRequiredDemandIds.length ?? 0) > 0 && `计划仍有未覆盖需求：${portfolio!.uncoveredRequiredDemandIds.join('、')}`}
            </span>
          )}
        </div>
      )}
      {(locked || confirmed) && (
        <div style={{ marginTop: 14, fontSize: 13, color: 'var(--ok)' }}>✓ 信息已确认，正在按计划处理</div>
      )}
    </section>
  );
}

interface ConfirmationRequirement {
  key: string;
  question?: string;
  suggestion?: unknown;
}

function confirmationRequirements(values: unknown[]): ConfirmationRequirement[] {
  return values.flatMap((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    const candidate = value as { key?: unknown; question?: unknown; suggestion?: unknown };
    if (typeof candidate.key !== 'string' || candidate.key.trim() === '') return [];
    return [{
      key: candidate.key,
      question: typeof candidate.question === 'string' ? candidate.question : undefined,
      suggestion: candidate.suggestion,
    }];
  });
}

function formatSuggestion(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value) ?? String(value);
}

function StepRow({ step }: { step: PlanStep | CurrentPlanStep }) {
  const purpose = 'purpose' in step ? step.purpose : undefined;
  const label = step.actor_type === 'skill'
    ? '专业分析'
    : step.actor_type === 'tool'
      ? '资料处理'
      : step.actor_type === 'reviewer'
        ? '质量检查'
        : step.actor_type === 'knowledge' ? '知识读取' : '内容生成';
  const cls =
    step.actor_type === 'skill' ? 'badge-skill'
    : step.actor_type === 'tool' ? 'badge-tool'
    : step.actor_type === 'reviewer' ? 'badge-reviewer'
    : step.actor_type === 'knowledge' ? 'badge-knowledge'
    : 'badge-llm';
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', padding: '8px 12px', background: 'var(--bg)', borderRadius: 8 }}>
      <span style={{ color: 'var(--text-faint)', fontFamily: 'var(--mono)', fontSize: 12 }}>{step.step_no}</span>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 13 }}>{step.step_name}</div>
        {purpose && <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>{purpose}</div>}
      </div>
      <span className={`badge ${cls}`}>{label}</span>
      {step.requires_approval && <span className="badge" style={{ background: 'rgba(251,191,36,.15)', color: 'var(--warn)' }}>需审批</span>}
    </div>
  );
}
