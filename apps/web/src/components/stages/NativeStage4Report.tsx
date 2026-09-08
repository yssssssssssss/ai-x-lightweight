import { useEffect, useState } from 'react';
import type {
  NativeFinalReport,
  NativeSkillResult,
} from '../../../../../packages/api-contract/native-skill-orchestration.ts';
import {
  HISTORICAL_FINAL_REPORT_VERSION,
  type ControlFinalReport,
} from '../../../../../packages/api-contract/historical-final-report.ts';
import { api } from '../../api/client.ts';
import { Header } from './Stage1Understand.tsx';

export function NativeStage4Report({
  taskId,
  finalReport,
  skillResults,
}: {
  taskId: string;
  finalReport: ControlFinalReport;
  skillResults: NativeSkillResult[];
}) {
  const historical = finalReport.version === HISTORICAL_FINAL_REPORT_VERSION;
  const nativeReport: NativeFinalReport | null = historical ? null : finalReport;
  const hasSkillDetails = !historical && skillResults.length > 0;
  const [view, setView] = useState<'final' | 'skills'>('final');
  const [selectedInvocationId, setSelectedInvocationId] = useState(
    skillResults[0]?.invocationId ?? '',
  );
  const [html, setHtml] = useState<string | null>(null);
  const [htmlError, setHtmlError] = useState('');
  const selectedResult = skillResults.find(({ invocationId }) => invocationId === selectedInvocationId)
    ?? skillResults[0];
  const statusLabel = (status: NativeSkillResult['status']) => status === 'completed'
    ? '已完成'
    : status === 'completed_with_gaps' ? '已完成，存在资料缺口' : '需要补充资料';

  useEffect(() => {
    if (!hasSkillDetails) setView('final');
  }, [hasSkillDetails]);

  useEffect(() => {
    let active = true;
    const objectUrls: string[] = [];
    setHtml(null);
    setHtmlError('');
    void (async () => {
      const { blob } = await api.controlFinalReportHtml(taskId);
      let content = await blob.text();
      const assetUrls = [...new Set(content.match(
        /\/api\/control-tasks\/[^/"'<>\s]+\/assets\/[^"'<>\s]+/gu,
      ) ?? [])];
      for (const assetUrl of assetUrls) {
        const encodedAssetId = assetUrl.split('/').at(-1);
        if (!encodedAssetId) continue;
        const asset = await api.controlVisualAsset(taskId, decodeURIComponent(encodedAssetId));
        const objectUrl = URL.createObjectURL(asset.blob);
        objectUrls.push(objectUrl);
        content = content.replaceAll(assetUrl, objectUrl);
      }
      if (active) setHtml(content);
    })().catch((error: unknown) => {
      if (active) setHtmlError(error instanceof Error ? error.message : 'HTML 报告加载失败');
    });
    return () => {
      active = false;
      for (const url of objectUrls) URL.revokeObjectURL(url);
    };
  }, [taskId, finalReport.attemptId]);

  function download(name: string, content: string, type: string) {
    downloadBlob(name, new Blob([content], { type }));
  }

  function downloadBlob(name: string, blob: Blob) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  const primaryContent = historical ? finalReport.markdown : finalReport.primary.content;

  return (
    <section className="stage-card native-report" aria-label="研究报告">
      <Header
        n="4"
        title={finalReport.title}
        note={historical
          ? '历史报告 · 只读'
          : finalReport.mode === 'multi_skill' ? '多项能力综合报告' : '单项能力报告'}
      />
      {historical ? (
        <p role="status">该报告由历史 Lightweight 合同生成，仅支持查看和下载。</p>
      ) : null}
      {hasSkillDetails ? (
        <nav className="report-view-toggle" aria-label="报告视图">
          <button type="button" className={view === 'final' ? 'is-active' : ''} onClick={() => setView('final')}>最终报告</button>
          <button type="button" className={view === 'skills' ? 'is-active' : ''} onClick={() => setView('skills')}>分析明细</button>
        </nav>
      ) : null}
      {view === 'final' ? (
        <>
          <div className="report-actions">
            {historical ? (
              <button
                type="button"
                className="btn-secondary"
                onClick={() => download(`研究报告-${taskId}.md`, finalReport.markdown, 'text/markdown;charset=utf-8')}
              >
                下载 Markdown
              </button>
            ) : null}
            {nativeReport && !nativeReport.reportDocument ? (
              <button
                type="button"
                className="btn-secondary"
                onClick={() => download(
                  `研究报告-${taskId}.${nativeReport.primary.format === 'html' ? 'html' : 'md'}`,
                  nativeReport.primary.content,
                  nativeReport.primary.format === 'html' ? 'text/html;charset=utf-8' : 'text/markdown;charset=utf-8',
                )}
              >
                下载原始报告
              </button>
            ) : null}
            {html && (!nativeReport || !nativeReport.reportDocument) ? (
              <button
                type="button"
                className="btn-ghost"
                onClick={() => download(`研究报告-${taskId}.html`, html, 'text/html;charset=utf-8')}
              >
                下载 HTML
              </button>
            ) : null}
            {nativeReport?.reportDocument ? (
              <button
                type="button"
                className="btn-ghost"
                onClick={() => {
                  void api.controlFinalReportZip(taskId)
                    .then(({ blob }) => downloadBlob(`研究报告-${taskId}.zip`, blob))
                    .catch((error: unknown) => setHtmlError(
                      error instanceof Error ? error.message : '离线报告下载失败',
                    ));
                }}
              >
                下载离线报告
              </button>
            ) : null}
            {nativeReport?.attachments.map((attachment, index) => (
              <button
                key={attachment.path}
                type="button"
                className="btn-ghost"
                onClick={() => download(attachment.path.split('/').at(-1) ?? 'attachment', attachment.content, attachment.mediaType)}
              >
                下载附件 {index + 1}
              </button>
            ))}
          </div>
          {htmlError ? <p role="alert">{htmlError}</p> : null}
          {html
            ? (
              <iframe
                className="native-report-document"
                title={finalReport.title}
                sandbox=""
                srcDoc={html}
              />
            )
            : <pre className="native-report-content">{primaryContent}</pre>}
          {historical && finalReport.gaps.length > 0 ? (
            <section>
              <h3>资料缺口</h3>
              <ul>{finalReport.gaps.map((gap) => <li key={gap}>{gap}</li>)}</ul>
            </section>
          ) : null}
        </>
      ) : (
        <>
          <div className="report-view-toggle" aria-label="分析结果选择">
            {skillResults.map((report) => (
              <button
                key={report.invocationId}
                type="button"
                className={selectedResult?.invocationId === report.invocationId ? 'is-active' : ''}
                onClick={() => setSelectedInvocationId(report.invocationId)}
              >
                {report.title}
              </button>
            ))}
          </div>
          {selectedResult ? (
            <article>
              <p><b>状态：</b>{statusLabel(selectedResult.status)}</p>
              {selectedResult.reportDocument
                ? <p className="native-report-content">结构化分析已纳入最终报告。</p>
                : <pre className="native-report-content">{selectedResult.primary.content}</pre>}
              {selectedResult.gaps.length > 0 ? (
                <section>
                  <h3>资料缺口</h3>
                  <ul>{selectedResult.gaps.map((gap) => <li key={gap}>{gap}</li>)}</ul>
                </section>
              ) : null}
              {selectedResult.attachments.length > 0 ? (
                <section>
                  <h3>附件</h3>
                  <ul>{selectedResult.attachments.map((attachment, index) => (
                    <li key={attachment.path}>
                      <button
                        type="button"
                        className="btn-ghost"
                        onClick={() => download(attachment.path.split('/').at(-1) ?? 'attachment', attachment.content, attachment.mediaType)}
                      >
                        附件 {index + 1}
                      </button>
                    </li>
                  ))}</ul>
                </section>
              ) : null}
              <section>
                <h3>来源</h3>
                {selectedResult.sources.length === 0 ? <p>无</p> : (
                  <ul>{selectedResult.sources.map((source) => (
                    <li key={source.id}>
                      {source.url
                        ? <a href={source.url} target="_blank" rel="noopener noreferrer">{source.title}</a>
                        : source.title}
                    </li>
                  ))}</ul>
                )}
              </section>
            </article>
          ) : <p>没有可用的分析结果。</p>}
        </>
      )}
    </section>
  );
}
