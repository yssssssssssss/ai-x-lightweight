import { useState, type FormEvent } from 'react';
import type { TaskFollowUpMessageV1 } from '../api/client.ts';

export function TaskFollowUpPanel({
  messages,
  loading,
  submitting,
  error,
  onSubmit,
}: {
  messages: TaskFollowUpMessageV1[];
  loading: boolean;
  submitting: boolean;
  error: string;
  onSubmit: (message: string) => Promise<boolean>;
}) {
  const [message, setMessage] = useState('');

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const content = message.trim();
    if (!content || submitting) return;
    if (await onSubmit(content)) setMessage('');
  }

  return (
    <section className="stage-card" aria-labelledby="report-follow-up-title">
      <h3 id="report-follow-up-title" style={{ margin: '0 0 6px' }}>基于本报告继续提问</h3>
      <p style={{ margin: '0 0 14px', color: 'var(--text-dim)', fontSize: 13 }}>
        回答只使用当前报告及其已核验来源，不会重新执行 Skill 或修改原报告；如需补充新事实或重跑，请使用左侧“新任务”。
      </p>

      {loading ? <p role="status">正在读取追问记录…</p> : null}
      {!loading && messages.length === 0 ? (
        <p style={{ color: 'var(--text-faint)', fontSize: 13 }}>暂无追问。</p>
      ) : null}
      {messages.length > 0 ? (
        <div style={{ display: 'grid', gap: 10, marginBottom: 14 }} aria-live="polite">
          {messages.map((item) => (
            <article
              key={item.id}
              style={{
                justifySelf: item.role === 'user' ? 'end' : 'stretch',
                maxWidth: item.role === 'user' ? '82%' : '100%',
                padding: '10px 12px',
                border: '1px solid var(--border-soft)',
                borderRadius: 10,
                background: item.role === 'user' ? 'var(--bg-elev)' : 'var(--bg-card)',
              }}
            >
              <div style={{ marginBottom: 5, color: 'var(--text-faint)', fontSize: 11 }}>
                {item.role === 'user' ? '你的追问' : '基于报告的回答'}
              </div>
              <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.65 }}>{item.content}</div>
              {item.sourceIds.length > 0 ? (
                <div style={{ marginTop: 8, color: 'var(--text-dim)', fontSize: 12 }}>
                  来源：{item.sourceIds.join('、')}
                </div>
              ) : null}
              {item.gaps.length > 0 ? (
                <div style={{ marginTop: 6, color: 'var(--warn)', fontSize: 12 }}>
                  资料限制：{item.gaps.join('；')}
                </div>
              ) : null}
            </article>
          ))}
        </div>
      ) : null}

      <form onSubmit={(event) => { void submit(event); }} style={{ display: 'grid', gap: 8 }}>
        <textarea
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          maxLength={4_000}
          rows={3}
          disabled={loading || submitting}
          placeholder="针对当前报告继续提问"
          aria-label="针对当前报告继续提问"
          style={{ resize: 'vertical' }}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button className="btn-primary" disabled={loading || submitting || message.trim() === ''}>
            {submitting ? '正在回答…' : '发送追问'}
          </button>
          {error ? <span role="alert" style={{ color: 'var(--danger)', fontSize: 12 }}>{error}</span> : null}
        </div>
      </form>
    </section>
  );
}
