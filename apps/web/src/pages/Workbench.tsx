import { useCallback, useEffect, useState } from 'react';
import {
  api,
  type User,
  type TaskDetail,
  type ExecLogRow,
  type ControlApprovalRequirement,
  type SystemCapabilitiesResponse,
  type TaskHistoryPreferencePatch,
  ApiError,
} from '../api/client.ts';
import {
  approvalSubmissionAllowed,
  applyTaskHistoryPreferences,
  executionFailureAllowsAction,
  formatElapsedTime,
  formatLocalDateTime,
  historyTaskPresentation,
  mergeTaskHistory,
  type HistoryTaskSummary,
} from '../current-flow-state.ts';
import { useTaskFlow } from '../hooks/useTaskFlow.ts';
import { Sidebar } from '../components/Sidebar.tsx';
import { Composer } from '../components/Composer.tsx';
import { Stage1Understand } from '../components/stages/Stage1Understand.tsx';
import { CurrentStage1Clarify } from '../components/stages/CurrentStage1Clarify.tsx';
import { Stage2Candidates } from '../components/stages/Stage2Candidates.tsx';
import { Stage2Plan } from '../components/stages/Stage2Plan.tsx';
import { Stage3Execute } from '../components/stages/Stage3Execute.tsx';
import { Stage4Report } from '../components/stages/Stage4Report.tsx';
import { NativeStage4Report } from '../components/stages/NativeStage4Report.tsx';
import { TaskFollowUpPanel } from '../components/TaskFollowUpPanel.tsx';
import { PlanProgressCard } from '../components/PlanningProgressCard.tsx';
import { reviewedDraftPreviewFromFailure } from '../reviewed-draft-preview.ts';
import { Labs } from './Labs.tsx';

type View = 'task' | 'labs' | 'history';

