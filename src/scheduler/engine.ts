import cron from 'node-cron';
import fs from 'fs';
import path from 'path';
import os from 'os';
import Database from 'better-sqlite3';
import type { GatewayConfig } from '../config/loader.js';
import type { MemoryManager } from '../memory/manager.js';
import type { ChannelManager } from '../channels/manager.js';

export type HeartbeatFn = () => Promise<void>;
export type WorkflowFireFn = (name: string) => Promise<void>;

const WF_DB_PATH = path.join(os.homedir(), '.aura', 'memory', 'aura.db');

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

/**
 * Scheduler engine: manages cron-based heartbeat and reminder polling.
 * - Heartbeat: runs every N minutes (from config), calls heartbeatFn
 * - Reminder poll: runs every reminder_check_sec seconds, fires due reminders
 */
export class SchedulerEngine {
  private heartbeatTask: cron.ScheduledTask | null = null;
  private reminderTask:  cron.ScheduledTask | null = null;
  private wfScheduleTask: cron.ScheduledTask | null = null;

  constructor(
    private readonly config: GatewayConfig,
    private readonly memory: MemoryManager,
    private readonly channels: ChannelManager,
    private readonly heartbeatFn: HeartbeatFn,
    private readonly workflowFireFn?: WorkflowFireFn,
  ) {}

  start(): void {
    const intervalMin = this.config.scheduler.heartbeat_interval_min;
    const checkSec    = this.config.scheduler.reminder_check_sec;

    // Heartbeat cron: every N minutes
    const heartbeatCron = `*/${intervalMin} * * * *`;
    this.heartbeatTask = cron.schedule(heartbeatCron, async () => {
      try {
        await this.heartbeatFn();
      } catch (err) {
        console.error('[Scheduler] Heartbeat error:', err);
      }
    });

    // Reminder polling: every checkSec seconds
    const reminderCron = `*/${checkSec} * * * * *`;
    this.reminderTask = cron.schedule(reminderCron, async () => {
      try {
        await this.checkReminders();
      } catch (err) {
        console.error('[Scheduler] Reminder check error:', err);
      }
    });

    // Workflow schedule polling: every minute at :00s
    if (this.workflowFireFn) {
      this.wfScheduleTask = cron.schedule('* * * * *', async () => {
        try {
          await this.checkWorkflowSchedules();
        } catch (err) {
          console.error('[Scheduler] Workflow schedule check error:', err);
        }
      });
    }

    console.log(`[Scheduler] Started: heartbeat every ${intervalMin}m, reminders every ${checkSec}s`);
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

      const now = new Date();
      // Round to the current minute boundary for double-fire prevention
      const minuteKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`;

      const schedules = db.prepare(`SELECT workflow_name, cron, last_run FROM wf_scheduled WHERE enabled=1`).all() as Array<{ workflow_name: string; cron: string; last_run: string | null }>;

      for (const row of schedules) {
        if (!matchesCron(row.cron, now)) continue;

        // Prevent double-fire: skip if last_run is within the current minute
        if (row.last_run) {
          const last = new Date(row.last_run);
          const lastKey = `${last.getFullYear()}-${last.getMonth()}-${last.getDate()}-${last.getHours()}-${last.getMinutes()}`;
          if (lastKey === minuteKey) continue;
        }

        console.log(`[Scheduler] Firing scheduled workflow: ${row.workflow_name} (${row.cron})`);
        db.prepare(`UPDATE wf_scheduled SET last_run=? WHERE workflow_name=?`).run(now.toISOString(), row.workflow_name);

        this.workflowFireFn!(row.workflow_name).catch(err =>
          console.error(`[Scheduler] Failed to fire workflow ${row.workflow_name}:`, err)
        );
      }
    } finally {
      db?.close();
    }
  }

  stop(): void {
    this.heartbeatTask?.stop();
    this.reminderTask?.stop();
    this.wfScheduleTask?.stop();
    this.heartbeatTask  = null;
    this.reminderTask   = null;
    this.wfScheduleTask = null;
    console.log('[Scheduler] Stopped');
  }
}
