/**
 * Copyright 2024 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { randomUUID } from 'crypto';
import { getDatasetStore, getEvalStore } from '.';
import type { RuntimeManager } from '../manager/manager';
import {
  DatasetSchema,
  GenerateResponseSchema,
  type Action,
  type CandidateData,
  type Dataset,
  type EvalInput,
  type EvalKeyAugments,
  type EvalRun,
  type EvalRunKey,
  type RunNewEvaluationRequest,
  type SpanData,
} from '../types';
import {
  evaluatorName,
  generateTestCaseId,
  getEvalExtractors,
  getModelInput,
  hasAction,
  isEvaluator,
  logger,
  stackTraceSpans,
} from '../utils';
import {
  enrichResultsWithScoring,
  extractMetricSummaries,
  extractMetricsMetadata,
} from './parser';

interface InferenceRunState {
  testCaseId: string;
  input: any;
  reference?: any;
  traceId?: string;
  response?: any;
  evalError?: string;
}

interface FullInferenceSample {
  testCaseId: string;
  input: any;
  reference?: any;
}

const SUPPORTED_ACTION_TYPES = ['flow', 'model'] as const;

/**
 * Starts a new evaluation run. Intended to be used via the reflection API.
 */
export async function runNewEvaluation(
  manager: RuntimeManager,
  request: RunNewEvaluationRequest
): Promise<EvalRunKey> {
  const { dataSource, actionRef, evaluators } = request;
  const { datasetId, data } = dataSource;
  if (!datasetId && !data) {
    throw new Error(`Either 'data' or 'datasetId' must be provided`);
  }

  const hasTargetAction = await hasAction({ manager, actionRef });
  if (!hasTargetAction) {
    throw new Error(`Cannot find action ${actionRef}.`);
  }

  let inferenceDataset: Dataset;
  let metadata = {};

  if (datasetId) {
    const datasetStore = await getDatasetStore();
    logger.info(`Fetching dataset ${datasetId}...`);
    const dataset = await datasetStore.getDataset(datasetId);
    if (dataset.length === 0) {
      throw new Error(`Dataset ${datasetId} is empty`);
    }
    inferenceDataset = DatasetSchema.parse(dataset);

    const datasetMetadatas = await datasetStore.listDatasets();
    const targetDatasetMetadata = datasetMetadatas.find(
      (d) => d.datasetId === datasetId
    );
    const datasetVersion = targetDatasetMetadata?.version;
    metadata = { datasetId, datasetVersion };
  } else {
    const rawData = data!.map((sample) => ({
      ...sample,
      testCaseId: sample.testCaseId ?? generateTestCaseId(),
    }));
    inferenceDataset = DatasetSchema.parse(rawData);
  }

  logger.info('Running inference...');
  const evalDataset = await runInference({
    manager,
    actionRef,
    inferenceDataset,
    context: request.options?.context,
    actionConfig: request.options?.actionConfig,
  });
  const evaluatorActions = await getMatchingEvaluatorActions(
    manager,
    evaluators
  );

  const evalRun = await runEvaluation({
    manager,
    evaluatorActions,
    evalDataset,
    batchSize: request.options?.batchSize,
    augments: {
      ...metadata,
      actionRef,
      actionConfig: request.options?.actionConfig,
    },
  });
  return evalRun.key;
}

/** Handles the Inference part of Inference-Evaluation cycle */
export async function runInference(params: {
  manager: RuntimeManager;
  actionRef: string;
  inferenceDataset: Dataset;
  context?: string;
  actionConfig?: any;
}): Promise<EvalInput[]> {
  const { manager, actionRef, inferenceDataset, context, actionConfig } =
    params;
  if (!isSupportedActionRef(actionRef)) {
    throw new Error('Inference is only supported on flows and models');
  }

  const evalDataset: EvalInput[] = await bulkRunAction({
    manager,
    actionRef,
    inferenceDataset,
    context,
    actionConfig,
  });
  return evalDataset;
}

