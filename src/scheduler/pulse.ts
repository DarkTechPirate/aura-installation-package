/**
 * Pulse — extensible high-frequency monitoring framework.
 *
 * Pure code, zero LLM per tick. Runs registered PulseMonitor modules every N
 * seconds. When a monitor returns alert strings, they are delivered via
 * AlertTemplate (which adds context + LLM delivery).
 *
 * To add a new monitor:
 *   1. Implement PulseMonitor in src/scheduler/monitors/
 *   2. Register it: pulse.register(new MyMonitor())
 *   3. Done — scheduling, alerting, and error isolation are handled here.
 */

import type { SkillsEngine }  from '../skills/engine.js';
import type { AlertTemplate } from './alert_template.js';
import { createLogger }       from '../logger.js';

const logger = createLogger('Pulse');

// ── Alert object — domain-agnostic ────────────────────────────────────────────

export interface Alert {
  /** The trigger text delivered as the LLM user message */
  text:      string;
  /**
   * Optional context block injected into the LLM system prompt.
   * Each monitor builds its own — could be trade data, calendar events,
   * system metrics, weather, anything. AlertTemplate is unaware of the domain.
   */
  context?:  string;
}

// ── Monitor interface ─────────────────────────────────────────────────────────

export interface PulseMonitor {
  /** Unique name used in log output */
  readonly name: string;
  /**
   * Run one check cycle. Return Alert objects for any conditions that fired.
   * Return empty array if nothing to report. Must not throw — handle errors internally.
   */
  check(skills: SkillsEngine): Promise<Alert[]>;
}

// ── Cooldown helper — shareable across monitors ───────────────────────────────

export class Cooldown {
  private readonly map = new Map<string, number>();

  /**
   * Returns true (and records the timestamp) if the key has not fired
   * within the given cooldown window. Returns false if still cooling down.
   */
  allow(key: string, minutes: number): boolean {
    const now  = Date.now();
    const last = this.map.get(key) ?? 0;
    if (now - last >= minutes * 60_000) {
      this.map.set(key, now);
      return true;
    }
    return false;
  }

  /** Clear cooldown for a key (e.g. after a trade closes). */
  clear(key: string): void {
    this.map.delete(key);
  }
}

// ── Pulse runner ──────────────────────────────────────────────────────────────

export class PulseRunner {
  private readonly monitors: PulseMonitor[] = [];

  constructor(
    private readonly skills:        SkillsEngine,
    private readonly alertTemplate: AlertTemplate,
  ) {}

  /** Register a monitor module into the pulse cycle. Chainable. */
  register(monitor: PulseMonitor): this {
    this.monitors.push(monitor);
    logger.info('Pulse monitor registered', { name: monitor.name });
    return this;
  }

  /** Run one full pulse tick — called by the scheduler every N seconds. */
  async check(): Promise<void> {
    for (const monitor of this.monitors) {
      try {
        const alerts = await monitor.check(this.skills);
        for (const alert of alerts) {
          logger.info('Pulse alert', { monitor: monitor.name, text: alert.text.slice(0, 100) });
          await this.alertTemplate.fire(alert);
        }
      } catch (err) {
        logger.error('Pulse monitor error', {
          monitor: monitor.name,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}
