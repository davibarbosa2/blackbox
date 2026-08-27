import { createLogger, initLogger } from "evlog";
import { createFsDrain } from "evlog/fs";
import { evlog } from "evlog/hono";
import { z } from "zod";

import type { EvidenceBundle } from "../evidence/ledger.js";

export interface BaselineRunObservation {
  completed(bundle: EvidenceBundle): void;
  failed(error: Error, stage: string): void;
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
        failed(error, stage): void {
          const safeError = sanitizeError(error, options.secrets);
          const statusCode = httpStatus(error, safeError.message);
          const retryable =
            statusCode === 429 ||
            (statusCode !== undefined && statusCode >= 500);
          if (statusCode === undefined) {
            log.error(safeError, { retryable, stage });
          } else {
            log.error(safeError, { retryable, stage, statusCode });
          }
        },
      };
    },
  };
}

function sanitizeError(error: Error, secrets: readonly string[]): Error {
  let message = error.message.replace(
    /BLACKBOX-CANARY-[A-Za-z0-9._:-]+/g,
    "[REDACTED]",
  );
  for (const secret of secrets) {
    if (secret.length === 0) continue;
    message = message.replace(
      new RegExp(escapeRegExp(secret), "g"),
      "[REDACTED]",
    );
  }
  const sanitized = new Error(message);
  sanitized.name = error.name;
  return sanitized;
}

const errorStatusSchema = z.object({
  status: z.number().int().min(100).max(599).optional(),
  statusCode: z.number().int().min(100).max(599).optional(),
});

function httpStatus(error: Error, message: string): number | undefined {
  const parsed = errorStatusSchema.safeParse(error);
  if (parsed.success) {
    const status = parsed.data.status ?? parsed.data.statusCode;
    if (status !== undefined) return status;
  }
  const matched = /(?:HTTP\s+|\()([1-5]\d{2})\)?/.exec(message);
  return matched?.[1] === undefined ? undefined : Number(matched[1]);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
