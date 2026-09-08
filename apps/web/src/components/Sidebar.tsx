import { useEffect, useRef, useState, type FormEvent } from 'react';
import type {
  TaskHistoryPreferencePatch,
  SystemCapabilitiesResponse,
  User,
} from '../api/client.ts';
import {
  formatElapsedTime,
  formatLocalDateTime,
  historyTaskPresentation,
  type HistoryTaskSummary,
  type TaskHistoryGroup,
} from '../current-flow-state.ts';

const HISTORY_TABS: Array<{ id: TaskHistoryGroup; label: string }> = [
  { id: 'pending', label: '待处理' },
  { id: 'running', label: '进行中' },
  { id: 'completed', label: '已完成' },
  { id: 'failed', label: '失败' },
];

function taskKey(task: HistoryTaskSummary): string {
  return `${task.kind}:${task.id}`;
}

function taskTitle(task: HistoryTaskSummary): string {
  return task.displayName ?? task.original_input;
}

// 左侧栏:新建任务 + 状态化历史 + 资源库入口 + 用户/登出。
export function Sidebar({
  user,
  capabilities,
  history,
  activeTaskId,
  onNewTask,
  onOpenLabs,
  onOpenTask,
  onUpdateTask,
  onLogout,
}: {
  user: User;
  capabilities: SystemCapabilitiesResponse | null;
  history: HistoryTaskSummary[];
  activeTaskId: string | null;
  onNewTask: () => void;
  onOpenLabs: () => void;
  onOpenTask: (task: HistoryTaskSummary) => void;
  onUpdateTask: (task: HistoryTaskSummary, patch: TaskHistoryPreferencePatch) => Promise<void>;
  onLogout: () => void;
}) {
  const [activeTab, setActiveTab] = useState<TaskHistoryGroup>('pending');
  const counts = new Map<TaskHistoryGroup, number>(HISTORY_TABS.map(({ id }) => [id, 0]));
  for (const task of history) {
    const group = historyTaskPresentation(task).group;
    counts.set(group, (counts.get(group) ?? 0) + 1);
  }
  const visibleTasks = history.filter((task) => historyTaskPresentation(task).group === activeTab);

  return (
    <aside className="workbench-sidebar">
      <div className="sidebar-new-task">
        <button className="btn-primary" type="button" onClick={onNewTask}>+ 新建任务</button>
      </div>

      <div className="sidebar-scroll">
        <SectionLabel>任务记录</SectionLabel>
        <div className="history-tabs" role="tablist" aria-label="历史任务状态">
          {HISTORY_TABS.map((tab) => (
            <button
              key={tab.id}
              id={`history-tab-${tab.id}`}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.id}
              aria-controls="history-tab-panel"
              tabIndex={activeTab === tab.id ? 0 : -1}
              className={`history-tab${activeTab === tab.id ? ' is-active' : ''}`}
              onClick={() => setActiveTab(tab.id)}
              onKeyDown={(event) => {
                const currentIndex = HISTORY_TABS.findIndex(({ id }) => id === tab.id);
                let nextIndex = currentIndex;
                if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % HISTORY_TABS.length;
                else if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + HISTORY_TABS.length) % HISTORY_TABS.length;
                else if (event.key === 'Home') nextIndex = 0;
                else if (event.key === 'End') nextIndex = HISTORY_TABS.length - 1;
                else return;
                event.preventDefault();
                const next = HISTORY_TABS[nextIndex]!;
                setActiveTab(next.id);
                document.getElementById(`history-tab-${next.id}`)?.focus();
              }}
            >
              <span>{tab.label}</span>
              <span className="history-tab-count">{counts.get(tab.id) ?? 0}</span>
            </button>
          ))}
        </div>

        <div
          id="history-tab-panel"
          role="tabpanel"
          aria-labelledby={`history-tab-${activeTab}`}
          className="history-tab-panel"
        >
          {visibleTasks.length === 0 ? (
            <Empty>暂无{HISTORY_TABS.find((tab) => tab.id === activeTab)?.label}任务</Empty>
          ) : visibleTasks.map((task) => (
            <HistoryTaskRow
              key={taskKey(task)}
              task={task}
              active={task.kind === 'current' && task.id === activeTaskId}
              onOpen={() => onOpenTask(task)}
              onUpdate={(patch) => onUpdateTask(task, patch)}
            />
          ))}
        </div>

        <SectionLabel>资源库</SectionLabel>
        <button className="btn-ghost sidebar-resource-button" type="button" onClick={onOpenLabs}>
          🧰 工具箱 · Labs
        </button>
        <Entry>案例库</Entry>
      </div>

      <div className="sidebar-account">
        <div>{user.display_name}</div>
        {capabilities ? (
          <details className="sidebar-capabilities">
            <summary>运行能力</summary>
            <span>应用版本 {capabilities.applicationVersion} · 构建 {capabilities.build.id}</span>
            <span>代码版本 {capabilities.build.sourceRevision?.slice(0, 12) ?? '不可用'}</span>
            <span>计划协议 {capabilities.planContractVersions.join(', ')}</span>
            <span>报告协议 {capabilities.reportDocumentVersions.join(', ')}</span>
            <span>任务类型：{capabilities.activeTaskTypes.join(', ')}</span>
            <span>可交付报告：{capabilities.activeDeliverables.join(', ')}</span>
            <span>已安装能力：{capabilities.installedSkills.join(', ')}</span>
            <span>配置版本 {capabilities.build.configurationHash.slice(0, 19)}…</span>
            <span>知识库版本 {capabilities.knowledgeIndexHash?.slice(0, 19) ?? '不可用'}…</span>
            <span>工具配置版本 {capabilities.toolRegistryHash.slice(0, 19)}…</span>
          </details>
        ) : null}
        <button className="btn-ghost" type="button" onClick={onLogout}>登出</button>
      </div>
    </aside>
  );
}

