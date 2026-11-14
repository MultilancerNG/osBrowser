import { describe, expect, test } from "bun:test";
import { AUTO_LIMITS, autoBudget, autoOverBudget } from "./autoBudget.ts";
import { normalizeWorkspacePolicy } from "./profileStore.ts";

const pc32 = { totalMb: 32768, freeMb: 12000 };
describe("automatic resource budgets", () => {
  test("shares 70% of memory across running profiles within limits", () => {
    expect(autoBudget(pc32, 1)).toEqual({ ramMb: 8192, heapMb: 2048 });
    expect(autoBudget(pc32, 4)).toEqual({ ramMb: 5632, heapMb: 1408 });
    expect(autoBudget(pc32, 12)).toEqual({ ramMb: 1792, heapMb: 512 });
    expect(autoBudget(pc32, 100).ramMb).toBe(AUTO_LIMITS.minRamMb);
    expect(autoBudget({ totalMb: 8192, freeMb: 2000 }, 0)).toEqual({ ramMb: 5632, heapMb: 1408 });
  });
  test("heap never exceeds the RAM budget", () => {
    for (const count of [1, 2, 3, 5, 8, 16, 64]) { const b = autoBudget(pc32, count); expect(b.heapMb).toBeLessThanOrEqual(b.ramMb); }
  });
  test("over budget only when above its share and the PC is low on memory", () => {
    const budget = autoBudget(pc32, 4);
    expect(autoOverBudget(budget.ramMb + 500, pc32, budget)).toBe(false);
    expect(autoOverBudget(budget.ramMb + 500, { totalMb: 32768, freeMb: 2000 }, budget)).toBe(true);
    expect(autoOverBudget(budget.ramMb - 1, { totalMb: 32768, freeMb: 100 }, budget)).toBe(false);
    expect(autoOverBudget(null, { totalMb: 32768, freeMb: 100 }, budget)).toBe(false);
  });
  test("policy keeps the automatic flag and rejects non-boolean values", () => {
    expect(normalizeWorkspacePolicy({ autoResources: true }).autoResources).toBe(true);
    expect(normalizeWorkspacePolicy({ autoResources: false }).autoResources).toBeUndefined();
    expect(() => normalizeWorkspacePolicy({ autoResources: "yes" as any })).toThrow();
  });
});
