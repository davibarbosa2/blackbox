import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { z } from "zod";

const lintReportSchema = z.object({
  diagnostics: z.array(
    z.object({
      code: z.string(),
      labels: z.array(
        z.object({
          span: z.object({ line: z.number() }),
        }),
      ),
    }),
  ),
});

const fixture = `type ObjectShadowed = object;
type UnknownShadowed = unknown;

function scope(): void {
  type LocalObject = object;
  type LocalObjectAlias = LocalObject;
  type LocalUnknown = unknown;
  type LocalUnknownAlias = LocalUnknown;
  type ObjectShadowed = string;
  type UnknownShadowed = string;

  function acceptsLocalObject(value: LocalObjectAlias): void {}
  function acceptsConcreteShadow(value: ObjectShadowed): void {}
  function returnsLocalUnknown(): LocalUnknownAlias {
    return "local";
  }
  function returnsConcreteShadow(): UnknownShadowed {
    return "concrete";
  }
}

type DirectUnknownUnion = string | unknown;
type ParenthesizedUnknownUnion = (string | unknown);
type TransitiveUnknownUnion = DirectUnknownUnion;
type CycleA = CycleB;
type CycleB = CycleA;
`;

describe("anti-slop plugin", () => {
  it("resolves local aliases, lexical shadowing, and unknown unions", () => {
    const directory = mkdtempSync(join(tmpdir(), "blackbox-anti-slop-"));

    try {
      const configPath = join(directory, ".oxlintrc.json");
      const fixturePath = join(directory, "fixture.ts");
      const pluginPath = join(
        process.cwd(),
        "tools",
        "oxlint",
        "anti-slop",
        "index.ts",
      );

      writeFileSync(
        configPath,
        JSON.stringify({
          jsPlugins: [{ name: "anti-slop", specifier: pluginPath }],
          rules: {
            "anti-slop/no-object-parameters": "error",
            "anti-slop/no-unknown-returns": "error",
            "anti-slop/no-unknown-type-aliases": "error",
          },
        }),
      );
      writeFileSync(fixturePath, fixture);

      const result = spawnSync(
        join(process.cwd(), "node_modules", ".bin", "oxlint"),
        ["--config", configPath, "--format", "json", fixturePath],
        { encoding: "utf8" },
      );

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);

      const report = lintReportSchema.parse(JSON.parse(result.stdout));
      const diagnostics = report.diagnostics
        .filter(({ code }) => code.startsWith("anti-slop("))
        .flatMap(({ code, labels }) => {
          const label = labels[0];
          return label === undefined ? [] : [`${code}:${label.span.line}`];
        })
        .sort();

      expect(diagnostics).toEqual([
        "anti-slop(no-object-parameters):12",
        "anti-slop(no-unknown-returns):14",
        "anti-slop(no-unknown-type-aliases):2",
        "anti-slop(no-unknown-type-aliases):22",
        "anti-slop(no-unknown-type-aliases):23",
        "anti-slop(no-unknown-type-aliases):24",
        "anti-slop(no-unknown-type-aliases):7",
        "anti-slop(no-unknown-type-aliases):8",
      ]);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
});
