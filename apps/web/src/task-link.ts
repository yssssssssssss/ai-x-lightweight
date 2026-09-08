const CURRENT_TASK_ID_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu;

export function taskIdFromLocationSearch(search: string): string | null {
  const params = new URLSearchParams(search);
  const taskId = params.get('task') ?? params.get('report-fixed');
  return taskId && CURRENT_TASK_ID_PATTERN.test(taskId) ? taskId : null;
}
