import type { BenchmarkCase } from "@/lib/benchmark/types";
import { retrievalCases } from "@/lib/benchmark/cases/retrieval";
import { contextCases } from "@/lib/benchmark/cases/context";
import { planningCases } from "@/lib/benchmark/cases/planning";
import { safetyCases } from "@/lib/benchmark/cases/safety";

export const allCases: BenchmarkCase[] = [
  ...retrievalCases,
  ...contextCases,
  ...planningCases,
  ...safetyCases,
];
