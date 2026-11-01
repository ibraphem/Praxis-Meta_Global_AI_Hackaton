import { createHash } from 'node:crypto';
import type { JobStore } from './store.js';
import type { ProviderOperation } from '../lib/meta-client.js';

export const sha256 = (bytes: string | Buffer) =>
  createHash('sha256').update(bytes).digest('hex');
export interface SceneRequestEvidence {
  requestId: string;
  analysisId: string;
  objectId: string;
  experimentId?: string;
  variant?: string;
  inputSnapshotId: string;
  inputSnapshotHash: string;
  imageHash: string;
  crop: [number, number, number, number];
  prompt: string;
  cropImage: {
    mimeType: 'image/jpeg';
    sha256: string;
    base64: string;
    bytes: number;
  };
  createdAt: number;
  dispatchStartedAt?: number;
  request?: { path: 'responses'; payload: string; sha256: string };
  response?: {
    upstreamStatus: number;
    contentType: string | null;
    providerRequestId?: string;
    truncated: boolean;
    base64: string;
    sha256: string;
    bytes: number;
    receivedAt: number;
  };
  decoded?: {
    candidateCount: number;
    candidates: unknown[];
    previewUnavailable: string[];
    outcome:
      'empty_output' | 'candidates_returned' | 'candidate_limit_rejected';
  };
  failureCode?: string;
  failurePhase?: string;
}

/** Private payloads are separate from public job JSON and immutable scene checkpoints. */
export class SceneRequestRecorder {
  constructor(
    private readonly store: JobStore,
    readonly record: SceneRequestEvidence,
    private readonly transition?: (
      phase: 'dispatching' | 'response_recorded',
    ) => void,
  ) {
    store.db
      .prepare('INSERT INTO scene_requests VALUES (?,?,?)')
      .run(record.requestId, record.analysisId, JSON.stringify(record));
  }
  private save() {
    this.store.db
      .prepare('UPDATE scene_requests SET data=? WHERE id=?')
      .run(JSON.stringify(this.record), this.record.requestId);
  }
  private change(
    phase: 'dispatching' | 'response_recorded',
    update: () => void,
  ) {
    const previous = structuredClone(this.record);
    try {
      this.store.transaction(() => {
        update();
        this.save();
        this.transition?.(phase);
      });
    } catch (error) {
      // Failed transactions must not leak uncommitted intent/body fields through failed().
      for (const key of Object.keys(this.record))
        delete (this.record as unknown as Record<string, unknown>)[key];
      Object.assign(this.record, previous);
      throw error;
    }
  }
  readonly transport: NonNullable<ProviderOperation['evidence']> = {
    request: (payload) => {
      if (this.record.request)
        throw new Error('Scene request evidence cannot be dispatched twice.');
      this.change('dispatching', () => {
        this.record.request = {
          path: 'responses',
          payload,
          sha256: sha256(payload),
        };
        this.record.dispatchStartedAt = Date.now();
      });
    },
    response: ({ bytes, ...metadata }) => {
      this.change('response_recorded', () => {
        this.record.response = {
          ...metadata,
          base64: bytes.toString('base64'),
          sha256: sha256(bytes),
          bytes: bytes.length,
          receivedAt: Date.now(),
        };
      });
    },
  };
  decoded(value: NonNullable<SceneRequestEvidence['decoded']>) {
    this.record.decoded = value;
    this.save();
  }
  failed(code: string, phase: string) {
    this.record.failureCode = code;
    this.record.failurePhase = phase;
    this.save();
  }
}
export function sceneRequestEvidence(
  store: JobStore,
  analysisId: string,
): SceneRequestEvidence[] {
  return store.db
    .prepare(
      'SELECT data FROM scene_requests WHERE analysis_id=? ORDER BY rowid',
    )
    .all(analysisId)
    .map((r) => JSON.parse(r.data as string) as SceneRequestEvidence);
}