export function Workbench({ user, capabilities, onLogout }: { user: User; capabilities: SystemCapabilitiesResponse | null; onLogout: () => void }) {
  const [view, setView] = useState<View>('task');
  const [history, setHistory] = useState<HistoryTaskSummary[]>([]);
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState(''); // 历史打开失败(与任务流 error 分离)

  const refreshHistory = useCallback(() => {
    void Promise.all([
      api.listTaskHistoryPreferences(),
      Promise.allSettled([
        api.listTasks(),
        api.listControlTasks(),
        api.listApprovalTasks(),
      ]),
    ]).then(([preferences, [legacy, current, approvals]]) => {
      const currentTasks = current.status === 'fulfilled' ? current.value.tasks : [];
      const currentIds = new Set(currentTasks.map((task) => task.id));
      const approvalTasks = approvals.status === 'fulfilled'
        ? approvals.value.tasks
          .filter((task) => !currentIds.has(task.id))
          .map((task) => ({
            id: task.id,
            originalInput: task.originalInput,
            taskType: task.taskType,
            state: task.state,
            // 审批列表只返回待处理项;没有创建时间时以更新时间排序即可。
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            requiresAction: true,
          }))
        : [];
      setHistory(mergeTaskHistory(
        legacy.status === 'fulfilled' ? legacy.value.tasks : [],
        [...currentTasks, ...approvalTasks],
        preferences.preferences,
      ));
    }).catch(() => {});
  }, []);
  useEffect(refreshHistory, [refreshHistory]);

  // 新任务和 Current 历史走同一恢复主链；Legacy 历史保持只读。
  const flow = useTaskFlow();
  const {
    phase,
    clarification,
    submitClarification,
    clarificationSubmitting,
    candidatesResp,
    selectedCandidateId,
    plan,
    originalInput,
    exec,
    executionSteps,
    executionPlanSteps,
    finalReport,
    skillResults,
    reportState,
    deliverableError,
    followUpMessages,
    followUpLoading,
    followUpSubmitting,
    followUpError,
    error,
    progress,
    currentTaskId,
    stateVersion,
    approvalRequirements,
    approvalSubmitting,
    planRecovery,
    revisionSubmitting,
    cancelSubmitting,
  } = flow;
  useEffect(() => {
    if (stateVersion != null) refreshHistory();
  }, [refreshHistory, stateVersion]);
  const currentHistoryTask = currentTaskId
    ? history.find((task) => task.kind === 'current' && task.id === currentTaskId)
    : undefined;

  function newTask() {
    setView('task'); setDetail(null); setDetailError('');
    flow.reset();
  }

  async function openTask(task: HistoryTaskSummary) {
    if (task.kind === 'current') {
      setView('task'); setDetail(null); setDetailError('');
      await flow.openTask(task.id);
      return;
    }
    setView('history'); setDetail(null); setDetailLoading(true); setDetailError('');
    try {
      setDetail(await api.taskDetail(task.id));
    } catch (e) {
      setDetailError(e instanceof ApiError ? e.message : '打开历史任务失败');
    } finally {
      setDetailLoading(false);
    }
  }

  async function updateHistoryTask(
    task: HistoryTaskSummary,
    patch: TaskHistoryPreferencePatch,
  ): Promise<void> {
    const { preference } = await api.updateTaskHistoryPreference(task.kind, task.id, patch);
    setHistory((current) => applyTaskHistoryPreferences(current, [preference]));
    if (patch.hidden && (
      (task.kind === 'current' && task.id === currentTaskId)
      || (task.kind === 'legacy' && task.id === detail?.task.id)
    )) {
      newTask();
    }
  }

  return (
    <div className="workbench">
      <Sidebar
        user={user}
        capabilities={capabilities}
        history={history}
        activeTaskId={currentTaskId}
        onNewTask={newTask}
        onOpenLabs={() => setView('labs')}
        onOpenTask={(task) => { void openTask(task); }}
        onUpdateTask={updateHistoryTask}
        onLogout={onLogout}
      />
      {view === 'labs' ? (
        <main className="workbench-main">
          <Labs />
        </main>
      ) : view === 'history' ? (
        <main className="workbench-main">
          <div className="workbench-scroll">
            <div className="chat-column">
              {detailLoading && <Loading text="加载历史任务…" />}
              {detailError && <ErrorCard msg={detailError} />}
              {detail && <HistoryDetail detail={detail} />}
            </div>
          </div>
        </main>
      ) : (
      <main className="workbench-main">
        <div className="workbench-scroll">
          <div className={`chat-column${finalReport ? ' chat-column-report' : ''}`} aria-live="polite">
            {phase === 'idle' ? (
              <Welcome onPick={flow.submitInput} />
            ) : phase === 'loading-task' ? (
              <Loading text="正在读取任务状态…" />
            ) : (
              <>
                {originalInput ? (
                  <UserBubble text={originalInput} createdAt={currentHistoryTask?.created_at} />
                ) : null}
                {currentHistoryTask ? <TaskTimeSummary task={currentHistoryTask} /> : null}

                {clarification && phase === 'clarifying' && (
                  <>
                    {error && <ErrorCard msg={error} />}
                    <CurrentStage1Clarify
                      key={`${clarification.task.id}:${clarification.task.stateVersion}`}
                      response={clarification}
                      onSubmit={submitClarification}
                      disabled={clarificationSubmitting}
                    />
                    {clarificationSubmitting ? (
                      <PlanProgressCard steps={progress} variant="clarification" />
                    ) : null}
                  </>
                )}

                {candidatesResp && (
                  <>
                    <Stage1Understand task={candidatesResp.structuredTask} activatedNodes={candidatesResp.activatedNodes} />
                    {(phase === 'picking' || phase === 'selecting') && (
                      <>
                        {error && phase === 'picking' && <InlineError msg={error} />}
                        <Stage2Candidates
                          candidates={candidatesResp.candidates}
                          onSelect={flow.pickCandidate}
                          selectedId={selectedCandidateId ?? undefined}
                          loading={phase === 'selecting'}
                          readOnly={false}
                        />
                      </>
                    )}
                  </>
                )}

                {planRecovery && (phase === 'planned' || phase === 'error') && (
                  <PlanRecoveryNotice submitting={revisionSubmitting} onRevise={flow.revisePlan} />
                )}
                {plan && !planRecovery && phase !== 'picking' && phase !== 'selecting' && phase !== 'error' && (
                  <Stage2Plan
                    plan={plan}
                    locked={phase !== 'planned'}
                    revising={revisionSubmitting}
                    onConfirm={flow.confirmPlan}
                    onRevise={flow.revisePlan}
                  />
                )}

                {phase === 'planning' && <PlanProgressCard steps={progress} />}
                {phase === 'awaiting-approval' && (
                  <AwaitingApprovalNotice
                    requirements={approvalRequirements}
                    submitting={approvalSubmitting}
                    onApprove={flow.approveTask}
                  />
                )}
                {phase === 'ready' && <ReadyExecutionNotice onStart={flow.startExecution} />}
                {(phase === 'executing' || phase === 'reviewing' || phase === 'composing-report') && (
                  <>
                    {executionPlanSteps.length > 0 && (
                      <Stage3Execute
                        steps={executionPlanSteps}
                        log={executionSteps}
                        phase={phase}
                        native={plan?.plan.execution_contract_version === 'native-skill-execution-plan-v1'}
                      />
                    )}
                    <RunningTaskNotice
                      phase={phase}
                      cancelling={cancelSubmitting}
                      onCancel={() => void flow.cancelExecution()}
                    />
                    {error && <ErrorCard msg={error} />}
                  </>
                )}
                {phase === 'paused' && exec && (
                  <>
                    {executionPlanSteps.length > 0 && (
                      <Stage3Execute
                        steps={executionPlanSteps}
                        log={executionSteps}
                        phase="paused"
                        native={plan?.plan.execution_contract_version === 'native-skill-execution-plan-v1'}
                      />
                    )}
                    <FailureActionCard
                      stepNo={exec.failedStepNo}
                      stepName={executionPlanSteps.find((step) => step.step_no === exec.failedStepNo)?.step_name}
                      failure={exec.failure}
                      onRetry={() => flow.resumeStep('retry')}
                      onReplan={() => flow.revisePlan('知识或分析能力已更新，请基于当前需求重新生成计划。')}
                      onAbort={() => flow.resumeStep('abort')}
                    />
                  </>
                )}
                {phase === 'done' && exec && (
                  <>
                    {executionPlanSteps.length > 0 && (
                      <Stage3Execute
                        steps={executionPlanSteps}
                        log={executionSteps}
                        phase="done"
                        native={plan?.plan.execution_contract_version === 'native-skill-execution-plan-v1'}
                      />
                    )}
                    {error && <ErrorCard msg={error} />}
                    {exec.status === 'completed_with_gaps' && (
                      <GapNotice count={exec.gapCount ?? executionSteps.filter((step) => step.status === 'skipped').length} />
                    )}
                    {reportState === 'loading' && <Loading text="正在读取研究报告…" />}
                    {reportState === 'report-loading-error' && (
                      <ErrorCard msg={deliverableError} onRetry={flow.retryDeliverable} retryLabel="重取报告" />
                    )}
                    {finalReport && currentTaskId && (
                      <>
                        <NativeStage4Report
                          taskId={currentTaskId}
                          finalReport={finalReport}
                          skillResults={skillResults}
                        />
                        <TaskFollowUpPanel
                          messages={followUpMessages}
                          loading={followUpLoading}
                          submitting={followUpSubmitting}
                          error={followUpError}
                          onSubmit={flow.submitFollowUp}
                        />
                      </>
                    )}
                  </>
                )}
                {phase === 'failed' && (
                  <>
                    {executionPlanSteps.length > 0 && (
                      <Stage3Execute
                        steps={executionPlanSteps}
                        log={executionSteps}
                        phase="failed"
                        native={plan?.plan.execution_contract_version === 'native-skill-execution-plan-v1'}
                      />
                    )}
                    <TerminalTaskNotice
                      state="failed"
                      failure={[...executionSteps].reverse().find((step) => step.status === 'failed')}
                    />
                  </>
                )}
                {phase === 'cancelled' && (
                  <>
                    {executionPlanSteps.length > 0 && (
                      <Stage3Execute
                        steps={executionPlanSteps}
                        log={executionSteps}
                        phase="cancelled"
                        native={plan?.plan.execution_contract_version === 'native-skill-execution-plan-v1'}
                      />
                    )}
                    <AbortedNotice />
                  </>
                )}
                {phase === 'rejected' && <TerminalTaskNotice state="rejected" />}
                {phase === 'error' && <ErrorCard msg={error} />}
                {currentTaskId && <CurrentHistoryNotice />}
              </>
            )}
          </div>
        </div>
        {phase !== 'done' ? (
          <Composer
            disabled={phase === 'loading-task' || phase === 'planning' || phase === 'clarifying' || phase === 'selecting' || phase === 'executing' || phase === 'reviewing' || phase === 'composing-report' || phase === 'awaiting-approval'}
            multiSkillEnabled={capabilities?.multiSkillPlanWriterEnabled === true}
            onSubmit={flow.submitInput}
          />
        ) : null}
      </main>
      )}
    </div>
  );
}

