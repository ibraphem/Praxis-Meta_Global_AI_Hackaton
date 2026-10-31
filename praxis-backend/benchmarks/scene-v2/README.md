# Scene reconciliation and terminal benchmark

This benchmark separates object recognition, duplicate identities, terminal
localization, apparent attachments and inference latency. It never evaluates or
establishes electrical continuity. No accuracy result is claimed without independent
annotations of actual photographs.

Freeze each photo and its original predictions with the existing offline exporter:

```sh
cd praxis-backend/server
npm run evidence:export -- ANALYSIS_UUID NEW_PRIVATE_ARCHIVE
```

The archive contains the original photograph, immutable SAM/scene checkpoints, and
attempt history. Keep the original archive unchanged when evaluating a later stage;
export a second directory. Compare the same photos, model configuration and request
budgets. Include missing objects, hidden terminals and rejected proposals in the
annotation inventory. Keep annotations separate from predictions. Do not label model
or assistant annotations as human review.

Find the scene checkpoint referenced by `job.json` and inspect its bindings:

```sh
npm run scene:score -- --bindings NEW_PRIVATE_ARCHIVE/scene-snapshots/N.json NEW_PRIVATE_ARCHIVE/job.json
```

Copy the returned image/checkpoint/baseline hashes into the independent review. If
you omit the job file, scoring measures the graph's inventory projection only;
include it to evaluate the full workspace projection and recorded stage latency.
The evaluator refuses a job that refers to a different scene checkpoint.

A truth file has this shape (replace illustrative IDs and hashes with annotations):

```json
{
  "version": "scene-truth-v1",
  "imageHash": "64 lowercase hexadecimal characters",
  "source": "human_visual",
  "inventoryComplete": true,
  "attachmentsComplete": true,
  "terminalTolerancePx": 5,
  "objects": [
    { "id": "led_assembly", "label": "LED assembly" },
    { "id": "lead_red", "label": "red conductor" }
  ],
  "terminals": [
    {
      "id": "led_A",
      "objectId": "led_assembly",
      "visible": true,
      "position": [120, 300],
      "electricalRole": null
    },
    {
      "id": "led_B",
      "objectId": "led_assembly",
      "visible": false,
      "position": null,
      "electricalRole": null
    }
  ],
  "attachments": [
    { "terminalId": "led_A", "conductorObjectId": "lead_red", "visible": true }
  ]
}
```

Annotate the complete object set, not just the example LED. A visible terminal must
have an independently located original-image point. An occluded terminal stays
recorded with null position. Declare roles only when independently supported; wire
color alone is insufficient. Choose tolerance before comparing variants. Define
whether bodies/housings are parts or separate physical identities consistently.

A separate review file maps predictions to truth:

```json
{
  "version": "scene-review-v1",
  "imageHash": "FROM_BINDINGS",
  "sceneSnapshotHash": "FROM_BINDINGS",
  "baselineAnalysisHash": "FROM_BINDINGS_IF_JOB_INCLUDED",
  "source": "human_visual",
  "objectAssignments": [
    {
      "predictionId": "SCENE_OBJECT_UUID_OR_BASELINE_ID",
      "truthObjectId": "led_assembly"
    }
  ],
  "terminalAssignments": [
    { "predictionId": "TERMINAL_UUID", "truthTerminalId": "led_A" }
  ]
}
```

Omit `baselineAnalysisHash` when no job file is supplied. Map every displayed group
member, including associated baseline IDs, for complete review. Explicit null means
a reviewed false prediction; an absent assignment remains unreviewed. Map all
duplicate hypotheses to their actual truth identity: never select only the best one.

```sh
npm run scene:score -- SCENE_SNAPSHOT.json TRUTH.json REVIEW.json NEW_REPORT.json JOB.json
```

The scorer checks immutable snapshot integrity, exact evidence bindings and unique
annotations, and refuses to overwrite an existing report. It reports recall over
the complete supplied truth inventory, incorrect merges, duplicate identities,
unreviewed groups, visible-terminal accuracy over all visible truth terminals,
available-point error, incorrect role proposals and false apparent attachments.
Multiple predictions for one terminal cannot be cherry-picked for accuracy. Missing
coordinates are unresolved, not zero error. Incomplete attachment truth yields an
unknown false-proposal metric. Assistant-only or incomplete review cannot support
the report's independent accuracy-claims flag.

Request timings come only from recorded attempts, including failed work. Monetary
cost is not estimated without billing evidence. Synthetic tests exercise scoring
and transport only; they are not circuit-photo accuracy measurements. Start with
battery snap connectors and LED assemblies, then add unfamiliar components, adjacent
similar components, crossing wires, partial occlusion and off-image conductors.