/** Handles the Evaluation part of Inference-Evaluation cycle */
export async function runEvaluation(params: {
  manager: RuntimeManager;
  evaluatorActions: Action[];
  evalDataset: EvalInput[];
  augments?: EvalKeyAugments;
  batchSize?: number;
}): Promise<EvalRun> {
  const { manager, evaluatorActions, evalDataset, augments, batchSize } =
    params;
  if (evalDataset.length === 0) {
    throw new Error('Cannot run evaluation, no data provided');
  }
  const evalRunId = randomUUID();
  const scores: Record<string, any> = {};
  logger.info('Running evaluation...');

  const runtime = manager.getMostRecentRuntime();
  const isNodeRuntime = runtime?.genkitVersion?.startsWith('nodejs') ?? false;

  for (const action of evaluatorActions) {
    const name = evaluatorName(action);
    const response = await manager.runAction({
      key: name,
      input: {
        dataset: evalDataset.filter((row) => !row.error),
        evalRunId,
        batchSize: isNodeRuntime ? batchSize : undefined,
      },
    });
    scores[name] = response.result;
  }

  const scoredResults = enrichResultsWithScoring(scores, evalDataset);
  const metadata = extractMetricsMetadata(evaluatorActions);
  const metricSummaries = extractMetricSummaries(scores);

  const evalRun = {
    key: {
      evalRunId,
      createdAt: new Date().toISOString(),
      metricSummaries,
      ...augments,
    },
    results: scoredResults,
    metricsMetadata: metadata,
  };

  logger.info('Finished evaluation, writing key...');
  const evalStore = await getEvalStore();
  await evalStore.save(evalRun);
  return evalRun;
}

export async function getAllEvaluatorActions(
  manager: RuntimeManager
): Promise<Action[]> {
  const allActions = await manager.listActions();
  const allEvaluatorActions = [];
  for (const key in allActions) {
    if (isEvaluator(key)) {
      allEvaluatorActions.push(allActions[key]);
    }
  }
  return allEvaluatorActions;
}

export async function getMatchingEvaluatorActions(
  manager: RuntimeManager,
  evaluators?: string[]
): Promise<Action[]> {
  if (!evaluators) {
    return [];
  }
  const allEvaluatorActions = await getAllEvaluatorActions(manager);
  const filteredEvaluatorActions = allEvaluatorActions.filter((action) =>
    evaluators.includes(action.key)
  );
  if (filteredEvaluatorActions.length === 0) {
    if (allEvaluatorActions.length == 0) {
      throw new Error('No evaluators installed');
    }
  }
  return filteredEvaluatorActions;
}

async function bulkRunAction(params: {
  manager: RuntimeManager;
  actionRef: string;
  inferenceDataset: Dataset;
  context?: string;
  actionConfig?: any;
}): Promise<EvalInput[]> {
  const { manager, actionRef, inferenceDataset, context, actionConfig } =
    params;
  const isModelAction = actionRef.startsWith('/model');
  if (inferenceDataset.length === 0) {
    throw new Error('Cannot run inference, no data provided');
  }

  // Convert to satisfy TS checks. `input` is required in `Dataset` type, but
  // ZodAny also includes `undefined` in TS checks. This explcit conversion
  // works around this.
  const fullInferenceDataset = inferenceDataset as FullInferenceSample[];

  const states: InferenceRunState[] = [];
  const evalInputs: EvalInput[] = [];
  for (const sample of fullInferenceDataset) {
    logger.info(`Running inference '${actionRef}' ...`);
    if (isModelAction) {
      states.push(
        await runModelAction({
          manager,
          actionRef,
          sample,
          modelConfig: actionConfig,
        })
      );
    } else {
      states.push(
        await runFlowAction({
          manager,
          actionRef,
          sample,
          context,
        })
      );
    }
  }

  logger.info(`Gathering evalInputs...`);
  for (const state of states) {
    evalInputs.push(await gatherEvalInput({ manager, actionRef, state }));
  }
  return evalInputs;
}

async function runFlowAction(params: {
  manager: RuntimeManager;
  actionRef: string;
  sample: FullInferenceSample;
  context?: any;
}): Promise<InferenceRunState> {
  const { manager, actionRef, sample, context } = { ...params };
  let state: InferenceRunState;
  try {
    const runActionResponse = await manager.runAction({
      key: actionRef,
      input: sample.input,
      context: context ? JSON.parse(context) : undefined,
    });
    state = {
      ...sample,
      traceId: runActionResponse.telemetry?.traceId,
      response: runActionResponse.result,
    };
  } catch (e: any) {
    const traceId = e?.data?.details?.traceId;
    state = {
      ...sample,
      traceId,
      evalError: `Error when running inference. Details: ${e?.message ?? e}`,
    };
  }
  return state;
}

