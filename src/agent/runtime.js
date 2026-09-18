// src/agent/runtime.js
import { createDecisionPayload, createFailedFinalResultPayload, createFinalResultPayload, createProgressPayload } from './payloads.js';

export function createRuntime({ runStore, outboxStore, waitStore, planner, registry, eventPublisher, auditLogger, executor = defaultExecutor }) {
  return new Runtime({ runStore, outboxStore, waitStore, planner, registry, eventPublisher, auditLogger, executor });
}

function defaultExecutor(task) {
  return task();
}

function runtimeError(message, code, retryable = false, summary) {
  const err = new Error(message);
  err.code = code;
  err.retryable = retryable;
  err.summary = summary;
  return err;
}

function validateDecisionResponse(decision, response) {
  if (!response || typeof response !== 'object') {
    throw runtimeError('Decision response is required', 'invalid_decision_response', false, '缺少用户决策响应');
  }
  const options = decision?.options ?? [];
  const validIds = new Set(options.map((option) => option.id));
  if (!validIds.has(response.selected_option)) {
    throw runtimeError(
      `Invalid selected_option: ${String(response.selected_option)}`,
      'invalid_decision_response',
      false,
      `用户选择了无效的选项：${String(response.selected_option)}`,
    );
  }
  const requiredFormFields = (decision?.formSchema ?? [])
    .filter((field) => field.required)
    .map((field) => field.id);
  const formData = response.form_data ?? {};
  for (const fieldId of requiredFormFields) {
    if (formData[fieldId] == null || formData[fieldId] === '') {
      throw runtimeError(
        `Missing required form field: ${fieldId}`,
        'invalid_decision_response',
        false,
        `缺少必填表单字段：${fieldId}`,
      );
    }
  }
}

class Runtime {
  #runStore;
  #outboxStore;
  #waitStore;
  #planner;
  #registry;
  #eventPublisher;
  #auditLogger;
  #executor;

  constructor({ runStore, outboxStore, waitStore, planner, registry, eventPublisher, auditLogger, executor }) {
    this.#runStore = runStore;
    this.#outboxStore = outboxStore;
    this.#waitStore = waitStore;
    this.#planner = planner;
    this.#registry = registry;
    this.#eventPublisher = eventPublisher;
    this.#auditLogger = auditLogger;
    this.#executor = executor;
  }

  getRun(runId) {
    return this.#runStore.getRun(runId);
  }

