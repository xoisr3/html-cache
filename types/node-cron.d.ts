declare module 'node-cron' {
  export interface ScheduledTask {
    stop(): void;
  }

  export interface NodeCron {
    schedule(expression: string, task: () => void): ScheduledTask;
  }

  const cron: NodeCron;
  export default cron;
}
