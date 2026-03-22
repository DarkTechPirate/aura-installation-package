import { Worker } from 'worker_threads';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import type { GatewayConfig } from '../config/loader.js';
import type { MemoryManager } from '../memory/manager.js';
import type { ChannelManager } from '../channels/manager.js';

export type HeartbeatFn    = () => Promise<void>;
export type WorkflowFireFn = (name: string) => Promise<void>;

const __dirname          = path.dirname(fileURLToPath(import.meta.url));
const WORKER_PATH        = path.resolve(__dirname, 'worker.mjs');
const PULSE_INTERVAL_SEC = parseInt(process.env.PULSE_INTERVAL_SEC ?? '30', 10);
const WF_DB_PATH         = path.join(os.homedir(), '.aura', 'memory', 'aura.db');

/** Returns true if the 5-field cron expression matches the given date (minute granularity). */
function matchesCron(expr: string, date: Date): boolean {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [min, hour, dom, mon, dow] = parts;

  const fieldMatch = (field: string | undefined, val: number): boolean => {
    if (!field || field === '*') return true;
    if (field.startsWith('*/')) {
      const step = parseInt(field.slice(2), 10);
      return step > 0 && val % step === 0;
    }
    return field.split(',').some(part => {
      if (part.includes('-')) {
        const [lo, hi] = part.split('-').map(Number);
        return val >= lo! && val <= hi!;
      }
      return parseInt(part, 10) === val;
    });
  };

  return fieldMatch(min, date.getMinutes()) &&
         fieldMatch(hour, date.getHours()) &&
         fieldMatch(dom, date.getDate()) &&
         fieldMatch(mon, date.getMonth() + 1) &&
         fieldMatch(dow, date.getDay());
}

import type { PulseRunner } from './pulse.js';

export class SchedulerEngine {
  private worker: Worker | null = null;

  constructor(
    private readonly config:          GatewayConfig,
    private readonly memory:          MemoryManager,
    private readonly channels:        ChannelManager,
    private readonly heartbeatFn:     HeartbeatFn,
    private readonly workflowFireFn?: WorkflowFireFn,
    private readonly pulseRunner?:    PulseRunner,
  ) {}

  start(): void {
    const intervalMin = this.config.scheduler.heartbeat_interval_min;
    const checkSec    = this.config.scheduler.reminder_check_sec;

    this.worker = new Worker(WORKER_PATH, {
      workerData: { intervalMin, checkSec, pulseIntervalSec: PULSE_INTERVAL_SEC },
    });

    this.worker.on('message', (msg: { type: string }) => {
      switch (msg.type) {
        case 'heartbeat':
          this.heartbeatFn().catch(err =>
            console.error('[Scheduler] Heartbeat error:', err));
          break;
        case 'reminder':
          this.checkReminders().catch(err =>
            console.error('[Scheduler] Reminder check error:', err));
          break;
        case 'workflow_schedule':
          if (this.workflowFireFn) {
            this.checkWorkflowSchedules().catch(err =>
              console.error('[Scheduler] Workflow schedule check error:', err));
          }
          break;
        case 'pulse':
          if (this.pulseRunner) {
            this.pulseRunner.check().catch(err =>
              console.error('[Scheduler] Pulse error:', err));
          }
          break;
      }
    });

    this.worker.on('error', err =>
      console.error('[Scheduler] Worker error:', err));

    this.worker.on('exit', code => {
      if (code !== 0) console.error(`[Scheduler] Worker exited with code ${code}`);
    });

    console.log(`[Scheduler] Started: heartbeat every ${intervalMin}m, reminders every ${checkSec}s, pulse every ${PULSE_INTERVAL_SEC}s`);
  }

  private async checkReminders(): Promise<void> {
    const now = new Date().toISOString();
    const due = await this.memory.getPendingReminders(now);
    for (const reminder of due) {
      console.log(`[Scheduler] Firing reminder #${reminder.id}: "${reminder.text}" → ${reminder.target_node}`);
      try {
        await this.channels.send(reminder.target_node, `⏰ Reminder: ${reminder.text}`);
        await this.memory.markReminderFired(reminder.id);
      } catch (err) {
        console.error('[Scheduler] Failed to send reminder:', err);
      }
    }
  }

  private async checkWorkflowSchedules(): Promise<void> {
    if (!fs.existsSync(WF_DB_PATH)) return;
    let db: InstanceType<typeof Database> | null = null;
    try {
      db = new Database(WF_DB_PATH);
      const hasTable = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='wf_scheduled'`).get();
      if (!hasTable) return;

      const now       = new Date();
      const minuteKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`;
      const schedules = db.prepare(`SELECT workflow_name, cron, last_run FROM wf_scheduled WHERE enabled=1`).all() as Array<{ workflow_name: string; cron: string; last_run: string | null }>;

      for (const row of schedules) {
        if (!matchesCron(row.cron, now)) continue;
        if (row.last_run) {
          const last    = new Date(row.last_run);
          const lastKey = `${last.getFullYear()}-${last.getMonth()}-${last.getDate()}-${last.getHours()}-${last.getMinutes()}`;
          if (lastKey === minuteKey) continue;
        }
        console.log(`[Scheduler] Firing scheduled workflow: ${row.workflow_name} (${row.cron})`);
        db.prepare(`UPDATE wf_scheduled SET last_run=? WHERE workflow_name=?`).run(now.toISOString(), row.workflow_name);
        this.workflowFireFn!(row.workflow_name).catch(err =>
          console.error(`[Scheduler] Failed to fire workflow ${row.workflow_name}:`, err));
      }
    } finally {
      db?.close();
    }
  }

  stop(): void {
    this.worker?.terminate();
    this.worker = null;
    console.log('[Scheduler] Stopped');
  }
}