// 历史任务只读详情:复用 Stage1(理解) + Stage3(执行日志重建步骤) + Stage4(报告)。
// 计划步骤未单独持久化,用 executionLog 重建(含 step_no/name/actor/status)。
function HistoryDetail({ detail }: { detail: TaskDetail }) {
  const steps = detail.executionLog.map((l) => ({
    step_no: l.step_no, step_name: l.step_name,
    actor_type: l.actor_type, actor_id: l.actor_id,
  }));
  const activatedNodes = detail.decisionStates.map((d) => d.node_key);
  return (
    <>
      <div style={{ fontSize: 12, color: 'var(--text-faint)', marginBottom: 12 }}>
        历史任务 · {detail.task.status} · <span className="mono">{detail.task.id}</span>
      </div>
      <Stage1Understand task={detail.task.structured_task} activatedNodes={activatedNodes} />
      {steps.length > 0 && <Stage3Execute steps={steps} log={detail.executionLog} />}
      <Stage4Report report={detail.report} taskId={detail.task.id} />
    </>
  );
}

function Welcome({ onPick }: { onPick: (t: string) => void }) {
  const suggestions = [
    '我要为直播场域做一次数字人竞品研究',
    '帮我规划一次直播带货的用户体验研究',
    '分析虚拟主播赛道的主要竞品差异',
  ];
  return (
    <div className="welcome">
      <h1>你想研究什么?</h1>
      <p>输入一句话,我会给出两份可比较的方案 · 「深度优先 / 速度优先」由你挑一份。</p>
      <div className="welcome-suggests">
        {suggestions.map((s) => (
          <button key={s} className="welcome-chip" onClick={() => onPick(s)}>{s}</button>
        ))}
      </div>
    </div>
  );
}

