export type ConnectorPhase =
  | 'admitted'
  | 'dispatching'
  | 'response_recorded'
  | 'evaluated'
  | 'outcome_unknown'
  | 'not_sent';
export interface ConnectorAccountingMeasurement {
  phase?: ConnectorPhase;
  evaluationStatus?: 'pending' | 'succeeded' | 'failed' | 'not_evaluated';
  dispatchStartedAt?: number;
  responseRecordedAt?: number;
  responseStatus?: number;
  pixels?: number;
  upstreamOutcome: string;
  status: string;
  finishedAt: number | null;
  events?: Array<{ phase: ConnectorPhase; at: number }>;
}
export function connectorAccounting(report: {
  chargedRequests: number;
  chargedPixels: number;
  measurements: ConnectorAccountingMeasurement[];
}) {
  const sent = report.measurements.filter(
    (m) => m.dispatchStartedAt !== undefined,
  );
  const unknown = report.measurements.filter(
    (m) =>
      m.phase === 'outcome_unknown' ||
      (m.dispatchStartedAt !== undefined && m.upstreamOutcome === 'unknown'),
  );
  return {
    reservedRequests: report.chargedRequests,
    reservedPixels: report.chargedPixels,
    dispatchAttempts: sent.length,
    dispatchedPixels: sent.reduce((n, m) => n + (m.pixels ?? 0), 0),
    responsesRecorded: sent.filter((m) => m.responseRecordedAt !== undefined)
      .length,
    unknownUsageRequests: unknown.length,
    unknownUsagePixels: unknown.reduce((n, m) => n + (m.pixels ?? 0), 0),
    providerConfirmedUsage: null,
    billedCost: null,
    note: 'Dispatch intent is persisted before transport. It may overcount packets actually sent; responses do not prove billed usage. Unknown usage remains charged after release.',
  };
}
/** Recovery never dispatches or erases charges, response bytes, or already evaluated observations. */
export function recoverConnectorReport(value: unknown, now: number): unknown {
  if (
    !value ||
    typeof value !== 'object' ||
    !('version' in value) ||
    typeof value.version !== 'string' ||
    !value.version.startsWith('connector-')
  )
    return value;
  const report = structuredClone(value) as unknown as {
    status: string;
    finishedAt: number | null;
    chargedRequests: number;
    chargedPixels: number;
    measurements: ConnectorAccountingMeasurement[];
    accounting?: ReturnType<typeof connectorAccounting>;
  };
  if (report.status !== 'running') return report;
  report.status = 'interrupted';
  report.finishedAt = now;
  for (const m of report.measurements) {
    if (m.status !== 'running') continue;
    m.finishedAt = now;
    m.evaluationStatus = 'not_evaluated';
    m.phase =
      (m.dispatchStartedAt !== undefined ||
        (m.phase === undefined && m.upstreamOutcome === 'unknown')) &&
      m.responseRecordedAt === undefined
        ? 'outcome_unknown'
        : m.responseRecordedAt !== undefined
          ? 'response_recorded'
          : 'not_sent';
    m.upstreamOutcome =
      m.phase === 'outcome_unknown'
        ? 'unknown'
        : m.phase === 'not_sent'
          ? 'not_sent'
          : 'response_received';
    m.status = m.phase === 'outcome_unknown' ? 'interrupted' : 'failed';
    (m.events ??= []).push({ phase: m.phase, at: now });
  }
  report.accounting = connectorAccounting(report);
  return report;
}
