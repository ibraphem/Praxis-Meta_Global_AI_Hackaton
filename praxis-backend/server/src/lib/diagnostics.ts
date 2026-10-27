import { performance } from 'node:perf_hooks';

export const stages = [
  'upload',
  'image.prepare',
  'sam.breadboard',
  'sam.led',
  'sam.resistor',
  'sam.jumper_wire',
  'sam.wire_refine',
  'wire.geometry',
  'muse.interpret',
  'muse.detect',
  'response.validate',
] as const;
export type Stage = (typeof stages)[number];
export type TimingStatus =
  'running' | 'completed' | 'failed' | 'timed_out' | 'cancelled';
export interface StageTiming {
  stage: Stage;
  startedAtMs: number;
  durationMs: number;
  status: TimingStatus;
  kind: 'work' | 'request' | 'retry_delay';
  model?: string;
  attempt?: number;
  timeoutMs?: number;
  code?: string;
  upstreamStatus?: number;
}
export interface ErrorDetails {
  source:
    'backend' | 'backend_provider' | 'backend_analysis' | 'meta_api' | 'client';
  stage?: Stage;
  phase?: 'awaiting_response' | 'reading_response';
  model?: string;
  attempt?: number;
  timeoutMs?: number;
  elapsedMs: number;
  totalElapsedMs?: number;
  upstreamStatus?: number;
  activeStages?: Stage[];
  timings?: StageTiming[];
}
export interface Diagnostics {
  requestId: string;
  elapsedMs: number;
  timings: StageTiming[];
}
export type TraceEvent = { event: string; requestId: string } & Record<
  string,
  unknown
>;
export type TraceLogger = (event: TraceEvent) => void;
export const logTrace: TraceLogger = (event) =>
  console.info(JSON.stringify(event));

/** Request-scoped monotonic timings. Only fixed stage names and safe metadata are logged. */
export class AnalysisTrace {
  private readonly started = performance.now();
  private readonly spans: { timing: StageTiming; start: number }[] = [];
  constructor(
    readonly requestId: string,
    private readonly logger: TraceLogger = () => undefined,
  ) {}

  get elapsedMs() {
    return Math.round(performance.now() - this.started);
  }
  emit(event: string, fields: Record<string, unknown> = {}) {
    this.logger({ ...fields, event, requestId: this.requestId });
  }

  begin(
    stage: Stage,
    metadata: Partial<
      Pick<StageTiming, 'model' | 'attempt' | 'timeoutMs' | 'kind'>
    > = {},
  ) {
    const start = performance.now();
    const timing: StageTiming = {
      stage,
      startedAtMs: this.elapsedMs,
      durationMs: 0,
      status: 'running',
      kind: 'work',
      ...metadata,
    };
    this.spans.push({ timing, start });
    this.emit('vision.stage_started', { ...timing });
    return (
      status: Exclude<TimingStatus, 'running'>,
      extra: Pick<StageTiming, 'code' | 'upstreamStatus'> = {},
    ) => {
      if (timing.status !== 'running') return;
      Object.assign(timing, extra, {
        status,
        durationMs: Math.round(performance.now() - start),
      });
      this.emit('vision.stage_finished', { ...timing });
    };
  }

  snapshot(): Diagnostics {
    return {
      requestId: this.requestId,
      elapsedMs: this.elapsedMs,
      timings: this.spans.map(({ timing, start }) => ({
        ...timing,
        durationMs:
          timing.status === 'running'
            ? Math.round(performance.now() - start)
            : timing.durationMs,
      })),
    };
  }
  activeStages(): Stage[] {
    return this.spans
      .filter(({ timing }) => timing.status === 'running')
      .map(({ timing }) => timing.stage);
  }
}