function TaskTimeSummary({ task }: { task: HistoryTaskSummary }) {
  const presentation = historyTaskPresentation(task);
  const terminal = presentation.group === 'completed' || presentation.group === 'failed';
  const endedAt = task.updated_at ?? task.created_at;
  return (
    <div className="task-time-summary" aria-label="任务时间">
      <span>开始于 {formatLocalDateTime(task.created_at)}</span>
      <span>{terminal ? '完成于' : '最近更新于'} {formatLocalDateTime(endedAt)}</span>
      {terminal ? <span>总用时 {formatElapsedTime(task.created_at, endedAt)}</span> : null}
    </div>
  );
}

function UserBubble({ text, createdAt }: { text: string; createdAt?: string }) {
  if (!text) return null;
  return (
    <div className="user-row">
      <div className="user-bubble">
        <div>{text}</div>
        {createdAt ? <time dateTime={createdAt}>{formatLocalDateTime(createdAt)}</time> : null}
      </div>
    </div>
  );
}

function Loading({ text }: { text: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--text-dim)', padding: '16px 4px' }}>
      <span className="spinner" /> {text}
    </div>
  );
}

function ErrorCard({
  msg,
  onRetry,
  retryLabel = '重试执行',
}: {
  msg: string;
  onRetry?: () => void;
  retryLabel?: string;
}) {
  return (
    <div style={{ background: 'rgba(248,113,113,.08)', border: '1px solid rgba(248,113,113,.3)', borderRadius: 16, padding: 18, marginTop: 16 }}>
      <div style={{ color: 'var(--danger)', fontWeight: 600 }}>出错了</div>
      <div style={{ color: 'var(--text-dim)', fontSize: 13, margin: '6px 0' }}>{msg}</div>
      {onRetry && <button className="btn-ghost" onClick={onRetry}>{retryLabel}</button>}
    </div>
  );
}

