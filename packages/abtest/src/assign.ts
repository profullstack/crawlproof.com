// Deterministic, sticky arm assignment. The same (experiment, unit) always lands in
// the same arm, on the server and in any client, so a client that cannot reach the
// server falls back to the identical answer instead of a random one.

export type ArmSpec = string | { key: string; weight?: number };

/** cyrb53: a fast 53-bit string hash with good avalanche; pure JS, no crypto needed. */
export function hash53(str: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** A number in [0, 1) fixed by (experiment, unit). */
export function bucket(experiment: string, unit: string): number {
  return hash53(`${experiment}\u0000${unit}`) / 2 ** 53;
}

export function normalizeArms(arms: ArmSpec[]): Array<{ key: string; weight: number }> {
  const out = arms.map((a) => (typeof a === "string" ? { key: a, weight: 1 } : { key: a.key, weight: a.weight ?? 1 }));
  if (out.length < 2) throw new Error("an experiment needs at least two arms");
  const seen = new Set<string>();
  for (const a of out) {
    if (!a.key || typeof a.key !== "string") throw new Error("every arm needs a key");
    if (seen.has(a.key)) throw new Error(`duplicate arm ${a.key}`);
    seen.add(a.key);
    if (!(a.weight > 0) || !Number.isFinite(a.weight)) throw new Error(`arm ${a.key} needs a positive weight`);
  }
  return out;
}

/** The arm (by key) for this unit, honouring weights. */
export function assignArm(experiment: string, unit: string, arms: ArmSpec[]): string {
  const list = normalizeArms(arms);
  const total = list.reduce((s, a) => s + a.weight, 0);
  let x = bucket(experiment, unit) * total;
  for (const a of list) {
    if (x < a.weight) return a.key;
    x -= a.weight;
  }
  return list[list.length - 1].key;
}
