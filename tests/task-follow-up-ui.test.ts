import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workbench = new URL('../apps/web/src/pages/Workbench.tsx', import.meta.url);
const hook = new URL('../apps/web/src/hooks/useTaskFlow.ts', import.meta.url);
const panel = new URL('../apps/web/src/components/TaskFollowUpPanel.tsx', import.meta.url);

test('completed reports use a task-scoped follow-up composer instead of starting an unrelated task', async () => {
  const [workbenchSource, hookSource, panelSource] = await Promise.all([
    readFile(workbench, 'utf8'),
    readFile(hook, 'utf8'),
    readFile(panel, 'utf8'),
  ]);

  assert.match(workbenchSource, /<TaskFollowUpPanel/u);
  assert.match(workbenchSource, /phase !== 'done'/u);
  assert.match(hookSource, /api\.controlFollowUps\(taskId\)/u);
  assert.match(hookSource, /api\.createControlFollowUp/u);
  assert.match(panelSource, /基于本报告继续提问/u);
  assert.match(panelSource, /不会重新执行 Skill 或修改原报告/u);
});
