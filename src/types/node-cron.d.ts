declare module 'node-cron' {
  export interface ScheduledTask {
    start(): ScheduledTask;
    stop(): ScheduledTask;
    destroy(): boolean;
  }

  export interface ScheduleOptions {
    scheduled?: boolean;
    timezone?:  string;
  }

  export function schedule(
    expression: string,
    func:       () => void | Promise<void>,
    options?:   ScheduleOptions
  ): ScheduledTask;

  export function validate(expression: string): boolean;
}
