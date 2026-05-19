import type { BenchmarkCase, SystemCaseDef } from "@/lib/benchmark/types";
import { retrievalCases } from "@/lib/benchmark/cases/retrieval";
import { contextCases } from "@/lib/benchmark/cases/context";
import { planningCases } from "@/lib/benchmark/cases/planning";
import { safetyCases } from "@/lib/benchmark/cases/safety";
import { behavioralCases } from "@/lib/benchmark/cases/behavioral";
import { adversarialCases } from "@/lib/benchmark/cases/adversarial";

function tagSystem(cases: SystemCaseDef[]): BenchmarkCase[] {
  return cases.map((c) => ({ ...c, layer: "system" as const }));
}

export const systemCases: BenchmarkCase[] = [
  ...tagSystem(retrievalCases),
  ...tagSystem(contextCases),
  ...tagSystem(planningCases),
  ...tagSystem(safetyCases),
];

export const intelligenceCases: BenchmarkCase[] = [
  ...behavioralCases,
  ...adversarialCases,
];

export const allCases: BenchmarkCase[] = [...systemCases, ...intelligenceCases];