type TaskRowMode = 'closed' | 'menu' | 'rename' | 'delete';

function HistoryTaskRow({
  task,
  active,
  onOpen,
  onUpdate,
}: {
  task: HistoryTaskSummary;
  active: boolean;
  onOpen: () => void;
  onUpdate: (patch: TaskHistoryPreferencePatch) => Promise<void>;
}) {
  const [mode, setMode] = useState<TaskRowMode>('closed');
  const [name, setName] = useState(taskTitle(task));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const presentation = historyTaskPresentation(task);
  const terminal = presentation.group === 'completed' || presentation.group === 'failed';
  const visibleTime = task.updated_at ?? task.created_at;
  const timeLabel = visibleTime
    ? terminal
      ? `${presentation.group === 'completed' ? '完成于' : '结束于'} ${formatLocalDateTime(visibleTime)}`
      : `更新于 ${formatLocalDateTime(visibleTime)}`
    : null;
  const elapsed = terminal && task.created_at && visibleTime
    ? formatElapsedTime(task.created_at, visibleTime)
    : null;

  useEffect(() => {
    if (mode === 'closed') return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setMode('closed');
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setMode('closed');
      triggerRef.current?.focus();
    };
    document.addEventListener('pointerdown', closeOnOutsidePointer);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [mode]);

  async function save(patch: TaskHistoryPreferencePatch, close = true): Promise<boolean> {
    setSaving(true);
    setError('');
    try {
      await onUpdate(patch);
      if (close) setMode('closed');
      return true;
    } catch {
      setError('保存失败，请重试');
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function submitRename(event: FormEvent): Promise<void> {
    event.preventDefault();
    const displayName = name.trim();
    if (!displayName) {
      setError('名称不能为空');
      return;
    }
    await save({ displayName });
  }

  return (
    <div className="history-task-row" ref={rootRef}>
      {mode === 'rename' ? (
        <form className="history-task-edit" onSubmit={(event) => { void submitRename(event); }}>
          <label className="sr-only" htmlFor={`history-name-${taskKey(task)}`}>任务名称</label>
          <input
            id={`history-name-${taskKey(task)}`}
            autoFocus
            maxLength={200}
            value={name}
            disabled={saving}
            onChange={(event) => setName(event.target.value)}
          />
          <div className="history-task-edit-actions">
            <button type="submit" disabled={saving}>保存</button>
            <button type="button" disabled={saving} onClick={() => setMode('closed')}>取消</button>
          </div>
          {error && <span className="history-task-error" role="alert">{error}</span>}
        </form>
      ) : (
        <>
          <button
            type="button"
            className={`history-task${active ? ' is-active' : ''}`}
            aria-current={active ? 'page' : undefined}
            onClick={onOpen}
            title={taskTitle(task)}
          >
            <span className="history-task-title-row">
              <span className="history-task-title">{taskTitle(task)}</span>
              {task.pinnedAt && <span className="history-task-pinned">置顶</span>}
            </span>
            <span className="history-task-meta">
              <span className={`history-status-dot tone-${presentation.tone}`} aria-hidden="true" />
              <span>{presentation.label}</span>
              <span aria-hidden="true">·</span>
              <span>{task.task_type ?? '未分类'}</span>
            </span>
            {timeLabel ? (
              <span className="history-task-time" title={timeLabel}>
                {timeLabel}{elapsed ? ` · 用时 ${elapsed}` : ''}
              </span>
            ) : null}
          </button>
          <button
            ref={triggerRef}
            type="button"
            className="history-task-more"
            aria-label={`管理任务：${taskTitle(task)}`}
            aria-haspopup="menu"
            aria-expanded={mode !== 'closed'}
            onClick={() => {
              setError('');
              setMode((current) => current === 'closed' ? 'menu' : 'closed');
            }}
          >
            <span aria-hidden="true">…</span>
          </button>

          {(mode === 'menu' || mode === 'delete') && (
            <div
              className="history-task-menu"
              role={mode === 'delete' ? 'alertdialog' : 'menu'}
              aria-label={mode === 'delete' ? '确认删除任务' : '任务操作'}
            >
              {mode === 'delete' ? (
                <div className="history-delete-confirm">
                  <strong>确认删除？</strong>
                  <span>任务将从历史和搜索中隐藏。</span>
                  <div>
                    <button type="button" disabled={saving} onClick={() => setMode('menu')}>取消</button>
                    <button
                      type="button"
                      className="is-danger"
                      disabled={saving}
                      onClick={() => { void save({ hidden: true }, false); }}
                    >
                      删除
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <button
                    type="button"
                    role="menuitem"
                    disabled={saving}
                    onClick={() => { void save({ pinned: !task.pinnedAt }); }}
                  >
                    {task.pinnedAt ? '取消置顶' : '置顶'}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    disabled={saving}
                    onClick={() => {
                      setName(taskTitle(task));
                      setError('');
                      setMode('rename');
                    }}
                  >
                    重命名
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="is-danger"
                    disabled={saving}
                    onClick={() => setMode('delete')}
                  >
                    删除
                  </button>
                </>
              )}
              {error && <span className="history-task-error" role="alert">{error}</span>}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="sidebar-section-label">{children}</div>;
}

function Entry({ children }: { children: React.ReactNode }) {
  return <div className="sidebar-entry">{children}</div>;
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="history-empty">{children}</div>;
}
