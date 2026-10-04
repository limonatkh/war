import type { Composition, UnitDef, UnitTypeId } from './types';

// Four unit types, each with a clear job (kept deliberately small for the prototype).
export const UNIT_DEFS: Record<UnitTypeId, UnitDef> = {
  infantry: {
    id: 'infantry', name: 'Infantry', role: 'All-rounder. Backbone of the army.',
    cost: 10, hp: 100, speed: 4.2, damage: 12, range: 30, cooldown: 0.45, spread: 0.035,
    mag: 30, reload: 1.8, vision: 22, scale: 1,
  },
  heavy: {
    id: 'heavy', name: 'Heavy', role: 'Slow tank with a big health pool. Holds points.',
    cost: 22, hp: 230, speed: 2.9, damage: 16, range: 26, cooldown: 0.6, spread: 0.045,
    mag: 50, reload: 2.6, vision: 20, scale: 1.2,
  },
  scout: {
    id: 'scout', name: 'Scout', role: 'Fast and fragile. Long vision, great for flanking.',
    cost: 8, hp: 60, speed: 6.6, damage: 8, range: 24, cooldown: 0.3, spread: 0.05,
    mag: 20, reload: 1.4, vision: 34, scale: 0.9,
  },
  ranged: {
    id: 'ranged', name: 'Ranged', role: 'Marksman. Slow shots, long range, punishes open ground.',
    cost: 16, hp: 70, speed: 3.6, damage: 34, range: 48, cooldown: 1.4, spread: 0.012,
    mag: 5, reload: 2.2, vision: 26, scale: 1,
  },
};

export const DEFAULT_BUDGET = 240;

export const DEFAULT_COMPOSITION: Composition = { infantry: 10, heavy: 3, scout: 3, ranged: 3 };

export function compositionCost(c: Composition): number {
  let total = 0;
  for (const k of Object.keys(UNIT_DEFS) as UnitTypeId[]) total += (c[k] ?? 0) * UNIT_DEFS[k].cost;
  return total;
}

export function compositionCount(c: Composition): number {
  return (Object.keys(UNIT_DEFS) as UnitTypeId[]).reduce((n, k) => n + (c[k] ?? 0), 0);
}
