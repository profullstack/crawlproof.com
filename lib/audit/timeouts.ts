import type { Engine } from "../credits";

const MINUTE_MS = 60 * 1000;

export const DEFAULT_AUDIT_STUCK_AFTER_MS = 7 * MINUTE_MS;
export const CLAUDE_AUDIT_STUCK_AFTER_MS = 15 * MINUTE_MS;

const ENGINE_STUCK_AFTER_MS: Partial<Record<Engine, number>> = {
  claude: CLAUDE_AUDIT_STUCK_AFTER_MS,
};

export function auditStuckAfterMs(engine: string | null | undefined): number {
  return ENGINE_STUCK_AFTER_MS[engine as Engine] ?? DEFAULT_AUDIT_STUCK_AFTER_MS;
}

export function auditStuckAfterMinutes(engine: string | null | undefined): number {
  return Math.round(auditStuckAfterMs(engine) / MINUTE_MS);
}