async function runModelAction(params: {
  manager: RuntimeManager;
  actionRef: string;
  sample: FullInferenceSample;
  modelConfig?: any;
}): Promise<InferenceRunState> {
  const { manager, actionRef, modelConfig, sample } = { ...params };
  let state: InferenceRunState;
  try {
    const modelInput = getModelInput(sample.input, modelConfig);
    const runActionResponse = await manager.runAction({
      key: actionRef,
      input: modelInput,
    });
    state = {
      ...sample,
      traceId: runActionResponse.telemetry?.traceId,
      response: runActionResponse.result,
    };
  } catch (e: any) {
    const traceId = e?.data?.details?.traceId;
    state = {
      ...sample,
      traceId,
      evalError: `Error when running inference. Details: ${e?.message ?? e}`,
    };
  }
  return state;
}

async function gatherEvalInput(params: {
  manager: RuntimeManager;
  actionRef: string;
  state: InferenceRunState;
}): Promise<EvalInput> {
  const { manager, actionRef, state } = params;

  const extractors = await getEvalExtractors(actionRef);
  const traceId = state.traceId;
  if (!traceId) {
    logger.warn('No traceId available...');
    return {
      ...state,
      error: state.evalError,
      testCaseId: state.testCaseId,
      traceIds: [],
    };
  }

  const trace = await manager.getTrace({
    traceId,
  });

  const isModelAction = actionRef.startsWith('/model');
  // Always use original input for models.
  const input = isModelAction ? state.input : extractors.input(trace);

  const nestedSpan = stackTraceSpans(trace);
  if (!nestedSpan) {
    return {
      testCaseId: state.testCaseId,
      input,
      error: `Unable to extract any spans from trace ${traceId}`,
      reference: state.reference,
      traceIds: [traceId],
    };
  }

  if (nestedSpan.attributes['genkit:state'] === 'error') {
    return {
      testCaseId: state.testCaseId,
      input,
      error:
        getSpanErrorMessage(nestedSpan) ?? `Unknown error in trace ${traceId}`,
      reference: state.reference,
      traceIds: [traceId],
    };
  }

  const output = extractors.output(trace);
  const context = extractors.context(trace);
  const error = isModelAction ? getErrorFromModelResponse(output) : undefined;

  return {
    // TODO Replace this with unified trace class
    testCaseId: state.testCaseId,
    input,
    output,
    error,
    context: Array.isArray(context) ? context : [context],
    reference: state.reference,
    traceIds: [traceId],
  };
}

function getSpanErrorMessage(span: SpanData): string | undefined {
  if (span && span.status?.code === 2 /* SpanStatusCode.ERROR */) {
    // It's possible for a trace to have multiple exception events,
    // however we currently only expect and display the first one.
    const event = span.timeEvents?.timeEvent
      ?.filter((e) => e.annotation.description === 'exception')
      .shift();
    return (
      (event?.annotation?.attributes['exception.message'] as string) ?? 'Error'
    );
  }
}

function getErrorFromModelResponse(obj: any): string | undefined {
  const response = GenerateResponseSchema.parse(obj);

  // Legacy response is present
  const hasLegacyResponse =
    !!response.candidates && response.candidates.length > 0;
  // New (non-deprecated) response is present
  const hasNewResponse = !!response.message;

  if (!response || (!hasLegacyResponse && !hasNewResponse)) {
    return `No response was extracted from the output. '${JSON.stringify(obj)}'`;
  }

  if (hasLegacyResponse) {
    // We currently only support the first candidate
    const candidate = response.candidates![0] as CandidateData;
    if (candidate.finishReason === 'blocked') {
      return candidate.finishMessage || `Generation was blocked by the model.`;
    }
  }

  if (hasNewResponse) {
    if (response.finishReason === 'blocked') {
      return response.finishMessage || `Generation was blocked by the model.`;
    }
  }
}

function isSupportedActionRef(actionRef: string) {
  return SUPPORTED_ACTION_TYPES.some((supportedType) =>
    actionRef.startsWith(`/${supportedType}`)
  );
}
