import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { closePool, loadEnv, pool } from '../../../database/db.ts';
loadEnv(); // 读 .env:DATABASE_URL / LLM 网关 / JWT_SECRET

import express from 'express';
import { ControlPlaneRepository, type ControlTaskDetail } from '../../../database/control-plane.ts';
import { TaskWorkflowService } from '../../orchestrator-runtime/src/control/task-workflow.ts';
import {
  ControlPlaneExecutionRecoveryStore,
  ExecutionRecoveryController,
  ExecutionRecoveryService,
} from '../../orchestrator-runtime/src/control/execution-recovery-service.ts';
import { authRouter } from './routes/auth.ts';
import { conversationsRouter } from './routes/conversations.ts';
import { tasksRouter } from './routes/tasks.ts';
import { feedbackRouter } from './routes/feedback.ts';
import { skillsRouter } from './routes/skills.ts';
import { taskHistoryRouter } from './routes/task-history.ts';
import { systemCapabilitiesRouter } from './routes/system-capabilities.ts';
import { createControlTasksRouter, type ControlClarificationPort } from './routes/control-tasks.ts';
import {
  createControlPlanningRouter,
  type ClarificationRequiredResponse,
  type ControlPlanningPort,
  type CurrentPlanningResponse,
} from './routes/control-planning.ts';
import { requireJwtSecret } from './auth.ts';
import { buildControlRuntime, type ControlRuntime } from './control-runtime.ts';
import {
  createZeroIntegrationRouter,
  createZeroPublicationRouter,
} from './routes/zero-publications.ts';
export interface AgentApiDependencies {
  controlRuntime?: ControlRuntime;
  controlPlanning?: ControlPlanningPort;
  webDistDir?: string | false;
}

function refinementResponse(
  result: {
    status: 'clarification_required';
    taskId: string;
    requirement: ClarificationRequiredResponse['structuredTask'];
    planningGuidance?: ClarificationRequiredResponse['planningGuidance'];
    activatedNodes?: string[];
  },
  task: ControlTaskDetail | null,
): ClarificationRequiredResponse {
  if (!task) throw new Error(`task ${result.taskId} disappeared after refinement`);
  return {
    kind: 'current',
    status: 'clarification_required',
    conversationId: task.conversationId,
    task: {
      id: task.id,
      state: task.state,
      stateVersion: task.stateVersion,
      activePlanVersionId: task.activePlanVersionId,
      currentAttemptId: task.currentAttemptId,
      orchestrationMode: task.orchestrationMode ?? null,
    },
    structuredTask: result.requirement,
    activatedNodes: result.activatedNodes ?? [],
    candidates: [],
    ...(result.planningGuidance ? { planningGuidance: result.planningGuidance } : {}),
  };
}

async function failIncompletePlanningTask(runtime: ControlRuntime, taskId: string): Promise<void> {
  try {
    const task = await runtime.repository.getTaskDetail(taskId);
    if (task?.state !== 'awaiting_clarification') return;
    await runtime.repository.transitionTask({
      taskId,
      expectedVersion: task.stateVersion,
      from: 'awaiting_clarification',
      to: 'failed',
    });
  } catch {
    // Preserve the planning error. A concurrent state change makes this cleanup unnecessary.
  }
}

function refinementPlanningPort(runtime: ControlRuntime): ControlPlanningPort {
  return {
    async plan(input, onProgress, onConversation): Promise<CurrentPlanningResponse> {
      const conversation = input.conversationId
        ? await runtime.conversations.requireOwned({
            conversationId: input.conversationId,
            ownerUserId: input.ownerUserId,
          })
        : await runtime.conversations.create({
            ownerUserId: input.ownerUserId,
            title: input.originalInput.slice(0, 40),
          });
      onConversation?.(conversation.id);
      const created = await runtime.repository.createTask({
        conversationId: conversation.id,
        ownerUserId: input.ownerUserId,
        originalInput: input.originalInput,
        taskType: null,
        structuredTask: {},
        state: 'awaiting_clarification',
        orchestrationMode: input.orchestrationMode,
      });
      try {
        const result = await runtime.requirementRefinement.understand({
          taskId: created.id,
          conversationId: conversation.id,
          ownerUserId: input.ownerUserId,
          originalInput: input.originalInput,
          orchestrationMode: input.orchestrationMode,
          expectedVersion: created.stateVersion,
        }, onProgress);
        if (result.status === 'clarification_required') {
          return refinementResponse(result, await runtime.repository.getTaskDetail(created.id));
        }
        const readyTask = await runtime.repository.getTaskDetail(created.id);
        if (!readyTask) throw new Error(`task ${created.id} disappeared after refinement`);
        if (!result.planningResult) throw new Error('refinement ready result has no finalized planning result');
        return await runtime.controlPlanning.planExistingTask({
          taskId: readyTask.id,
          conversationId: conversation.id,
          ownerUserId: input.ownerUserId,
          expectedStateVersion: readyTask.stateVersion,
          originalInput: input.originalInput,
          orchestrationMode: readyTask.orchestrationMode ?? 'single_skill',
        }, result.planningResult);
      } catch (error) {
        await failIncompletePlanningTask(runtime, created.id);
        throw error;
      }
    },
  };
}

