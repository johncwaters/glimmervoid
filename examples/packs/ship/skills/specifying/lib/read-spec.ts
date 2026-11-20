import fs from "node:fs";
import { validateGraph } from "./graph.ts";
import type { DesignSpec } from "./graph.ts";

export type ValidationReport = {
  outcome: "VALID" | "INVALID" | "UNREADABLE";
  status?: DesignSpec["status"];
  errors: string[];
};

export function readSpec(filePath: string | undefined): { report: ValidationReport; spec?: DesignSpec } {
  try {
    if (!filePath) throw new Error("supply the spec.json path");
    const parsedSpec: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const errors = validateGraph(parsedSpec);
    const candidate = parsedSpec as Partial<DesignSpec> | null;
    const status = candidate?.status;
    const report: ValidationReport = { outcome: errors.length === 0 ? "VALID" : "INVALID", errors };
    if (status && ["sketch", "grilled", "sliced", "challenged"].includes(status)) report.status = status;
    if (errors.length > 0) return { report };
    return { report, spec: parsedSpec as DesignSpec };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { report: { outcome: "UNREADABLE", errors: [`Rule 1: spec ${filePath ?? "path"}: ${reason}; supply readable JSON and readable budget paths`.replace(/[\r\n]+/g, " ")] } };
  }
}
