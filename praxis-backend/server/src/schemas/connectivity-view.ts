import type { CircuitInput } from './connectivity.js';
import type {
  ElectricalGraph,
  ConnectivityComparison,
  validateCircuitReference,
} from '../services/connectivity.js';
export interface ConnectivityEvent {
  id: string;
  action: string;
  reviewer: string;
  reason: string;
  timestamp: number;
  baseRevision: number;
  revision: number;
  payload: unknown;
  inputHash: string;
  previousValue: unknown;
  sourceBindings: {
    imageHash: string;
    analysisRevision: string;
    sceneSnapshotHash: string | null;
    perceptionHash: string;
    samSnapshotHash: string | null;
  };
}
export interface ConnectivitySource {
  input: CircuitInput;
  workspace: unknown;
  sourceSceneHash: string | null;
  sourceAnalysisRevision: string;
  sourcePerceptionHash: string;
  physicalHints?: unknown;
}
export interface ConnectivityView {
  schemaVersion: 'praxis-connectivity-view-v1';
  analysisId: string;
  imageHash: string;
  source: ConnectivitySource | null;
  history: ConnectivityEvent[];
  graph: {
    graph: ElectricalGraph;
    inputHash: string;
    sourceRevision: number;
    builtAt: number;
  } | null;
  graphStale: boolean;
  references: Array<{
    id: string;
    reference: ReturnType<typeof validateCircuitReference>;
    mapping: Record<string, string>;
    reviewer: string;
    reason: string;
    timestamp: number;
  }>;
  comparisons: Array<{
    id: string;
    comparison: ConnectivityComparison;
    sourceRevision: number;
    timestamp: number;
  }>;
  additionalInferenceRequests: 0;
  evidenceUrl: string;
}

export interface ConnectivityEvidence extends ConnectivityView {
  graphHistory: NonNullable<ConnectivityView['graph']>[];
}
