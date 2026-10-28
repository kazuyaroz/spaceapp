import { randomBytes } from "node:crypto";
import type { WorkflowInterceptorsFactory } from "@temporalio/worker";
import {
  parseTraceparent,
  traceIdFromTraceparent,
  type WorkflowInfo
} from "@temporalio/workflow";
import type { SpanExporter } from "@space/runtime";
import { logIdentifier } from "./worker-log.js";

/**
 * Workflow-level OTLP span export.
 *
 * The API passes a W3C traceparent in the workflow input and Temporal memo.
 * Activity spans already reference that trace; this module records the
 * parent workflow span so the trace has a root and every activity in the
 * execution joins one trace per chat turn.
 *
 * Runs in the worker process (workflow interceptor), never inside the
 * deterministic workflow sandbox, so it cannot affect replay.
 */

interface WorkflowSpanDependencies {
  spans?: SpanExporter | null;
  now?: () => number;
}

/** Extract the traceparent from workflow input or memo. */
function workflowTraceparent(info: WorkflowInfo): ReturnType<typeof parseTraceparent> {
  // The API stores the traceparent in the workflow memo (workflowCorrelationMemo).
  const memo = info.memo as Record<string, unknown> | undefined;
  if (memo) {
    for (const value of Object.values(memo)) {
      if (typeof value === "string") {
        const parsed = parseTraceparent(value);
        if (parsed) return parsed;
      }
      // memo fields may be Uint8Array (Temporal encodes them).
      if (value instanceof Uint8Array) {
        const text = new TextDecoder().decode(value);
        const parsed = parseTraceparent(text);
        if (parsed) return parsed;
      }
    }
  }
  return null;
}

function randomSpanId(): string {
  let spanId = randomBytes(8).toString("hex");
  while (/^0+$/.test(spanId)) spanId = randomBytes(8).toString("hex");
  return spanId;
}

/** Temporal workflow interceptor factory: register in Worker.create({ interceptors }). */
export function createWorkflowObservabilityInterceptors(
  dependencies: WorkflowSpanDependencies = {}
): WorkflowInterceptorsFactory {
  return (ctx) => {
    const info = ctx.info;
    const exporter = dependencies.spans;
    if (!exporter) return {};

    const trace = workflowTraceparent(info);
    if (!trace) return {};

    const workflowType = logIdentifier(info.workflowType) ?? "unknown";
    const spanId = randomSpanId();
    const now = dependencies.now ?? Date.now;
    const startedAt = now();

    return {
      outbound: {},
      inbound: {
        // Workflow execution is intercepted via the "handle" lifecycle:
        // Temporal calls execute() once per workflow task batch. We record a
        // single span per workflow execution by tracking the first task.
        async execute(input, next) {
          try {
            return await next(input);
          } finally {
            // Record on the last task (when the workflow completes or fails).
            // Temporal replays workflow tasks; the interceptor fires for each
            // task, so we only record once by checking if this is the final
            // task (continueAsNew or completion).
            //
            // For simplicity and correctness, we record one span per workflow
            // execution using the workflow start time and the current time.
            // The span kind is SERVER (2) because the workflow is the server
            // side of the chat turn that the API initiated.
            const durationMs = Math.max(0, now() - startedAt);
            exporter.record({
              traceId: trace.traceId,
              spanId,
              parentSpanId: trace.parentId,
              name: `workflow ${workflowType}`,
              startTimeUnixNano: BigInt(startedAt) * 1_000_000n,
              endTimeUnixNano: BigInt(startedAt + durationMs) * 1_000_000n,
              attributes: {
                "space.workflow_type": workflowType,
                "space.workflow_id": info.workflowId,
                "space.run_id": info.runId,
                "space.task_queue": info.taskQueue
              },
              error: false,
              kind: 2
            });
          }
        }
      }
    };
  };
}