  // Public entry used by HTTP layer. Creates the run synchronously and returns it
  // immediately (async ACK). Execution continues in the background via executor.
  startRun(input) {
    const created = this.#runStore.createRun(input);
    this.#auditLogger.log({ runId: created.run_id, event: 'run.start', status: 'OK', summary: 'Run created',
      requesterId: created.user_open_id, originalRequest: created.request_text,
      expectedPurpose: '解析审计请求，执行审计工具并汇总结果' })
      .catch(() => {});
    this.#executor(() => this.#planAndExecute(created.run_id).catch((error) => {
      // Defensive: #planAndExecute converges its own failures, but guard
      // against a rejection from #failRun or audit logging so the background
      // task never surfaces an unhandled rejection.
      this.#safeFail(created.run_id, error);
    }));
    return created;
  }

  // Background plan + execute with unified failure convergence (P1-01).
  // Never rejects: any thrown error is converged to a failed terminal state.
  async #planAndExecute(runId) {
    try {
      const run = this.#runStore.transitionRun(runId, 'planning');
      const decision = await this.#planner.createInitialPlan({
        requestText: run.request_text,
        metadata: run.metadata_json,
      });

      if (decision.type === 'decision_request') {
        const decisionId = this.#waitStore.createWaitingState({
          runId,
          schemaJson: decision.decision,
          contextJson: { requestText: run.request_text, metadata: run.metadata_json },
          requestedByStep: 0,
        });
        // planning -> running -> waiting_user (state machine requires the pass-through).
        this.#runStore.transitionRun(runId, 'running');
        const waitingRun = this.#runStore.transitionRun(runId, 'waiting_user');
        this.#eventPublisher.enqueueRunEvent(waitingRun, 'decision_request', createDecisionPayload(waitingRun, decisionId, decision.decision));
        await this.#auditLogger.log({ runId, event: 'run.waiting_user', status: 'OK', summary: 'Run waiting for user input' });
        return waitingRun;
      }

      this.#runStore.transitionRun(runId, 'running', { plan: decision.plan });
      return await this.#executePlan(runId, decision.plan);
    } catch (error) {
      await this.#failRun(runId, error);
      return this.#runStore.getRun(runId);
    }
  }

  async resumeRun(runId, body) {
    const run = this.#runStore.getRun(runId);
    if (!run) throw runtimeError(`Run not found: ${runId}`, 'run_not_found', false, '运行任务不存在');

    // P2-03: resume must target a run currently waiting for the user.
    if (run.status !== 'waiting_user') {
      throw runtimeError(
        `Run ${runId} is not waiting for user input (status=${run.status})`,
        'resume_conflict',
        false,
        `运行任务当前状态为 ${run.status}，无法恢复`,
      );
    }

    const waiting = this.#waitStore.getWaitingState(body.decision_id);
    if (!waiting || waiting.run_id !== runId || waiting.status !== 'pending') {
      throw runtimeError(
        'Waiting state not found or already resolved',
        'resume_conflict',
        false,
        '决策状态不存在或已被处理',
      );
    }

    // P2-03: validate the user response against the decision schema BEFORE
    // mutating any state, so an invalid option leaves waiting pending and the
    // user can resubmit the same card.
    validateDecisionResponse(waiting.schema_json, body.response);

    // P2-02: resolve only after planning succeeds; if planning throws, the
    // waiting state stays pending and the run stays waiting_user, so the user
    // can retry the same decision.
    let planning;
    try {
      planning = await this.#planner.resumeFromDecision(waiting.context_json, body.response);
    } catch (error) {
      await this.#auditLogger.log({ runId, event: 'run.resume', status: 'INTERNAL', summary: error.message }).catch(() => {});
      throw error;
    }

    this.#waitStore.resolveWaitingState(body.decision_id);
    this.#runStore.transitionRun(runId, 'running', { plan: planning.plan });
    await this.#auditLogger.log({ runId, event: 'run.resume', status: 'OK', summary: 'Run resumed from user decision' });

    try {
      return await this.#executePlan(runId, planning.plan);
    } catch (error) {
      await this.#failRun(runId, error);
      throw error;
    }
  }

  async #executePlan(runId, plan) {
    const run = this.#runStore.getRun(runId);
    const toolResults = [];

    for (let index = 0; index < plan.steps.length; index += 1) {
      const step = plan.steps[index];
      const progressPayload = createProgressPayload(run, `正在执行 ${step.stepName}`, index + 1, plan.steps.length);
      this.#eventPublisher.enqueueRunEvent(run, 'progress_update', progressPayload);

      const envelope = await this.#registry.execute(step.toolName, step.input, { runId });

      if (!envelope.ok) {
        this.#runStore.appendStep({
          runId,
          stepIndex: index,
          stepName: step.stepName,
          status: 'failed',
          toolName: step.toolName,
          inputJson: step.input,
          outputJson: { error: envelope.error },
        });
        const err = runtimeError(
          envelope.error.message,
          envelope.error.code,
          envelope.error.retryable,
          envelope.error.summary,
        );
        err.toolName = step.toolName;
        err.stepName = step.stepName;
        throw err;
      }

      toolResults.push({ stepName: step.stepName, result: envelope.data });
      this.#runStore.appendStep({
        runId,
        stepIndex: index,
        stepName: step.stepName,
        status: 'completed',
        toolName: step.toolName,
        inputJson: step.input,
        outputJson: envelope.data,
      });
    }

    const finalResult = await this.#planner.synthesizeFinalResult({ runId, toolResults });
    const completedRun = this.#runStore.transitionRun(runId, 'completed', { result: finalResult, currentStepIndex: plan.steps.length });
    this.#eventPublisher.enqueueRunEvent(completedRun, 'final_result', createFinalResultPayload(completedRun, finalResult));
    await this.#auditLogger.log({ runId, event: 'run.final_result', status: 'OK', summary: finalResult.summary });
    return completedRun;
  }

  async #failRun(runId, error) {
    try {
      const current = this.#runStore.getRun(runId);
      if (!current) return;
      if (current.status === 'failed' || current.status === 'completed' || current.status === 'cancelled') return;

      const errorCode = error?.code ?? 'runtime_error';
      const errorMessage = error?.message ?? 'Unknown error';
      const failedResult = { type: 'final_result', status: 'failed', title: '任务执行失败', summary: error?.summary ?? errorMessage, error: { code: errorCode, message: errorMessage, retryable: error?.retryable ?? false } };

      let failedRun;
      try {
        failedRun = this.#runStore.transitionRun(runId, 'failed', {
          result: failedResult,
          errorCode,
          errorMessage,
        });
      } catch (transitionError) {
        // If the current status cannot transition directly to failed, force it via updateRun.
        failedRun = this.#runStore.updateRun(runId, {
          status: 'failed',
          result: failedResult,
          errorCode,
          errorMessage,
        });
      }

      this.#eventPublisher.enqueueRunEvent(failedRun, 'final_result', createFailedFinalResultPayload(failedRun, error));
      await this.#auditLogger.log({ runId, event: 'run.failed', status: 'INTERNAL', summary: errorMessage }).catch(() => {});
    } catch {
      // Best-effort failure convergence during teardown; never surface.
    }
  }

  async #safeFail(runId, error) {
    try {
      await this.#failRun(runId, error);
    } catch {
      // Swallow: best-effort failure convergence during teardown.
    }
  }

  async #handleExecutionFailure(runId, error) {
    const current = this.#runStore.getRun(runId);
    if (current && current.status !== 'failed' && current.status !== 'completed') {
      await this.#safeFail(runId, error);
    }
  }
}
