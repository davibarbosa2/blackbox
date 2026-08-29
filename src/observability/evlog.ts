import { createLogger, initLogger } from "evlog";
import { createFsDrain } from "evlog/fs";
import { evlog } from "evlog/hono";

import type { BaselineEvidenceBundle } from "../evidence/ledger.js";
import type { BaselineFailureStage, SafeFailure } from "../failure.js";

export interface BaselineRunObservation {
  completed(bundle: BaselineEvidenceBundle): void;
  failed(failure: SafeFailure, stage: BaselineFailureStage): void;
  finalizationFailed(): void;
}

export interface BaselineRunObservationContext {
  incidentId: string;
  modelAlias: string;
  modelId: string;
  runId: string;
}

export interface BlackboxObservability {
  flush(): Promise<void>;
  httpMiddleware: ReturnType<typeof evlog>;
  observeBaselineRun(
    context: BaselineRunObservationContext,
  ): BaselineRunObservation;
}

interface BlackboxObservabilityOptions {
  enabled?: boolean;
  logDirectory?: string;
  secrets: readonly string[];
  silent?: boolean;
}

export function createBlackboxObservability(
  options: BlackboxObservabilityOptions,
): BlackboxObservability {
  const pending = new Set<Promise<void>>();
  const fileDrain = createFsDrain({
    dir: options.logDirectory ?? ".evlog/logs",
    maxFiles: 7,
    maxSizePerFile: 5 * 1_024 * 1_024,
    pretty: false,
  });
  initLogger({
    drain(context) {
      const write = Promise.resolve(fileDrain(context));
      pending.add(write);
      void write.then(
        () => pending.delete(write),
        () => pending.delete(write),
      );
      return write;
    },
    enabled: options.enabled ?? process.env.NODE_ENV !== "test",
    env: { service: "blackbox" },
    pretty: false,
    redact: {
      builtins: ["bearer", "creditCard", "email", "iban", "jwt", "phone"],
      paths: [
        "authorization",
        "**.authorization",
        "apiKey",
        "**.apiKey",
        "canarySecret",
        "**.canarySecret",
        "payload",
        "**.payload",
        "prompt",
        "**.prompt",
        "toolInput",
        "toolOutput",
      ],
      patterns: [
        /BLACKBOX-CANARY-[A-Za-z0-9._:-]+/g,
        ...options.secrets
          .filter((secret) => secret.length > 0)
          .map((secret) => new RegExp(escapeRegExp(secret), "g")),
      ],
    },
    silent: options.silent ?? false,
  });

  return {
    async flush(): Promise<void> {
      await Promise.allSettled(pending);
    },
    httpMiddleware: evlog({
      exclude: ["/healthz", "/api/runs/**/evidence"],
    }),
    observeBaselineRun({ incidentId, modelAlias, modelId, runId }) {
      const log = createLogger({
        action: "baseline.run",
        incidentId,
        modelAlias,
        modelId,
        provider: "openrouter",
        runId,
      });
      return {
        completed(bundle): void {
          log.set({
            bundleHash: bundle.bundleHash,
            complete: bundle.completeness.complete,
            evidenceCount: bundle.timeline.length,
            missingEvidence: bundle.completeness.missing,
            verdict: bundle.verdict,
          });
          log.emit();
        },
        failed(failure, stage): void {
          const error = new Error(failure.message);
          if (failure.statusCode === undefined) {
            log.error(error, { retryable: failure.retryable, stage });
          } else {
            log.error(error, {
              retryable: failure.retryable,
              stage,
              statusCode: failure.statusCode,
            });
          }
        },
        finalizationFailed(): void {
          log.error(new Error("Evidence finalization failed"), {
            retryable: false,
            stage: "evidence-finalization",
          });
          log.set({ complete: false, verdict: "INCONCLUSIVE" });
          log.emit();
        },
      };
    },
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
