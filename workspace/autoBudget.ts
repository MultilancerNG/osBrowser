/** Automatic RAM budget and Chromium JS heap for profiles the operator does not tune by hand.
 * The budget is this machine's memory shared across running profiles; a profile only counts
 * as over budget when it exceeds its share AND the machine itself is running low. */
import { freemem, totalmem } from "node:os";

export interface SystemMemory { totalMb: number; freeMb: number; }
export interface ResourceBudget { ramMb: number; heapMb: number; }

/** Fraction of physical memory the workspace may plan to use across all profiles. */
export const AUTO_MEMORY_SHARE = 0.7;
/** Below this free-memory fraction, a profile above its share pauses synchronization. */
export const AUTO_LOW_MEMORY_FRACTION = 0.12;
export const AUTO_LIMITS = Object.freeze({ minRamMb: 1536, maxRamMb: 8192, minHeapMb: 512, maxHeapMb: 2048 });

export function systemMemory(): SystemMemory {
  return { totalMb: Math.floor(totalmem() / 1048576), freeMb: Math.floor(freemem() / 1048576) };
}

const roundTo = (value: number, step: number) => Math.round(value / step) * step;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** activeProfiles = profiles that are (or are about to be) running, at least 1. */
export function autoBudget(system: SystemMemory, activeProfiles: number): ResourceBudget {
  const active = Math.max(1, Math.floor(activeProfiles) || 1);
  const share = (Math.max(0, system.totalMb) * AUTO_MEMORY_SHARE) / active;
  const ramMb = clamp(roundTo(share, 256), AUTO_LIMITS.minRamMb, AUTO_LIMITS.maxRamMb);
  const heapMb = Math.min(ramMb, clamp(roundTo(ramMb / 4, 128), AUTO_LIMITS.minHeapMb, AUTO_LIMITS.maxHeapMb));
  return { ramMb, heapMb };
}

export function autoOverBudget(memoryMb: number | null, system: SystemMemory, budget: ResourceBudget): boolean {
  if (memoryMb === null || !Number.isFinite(memoryMb)) return false;
  return memoryMb > budget.ramMb && system.freeMb < system.totalMb * AUTO_LOW_MEMORY_FRACTION;
}