function refinementClarificationPort(runtime: ControlRuntime): ControlClarificationPort {
  return {
    async clarify(input, onProgress) {
      const result = await runtime.requirementRefinement.clarify({
        taskId: input.taskId,
        conversationId: input.conversationId,
        ownerUserId: input.ownerUserId,
        answers: { ...input.answers, assumption_edits: input.assumptionEdits },
        ...(input.selectedScenarioId ? { selectedScenarioId: input.selectedScenarioId } : {}),
        expectedVersion: input.expectedVersion,
      }, onProgress);
      if (result.status === 'clarification_required') {
        return refinementResponse(result, await runtime.repository.getTaskDetail(input.taskId));
      }
      const clarifiedTask = await runtime.repository.getTaskDetail(input.taskId);
      if (!clarifiedTask) throw new Error(`task ${input.taskId} disappeared after clarification`);
      if (!result.planningResult) throw new Error('clarification ready result has no finalized planning result');
      onProgress?.({ phase: 'persist', status: 'start', label: '保存候选方案' });
      const response = await runtime.controlPlanning.planExistingTask({
        taskId: clarifiedTask.id,
        conversationId: input.conversationId,
        ownerUserId: input.ownerUserId,
        expectedStateVersion: clarifiedTask.stateVersion,
        originalInput: clarifiedTask.originalInput,
        orchestrationMode: clarifiedTask.orchestrationMode ?? 'single_skill',
        commandReservation: input.commandReservation,
        clarificationRecovery: result.clarificationRecovery,
      }, result.planningResult);
      onProgress?.({
        phase: 'persist',
        status: 'done',
        label: '保存候选方案',
        detail: `${response.candidates.length} 份候选方案已就绪`,
      });
      return response;
    },
  };
}


export function createAgentApiApp(deps: AgentApiDependencies = {}) {
  requireJwtSecret();
  const app = express();
  app.use(express.json({ limit: '12mb' })); // execute 可携带设计稿 base64(图像工具 upload 上限 10MB + base64 膨胀)

  app.get('/api/healthz', (_req, res) => res.json({ ok: true }));
  app.use('/api/system/capabilities', systemCapabilitiesRouter);
  app.use('/api/auth', authRouter);
  app.use('/api/conversations', conversationsRouter);
  app.use('/api/tasks', tasksRouter);
  app.use('/api/tasks', feedbackRouter);
  app.use('/api/task-history', taskHistoryRouter);
  app.use('/api/skills', skillsRouter);
  const zeroPublication = deps.controlRuntime?.zeroPublication;
  app.use('/api/integrations/zero', createZeroIntegrationRouter(zeroPublication));
  app.use('/api/control-tasks', createZeroPublicationRouter(zeroPublication));
  if (deps.controlRuntime) {
    const planning = refinementPlanningPort(deps.controlRuntime);
    app.use('/api/control-tasks', createControlPlanningRouter(planning));
    app.use('/api/control-tasks', createControlTasksRouter({
      ...deps.controlRuntime,
      clarification: refinementClarificationPort(deps.controlRuntime),
    }));
  } else {
    if (deps.controlPlanning) {
      app.use('/api/control-tasks', createControlPlanningRouter(deps.controlPlanning));
    }
    const repository = new ControlPlaneRepository(pool);
    app.use('/api/control-tasks', createControlTasksRouter({
      repository,
      workflow: new TaskWorkflowService(repository),
      getDeliverable: async () => null,
    }));
  }

  const webDistDir = deps.webDistDir === false
    ? null
    : resolve(deps.webDistDir ?? 'apps/web/dist');
  const webIndex = webDistDir ? resolve(webDistDir, 'index.html') : null;
  if (webDistDir && webIndex && existsSync(webIndex)) {
    app.use(express.static(webDistDir, {
      index: false,
      setHeaders(response, filePath) {
        response.setHeader(
          'Cache-Control',
          filePath.includes(`${webDistDir}/assets/`)
            ? 'public, max-age=31536000, immutable'
            : 'no-cache',
        );
      },
    }));
    app.use((req, res, next) => {
      if (req.method !== 'GET' || req.path === '/api' || req.path.startsWith('/api/')) {
        next();
        return;
      }
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(webIndex);
    });
  }
  return app;
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const PORT = Number(process.env.API_PORT ?? 3001);
  const HOST = process.env.HOST?.trim() || '127.0.0.1';
  const controlRuntime = buildControlRuntime();
  const recovery = new ExecutionRecoveryController(
    new ExecutionRecoveryService({
      store: new ControlPlaneExecutionRecoveryStore(
        controlRuntime.repository,
        controlRuntime.artifacts,
      ),
    }),
  );
  await recovery.start();
  const zeroRecoveryIntervalMs = Number(process.env.ZERO_PUBLICATION_RECOVERY_INTERVAL_MS ?? 30_000);
  const recoverZeroPublications = () => {
    if (!controlRuntime.zeroPublication) return;
    void controlRuntime.zeroPublication.recoverExpired().catch((error: unknown) => {
      console.error('Zero publication recovery failed', error);
    });
  };
  recoverZeroPublications();
  const zeroRecoveryTimer = controlRuntime.zeroPublication
    ? setInterval(recoverZeroPublications, zeroRecoveryIntervalMs)
    : null;
  zeroRecoveryTimer?.unref();
  const server = createAgentApiApp({ controlRuntime }).listen(PORT, HOST, () => {
    console.log(`agent-api listening on http://${HOST}:${PORT}`);
  });
  const shutdown = async () => {
    if (zeroRecoveryTimer) clearInterval(zeroRecoveryTimer);
    await recovery.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closePool();
  };
  process.once('SIGINT', () => { void shutdown(); });
  process.once('SIGTERM', () => { void shutdown(); });
}