// 候选选择失败的内联错误条(保留候选卡,让用户看到原因并重选,不静默吞错)。
function InlineError({ msg }: { msg: string }) {
  return (
    <div style={{ background: 'rgba(248,113,113,.08)', border: '1px solid rgba(248,113,113,.3)', borderRadius: 12, padding: '10px 14px', marginBottom: 12, fontSize: 13, color: 'var(--danger)' }}>
      {msg} · 请重新选择一份方案
    </div>
  );
}


function FailureActionCard({
  stepNo,
  stepName,
  failure,
  onRetry,
  onReplan,
  onAbort,
}: {
  stepNo?: number;
  stepName?: string;
  failure?: Record<string, unknown>;
  onRetry: () => void;
  onReplan: () => void;
  onAbort: () => void;
}) {
  const canRetry = failure == null || executionFailureAllowsAction(failure, 'retry');
  const canReplan = failure != null && executionFailureAllowsAction(failure, 'replan');
  const canAbort = failure == null || executionFailureAllowsAction(failure, 'abort');
  const draftPreview = reviewedDraftPreviewFromFailure(failure);
  const visibleFailure = failure ? { ...failure } : undefined;
  if (visibleFailure) delete visibleFailure.draftPreview;
  return (
    <section style={{ background: 'rgba(251,191,36,.08)', border: '1px solid rgba(251,191,36,.3)', borderRadius: 16, padding: 18, marginTop: 16 }}>
      <div style={{ color: 'var(--warn)', fontWeight: 600 }}>
        第 {stepNo ?? '?'} 步失败{stepName ? `：${stepName}` : ''}
      </div>
      {draftPreview && (
        <div style={{ margin: '12px 0', padding: 14, borderRadius: 12, border: '1px solid var(--border-soft)', background: 'var(--bg-card-hi)', color: 'var(--text)' }}>
          <div style={{ fontWeight: 600 }}>已保留审校草稿 · 非正式报告</div>
          <div style={{ marginTop: 4, color: 'var(--text-dim)', fontSize: 12 }}>
            未通过 Canonical 交付门禁，当前内容不可导出或发布。
          </div>
          <div style={{ marginTop: 10, fontSize: 14 }}>{draftPreview.title}</div>
          <p style={{ margin: '6px 0', color: 'var(--text-dim)', lineHeight: 1.6 }}>{draftPreview.executiveAnswer}</p>
          <div style={{ color: 'var(--text-faint)', fontSize: 12 }}>
            {draftPreview.directAnswerCount} 个直接答案 · {draftPreview.evidenceFindingCount} 个发现 · {draftPreview.contentBlocks.length} 个内容块 · {draftPreview.limitationCount} 个局限 · {draftPreview.openQuestionCount} 个待解决问题
          </div>
          {draftPreview.contentBlocks.length > 0 && (
            <ul style={{ margin: '8px 0 0', paddingLeft: 20, color: 'var(--text-dim)', fontSize: 12 }}>
              {draftPreview.contentBlocks.map((block) => (
                <li key={block.key}>{block.title} · {block.kind} · {block.itemCount} 项</li>
              ))}
            </ul>
          )}
        </div>
      )}
      {visibleFailure && (
        <pre style={{ whiteSpace: 'pre-wrap', color: 'var(--text-dim)', fontSize: 12, margin: '8px 0' }}>
          {JSON.stringify(visibleFailure, null, 2)}
        </pre>
      )}
      <p style={{ color: 'var(--text-dim)', fontSize: 13, margin: '6px 0 12px' }}>
        {canReplan
          ? '当前计划使用的知识或分析能力已更新，请重新生成并确认计划；终止后不会生成报告。'
          : failure?.kind === 'deliverable_validation'
            ? '重试会优先复用已验证的计划步骤，只重新构建 Canonical Deliverable 及后续报告；复用校验失败时才回退为完整重试。'
            : canRetry
              ? '重试会继续使用当前已确认的计划，从失败步骤重新执行；终止后不会生成报告。'
              : '该失败不可重试；终止任务后不会生成交付物。'}
      </p>
      <div style={{ display: 'flex', gap: 10 }}>
        {canRetry && <button type="button" className="btn-primary" onClick={onRetry}>重试失败执行</button>}
        {canReplan && <button type="button" className="btn-primary" onClick={onReplan}>重新生成计划</button>}
        {canAbort && <button type="button" className="btn-ghost" onClick={onAbort}>终止任务</button>}
      </div>
    </section>
  );
}

