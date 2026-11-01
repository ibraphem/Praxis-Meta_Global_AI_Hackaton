import { canonicalHash } from '../lib/canonical-json.js';
import { sha256 } from './scene-request-evidence.js';
import { decodeSamResponse } from '../services/sam.js';
import { maskPreview } from '../services/scene.js';
import type { ConnectorWorkflowService } from './connector-workflow.js';
export function auditConnectorEvidence(
  e: ReturnType<ConnectorWorkflowService['evidence']>,
) {
  const report = e.experiment?.report as
    | {
        plan: unknown;
        measurements: Array<{
          requestId: string;
          variant: string;
          objectId: string;
          observations?: Array<{ id: string; bbox: number[]; mask?: unknown }>;
          native?: Array<{
            observationId: string;
            encodedMask: Parameters<typeof maskPreview>[0];
            crop: number[];
            samObjectId?: number;
          }>;
        }>;
      }
    | undefined;
  const failures: string[] = [];
  let previewAgreement = true;
  if (
    !report ||
    canonicalHash(report.plan) !== canonicalHash(e.workflow.contract.plan)
  )
    failures.push('report_plan_mismatch');
  for (const m of report?.measurements ?? []) {
    const raw = e.requests.find((r) => r.requestId === m.requestId),
      v = e.workflow.contract.plan.variants.find((v) => v.name === m.variant);
    if (
      !raw ||
      !v ||
      !raw.request ||
      !raw.response ||
      raw.response.truncated ||
      m.objectId !== e.workflow.contract.plan.objectId ||
      sha256(raw.request.payload) !== raw.request.sha256 ||
      sha256(Buffer.from(raw.response.base64, 'base64')) !==
        raw.response.sha256 ||
      sha256(Buffer.from(raw.cropImage.base64, 'base64')) !== v.imageSha256 ||
      raw.prompt !== v.prompt ||
      raw.inputSnapshotHash !==
        e.workflow.contract.plan.sceneSnapshotRef.snapshotHash
    ) {
      failures.push('raw_request_response_binding');
      continue;
    }
    try {
      const body = JSON.parse(raw.request.payload);
      if (
        body.model !== e.workflow.contract.plan.model ||
        body.input[0].content[0].text !== v.prompt ||
        sha256(
          Buffer.from(
            body.input[0].content[1].image_url.split(',')[1],
            'base64',
          ),
        ) !== v.imageSha256
      )
        failures.push('provider_payload_mismatch');
    } catch {
      failures.push('provider_payload_invalid');
    }
    try {
      const replay = decodeSamResponse(
        JSON.parse(Buffer.from(raw.response.base64, 'base64').toString('utf8')),
        'scene_observation',
        { width: v.crop[2], height: v.crop[3] },
        true,
      );
      if (
        !raw.decoded ||
        canonicalHash(replay) !== canonicalHash(raw.decoded.candidates)
      )
        failures.push('decoded_response_mismatch');
    } catch {
      failures.push('response_replay_failed');
    }
    for (const n of m.native ?? []) {
      const o = m.observations?.find((o) => o.id === n.observationId);
      if (
        !o ||
        !n.encodedMask ||
        canonicalHash(n.crop) !== canonicalHash(v.crop) ||
        !raw.decoded?.candidates.some((candidate) => {
          const c = candidate as {
            encodedMask?: unknown;
            bbox: number[];
            samObjectId?: number;
          };
          return (
            c.encodedMask &&
            c.samObjectId === n.samObjectId &&
            canonicalHash(c.encodedMask) === canonicalHash(n.encodedMask) &&
            o &&
            canonicalHash(c.bbox) ===
              canonicalHash([
                o.bbox[0]! - v.crop[0],
                o.bbox[1]! - v.crop[1],
                o.bbox[2],
                o.bbox[3],
              ])
          );
        })
      )
        failures.push('native_candidate_mismatch');
      const preview = maskPreview(n.encodedMask);
      if (
        o?.mask &&
        (!preview || canonicalHash(o.mask) !== canonicalHash(preview))
      ) {
        previewAgreement = false;
        failures.push('preview_native_mismatch');
      }
    }
  }
  if (e.requests.length !== (report?.measurements.length ?? 0))
    failures.push('request_count_mismatch');
  return {
    provenanceValid: failures.length === 0,
    previewAgreement,
    failures: [...new Set(failures)],
    reportHash: canonicalHash(report ?? null),
    predictionHash: canonicalHash(
      report?.measurements.map((m) => ({
        requestId: m.requestId,
        observations: m.observations,
        native: m.native,
      })) ?? [],
    ),
    originalWorkflowHash: canonicalHash(e.workflow),
    originalExperimentHash: canonicalHash(e.experiment),
  };
}