function GapNotice({ count }: { count: number }) {
  return (
    <div style={{ background: 'rgba(251,191,36,.08)', border: '1px solid rgba(251,191,36,.3)', borderRadius: 16, padding: '12px 16px', marginBottom: 16, fontSize: 13, color: 'var(--warn)' }}>
      部分完成 · {count} 个数据缺口已在下方风险与待解决问题中标注。
    </div>
  );
}

const APPROVAL_AUTHORITY_LABELS: Record<ControlApprovalRequirement['requiredAuthority'], string> = {
  owner: '任务负责人',
  legal: '法务',
  security: '安全',
  gold: '黄金账号',
};

const APPROVAL_GATE_LABELS: Record<string, string> = {
  public_sources_only: '仅使用公开来源',
  access_restrictions: '访问限制',
  pii_and_account_data: '个人信息与账号数据',
};

function AwaitingApprovalNotice({
  requirements,
  submitting,
  onApprove,
}: {
  requirements: ControlApprovalRequirement[];
  submitting: boolean;
  onApprove: (gateKey: string) => void;
}) {
  return (
    <section className="stage-card">
      <h3 style={{ margin: '0 0 8px', fontSize: 15 }}>计划等待授权审批</h3>
      <p style={{ margin: 0, color: 'var(--text-dim)', fontSize: 13 }}>
        确认已记录，但计划包含需要对应角色处理的阻断项；状态达到 ready 前不会执行。
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 16 }}>
        {requirements.length === 0 && (
          <div style={{ color: 'var(--text-faint)', fontSize: 12 }}>正在读取审批门禁…</div>
        )}
        {requirements.map((requirement) => {
          const decisionLabel = requirement.decision === 'approved'
            ? '已批准'
            : requirement.decision === 'rejected' ? '已拒绝' : '待审批';
          return (
            <div
              key={requirement.gateKey}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '10px 12px',
                borderRadius: 10,
                background: 'var(--bg-card-hi)',
                border: '1px solid var(--border-soft)',
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13 }}>{APPROVAL_GATE_LABELS[requirement.gateKey] ?? requirement.gateKey}</div>
                <div style={{ color: 'var(--text-faint)', fontSize: 12, marginTop: 3 }}>
                  {APPROVAL_AUTHORITY_LABELS[requirement.requiredAuthority]} · {decisionLabel}
                </div>
              </div>
              {approvalSubmissionAllowed(requirement) && (
                <button
                  type="button"
                  className="btn-primary"
                  disabled={submitting}
                  onClick={() => onApprove(requirement.gateKey)}
                >
                  {submitting ? '提交中…' : '批准'}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function ReadyExecutionNotice({ onStart }: { onStart: () => void }) {
  return (
    <section className="stage-card">
      <h3 style={{ margin: '0 0 8px', fontSize: 15 }}>计划已确认，等待执行</h3>
      <p style={{ margin: '0 0 14px', color: 'var(--text-dim)', fontSize: 13 }}>
        打开任务不会自动启动执行。确认当前计划后，再由你明确开始。
      </p>
      <button type="button" className="btn-primary" onClick={onStart}>开始执行</button>
    </section>
  );
}

function PlanRecoveryNotice({
  submitting,
  onRevise,
}: {
  submitting: boolean;
  onRevise: () => void;
}) {
  return (
    <section className="stage-card" role="status">
      <h3 style={{ margin: '0 0 8px', fontSize: 15 }}>当前计划需要重新生成</h3>
      <p style={{ margin: '0 0 14px', color: 'var(--text-dim)', fontSize: 13 }}>
        这是旧版待输入计划，字段契约已经过期，不能直接确认。重新生成只会更新计划，不会开始执行任务。
      </p>
      <button type="button" className="btn-primary" onClick={onRevise} disabled={submitting}>
        {submitting ? '正在重新生成…' : '重新生成计划'}
      </button>
    </section>
  );
}

function RunningTaskNotice({
  phase,
  cancelling,
  onCancel,
}: {
  phase: 'executing' | 'reviewing' | 'composing-report';
  cancelling: boolean;
  onCancel: () => void;
}) {
  const content = {
    executing: ['任务执行中', '正在按计划调用能力并记录执行结果。'],
    reviewing: ['质量复核中', '执行已完成，正在检查证据覆盖与报告质量。'],
    'composing-report': ['报告生成中', '正在整理已验证的结果并生成最终报告。'],
  }[phase];
  return (
    <section className="stage-card" aria-live="polite">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span className="spinner" />
        <div style={{ flex: 1 }}>
          <h3 style={{ margin: 0, fontSize: 15 }}>{content[0]}</h3>
          <p style={{ margin: '3px 0 0', color: 'var(--text-dim)', fontSize: 13 }}>{content[1]}</p>
        </div>
        <button type="button" className="btn-ghost" onClick={onCancel} disabled={cancelling}>
          {cancelling ? '正在取消…' : '取消任务'}
        </button>
      </div>
    </section>
  );
}

function TerminalTaskNotice({
  state,
  failure,
}: {
  state: 'failed' | 'rejected';
  failure?: ExecLogRow;
}) {
  const failed = state === 'failed';
  return (
    <section className="stage-card" role="status">
      <h3 style={{ margin: '0 0 8px', color: 'var(--danger)', fontSize: 15 }}>
        {failed ? '任务失败' : '任务已驳回'}
      </h3>
      <p style={{ margin: 0, color: 'var(--text-dim)', fontSize: 13 }}>
        {failed
          ? failure
            ? `执行在第 ${failure.step_no} 步“${failure.step_name}”失败，当前任务不可直接恢复。`
            : '任务在规划阶段失败，未生成可恢复计划。'
          : '审批未通过，任务不会继续执行。该记录保留为只读历史。'}
      </p>
      {failure?.failure && (
        <pre style={{ whiteSpace: 'pre-wrap', color: 'var(--text-faint)', fontSize: 12, margin: '10px 0 0' }}>
          {JSON.stringify(failure.failure, null, 2)}
        </pre>
      )}
    </section>
  );
}

function CurrentHistoryNotice() {
  return (
    <aside style={{ color: 'var(--text-faint)', fontSize: 12, padding: '4px 2px 18px' }}>
      当前任务会保留在侧栏历史中；点击即可恢复最近状态和报告。
    </aside>
  );
}

function AbortedNotice() {
  return (
    <div style={{ background: 'rgba(248,113,113,.08)', border: '1px solid rgba(248,113,113,.3)', borderRadius: 16, padding: 18, marginTop: 16 }}>
      <div style={{ color: 'var(--danger)', fontWeight: 600 }}>任务已终止</div>
      <div style={{ color: 'var(--text-dim)', fontSize: 13, marginTop: 6 }}>任务已取消，未生成报告。可新建任务重试。</div>
    </div>
  );
}
