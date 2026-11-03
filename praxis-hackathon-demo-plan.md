# Praxis hackathon demo — implementation plan

Status: software workflow implemented; physical rig qualification and rehearsal remain pending. See [UI workflow](docs/camera-demo.md). No live inference was run during implementation.

## 1. Target demonstration

Use one fixed-camera breadboard circuit with two branches:

```text
5V ── R1 ── green power LED D1 ── GND
5V ── normally-open button S1 ── R2 ── jumper J1 ── red LED D2 ── GND
```

The green LED provides a working visual control. The red LED should light while
the button is pressed. Verify actual resistor values, LED polarity, button
contacts, supply and breadboard topology before freezing the physical profile.

The deliberate fault is J1's LED-side end inserted into a nearby **empty strip**,
disconnecting R2's LED-side terminal from D2's anode. Rehearse two wrong strips
and the healthy placement. Actual hole coordinates are not yet specified;
J18/J19 versus J20 are examples until the real assembly is reviewed.

The presentation sequence is:

1. Select the intended circuit profile and start the real camera.
2. Press the button: green remains on; red does not illuminate.
3. Scan a fresh frame; show components, observed connectivity and the finding.
4. Highlight J1 and explain its actual strip versus the required destination net.
5. Show a supported repair instruction and arrow to a verified available hole.
6. Move the wire, clear the view and request verification.
7. Analyze a different, fresh capture; update the graph if the repair is supported.
8. Press the button and observe the red LED illuminating.

The profile supplies the **intended design**. Current observations supply the
**observed wiring**. Neither a selected profile nor a clicked confirmation button
may manufacture a fresh visual observation.

## 2. Existing code to retain

| Existing area | Reuse |
| --- | --- |
| `praxis-backend/server/src/services/connectivity.ts` | Deterministic conductive grouping, typed devices and reference comparison |
| `praxis-backend/server/src/jobs/connectivity.ts` | Versioned evidence, manual reviews, stale-source checks, graph history and exports |
| `praxis-backend/server/src/shared/calibration.ts` | The shared hole resolver, board transforms and rail geometry |
| `praxis-backend/server/src/services/endpoint-proposals.ts` | Bounded wire-endpoint interpretation and coordinate contracts |
| `praxis-backend/server/src/jobs/store.ts` and existing workers | Saved images, checkpoints, inference admission, attempts and recovery |
| `praxis-frontend/components/vision-workspace.tsx` | Existing upload flow and saved analysis loading |
| `praxis-frontend/components/breadboard-workspace.tsx` | Calibration, hole selection, endpoint review and evidence export |
| `praxis-frontend/components/connectivity-panel.tsx` | Graph review, provenance, reference comparison and overlays |

Uploaded photographs remain a supported entry point. Camera capture feeds the
same analysis machinery. Do not build a second inference scheduler or require a
synthetic demo loader to run the physical demonstration.

## 3. Milestone A — prove the physical still-image case first

Before camera or animation work, assemble the actual circuit and register a
versioned `CircuitProfile` containing:

- Verified schematic/netlist and component identities/values.
- LED terminal roles and the actual switch's verified contact mapping.
- Intended nets and the R2-to-D2 required conductive relationship through J1.
- Confirmed board model, orientation and rail topology.
- Setup observations and their source-image, reviewer and provenance references.
- A mapping from logical profile components to observed component hypotheses;
  mappings are proposals until supported by physical evidence.
- Declared test scope: this circuit, this board and this misplaced-jumper fault.

Use the ordinary upload workflow to analyze healthy, faulty and repaired physical
captures. Record original proposals and necessary human confirmations separately.
Determine whether J1's real insertion points are visible enough for reliable
localization. If this fails, improve wire presentation, framing or the existing
endpoint path before building the live-camera shell.

**Exit gate:** one real healthy capture yields no target fault; one real misplaced
jumper yields the correct supported discrepancy and affected wire; a separately
captured repaired state supports the restored relationship. Any required human
intervention is recorded. No physical acceptance is claimed from synthetic tests.

## 4. Milestone B — circuit profile onboarding and button semantics

Add a profile selector: **Two-LED button indicator**. This replaces on-stage JSON
authoring with a prepared intended reference and an off-stage setup/review flow.

Keep logical identities separate from detector IDs. Each capture records the
evidence linking its scene objects to D1, D2, R1, R2, S1 and J1. Never resolve a
wire identity solely by color, proximity or the expected destination.

Extend the component model and graph validation with a switch device:

- Effective contacts A/B; verified physical-leg aliases when the actual part has
  internally connected pairs. Do not assume an arbitrary four-pin orientation.
- `open`, `closed` and `unknown` switch states with their evidence source.
- A conditional device relationship, preserving the separation between device
  behavior and ordinary conductive wires.
- An intentionally open or unknown button does not become a missing-wire fault.

The selected fault rule checks the direct R2-to-D2 jumper relationship, independent
of the button's instantaneous state. The final button press is a separate
functional test. Profile selection must not assert the observed jumper placement
or mark the entire circuit correct.

**Exit gate:** profile selection requires no JSON editing during the demo; healthy
unpressed wiring does not produce a button-related confirmed fault; ambiguous
profile mappings request review.

## 5. Milestone C — live preview with immutable captured frames

Add camera start/stop, device selection, **Scan circuit** and **Verify repair**.
Continue showing the preview while processing captured frames. The first version
performs inference on requested keyframes, not on every video frame.

Every `CaptureRecord` includes:

- Session/capture IDs, source timestamp, frame dimensions and source-image hash.
- Camera/display scaling, cropping and mirroring information.
- Profile version/hash and board registration revision.
- Its existing analysis job ID and native evidence/checkpoint references.
- Capture purpose: setup, assessment or repair verification.
- Prepared request budget, actual accounting, latency and provenance.

A `CircuitSession` groups these existing analysis jobs and their derived results.
It supplies linkage and UI state, not a separate inference execution lifecycle.

Keep one captured frame in flight. A second click must not create duplicate work.
Record dispatch intent before transport, preserve unknown usage after interruption
and never silently replay a provider request.

**Exit gate:** captured pixels, saved source pixels, analysis coordinates and
displayed overlays agree under resize/zoom/mirroring. Upload still works. Camera
denial or disconnection has a recoverable state.

## 6. Milestone D — registration and trustworthy evidence across captures

Use a fixed camera and stationary board for the first release. Store the reviewed
board calibration from setup, then validate registration for each new capture.
Choose and document usable board landmarks; add external fiducial markers if
ordinary landmarks cannot produce a reliable pose check in the real setup.

Record the transform and its quality evidence rather than copying old image
coordinates to a new frame. A new image hash creates new observation records.

Classify evidence explicitly:

- Profile facts: intended design, verified part roles and physical topology.
- Previously reviewed setup facts: retained with their original evidence.
- New-frame observations: current component identity, wire mask, endpoints and
  visible insertion evidence.
- Transferred facts: only eligible static facts with a recorded, validated
  registration/unchanged-region basis. Otherwise invalidate or request review.

J1's changed endpoint must always receive fresh evidence. The reference, an old
mask or a previous correction cannot supply its new observed hole.

Preserve the independent broad SAM pass in the bounded scan path. Reuse existing
endpoint interpretation for the uniquely identified J1 candidate. Whole-scene
inventory refresh is a separate explicit operation when scene changes require it;
it is not the default cost of every repair verification.

The implemented broad detector makes **four SAM requests**, one per category.
Each requested frame permits up to four SAM requests and one separately approved
endpoint Muse request, with no retries. The manifest records every input image's
pixels. Frames are capped at 1.5 million pixels so the four-SAM pass stays within
the six-million-pixel limit. There is no automatic scene inventory refresh.
Retain applicable six-million-pixel SAM limits and record crop/image accounting.

Model output remains a proposal until the acceptance policy is validated on real,
labeled captures. An automatic insertion claim requires supported physical wire
identity, visible insertion evidence and an unambiguous match under the existing
strict calibrated-hole policy. Resolution geometry alone does not establish
electrical contact. Ask a focused question when these requirements are unmet.

**Exit gate:** camera/board drift, an ambiguous wire, a hidden insertion or an
unsupported transfer cannot yield a fresh confirmed connection. The untouched
wire end and static facts retain traceable identity rather than array-index links.

## 7. Milestone E — a clean graph with linked inspection

Build a compact circuit view from the existing graph, hiding unused board holes.
Render typed component relationships distinctly from conductive connections.

There are two useful projections:

- **Connection view:** nodes represent conductive strip/contact groups before
  jumper union. Wires remain distinct edges, so hovering J1 can highlight its
  own graph edge and source-image mask.
- **Electrical netlist:** show the final unioned nets and typed devices. An intact
  wire may contribute inside one net, rather than connect two distinct final nets.
  Highlight its contribution without inventing a nonexistent inter-net edge.

Keep one shared selection model for logical component, observed object, conductor,
terminal, connection and net IDs. Hovering either the wire or its displayed edge
highlights its counterpart. Include provenance on selection. Unknown relationships
are dashed amber; confirmed faults are red; supported restored relationships are
green. Label intended/reference links separately from observed links.

**Exit gate:** healthy, faulty, partial and repaired graphs retain the same
electrical meaning as the canonical engine. Device paths never become ordinary
shorts merely for attractive rendering.

## 8. Milestone F — evidence-backed diagnosis and repair planning

Use the existing required-path comparison for the selected J1 fault. Produce one
of `confirmed_fault`, `possible_fault`, `insufficient_evidence` or scoped
`no_fault`, respecting current source revisions and conductive review coverage.

Explanations must use actual object labels and observed hole references. Example
after those facts are established: "J1 ends on strip 18; D2's anode is on strip
20. The expected R2-to-D2 connection is missing." The hole numbers are observations,
not a fixed response embedded for one photograph.

Add a deterministic repair planner that:

1. Requires a current supported finding and a uniquely identified movable end.
2. Finds the required destination net from the verified reference mapping.
3. Enumerates registered holes on that net.
4. Requires a visible, verified available destination; unknown occupancy is not
   treated as empty. Setup may pre-review a destination, but changed/occluded
   regions invalidate its eligibility.
5. Simulates the proposed single-end move on a copy of the graph.
6. Checks that it restores the target relationship without introducing relevant
   forbidden net merges or changing the healthy branch.
7. Emits a versioned `RepairInstruction` with source capture/graph/finding/profile
   hashes, wire/end identity, actual source hole, supported target hole/net and
   evidence IDs.

Draw the arrow using the validated image-to-live-view transform. Bind its lifetime
to that source assessment and pose. Hide or stale it after a new assessment,
registration failure or unsupported scene change. If there is no defensible exact
target, ask for clarification instead of drawing a guessed arrow.

**Exit gate:** the instruction identifies the correct wire end and an electrically
equivalent, verified available destination. Ambiguous or stale findings cannot
produce confident exact-hole guidance.

## 9. Milestone G — verify the physical repair from fresh evidence

Verification captures a new frame and runs through the same bounded evidence and
graph paths. It does not edit the previous graph into the expected result.

Compare before/after graphs through logical component, board and terminal IDs,
with capture-specific observations and identity-link evidence. Require:

- A fresh image and supported board registration.
- Correct J1 identity, its unchanged anchored end and a newly observed movable end.
- A supported insertion on the required destination net.
- The original required relationship restored, with relevant unexpected net merges
  or competing wire changes checked.

Distinguish `resolved`, `not_resolved` and `unable_to_verify`. A removed wire,
hidden target, stale response, missing observations or an unchanged wrong placement
cannot become a resolution. Review corrections remain auditable and separate;
software edits alone cannot satisfy physical verification.

Show "Expected R2-to-D2 connection restored" only after that gate passes. Then ask
for the button press and show the real LED response. Initially this functional
response is observed by the presenter/judge, with a separate optional human
confirmation. Automatic LED-on detection is a later measured feature, not an
assumption derived from graph connectivity.

**Exit gate:** physical before/after captures, not only mocked responses or input
edits, demonstrate the diagnosis and restoration.

## 10. Milestone H — live presentation states and bounded rehearsal

Product states:

```text
setup → camera_ready → capturing → analyzing
      → needs_confirmation | scoped_no_fault | fault_found
      → repair_guidance → awaiting_clear_view → verifying
      → resolved | not_resolved | unable_to_verify
```

Always show the scan number and the age/source of an assessment. Keep live video
running, but do not present a last-scan overlay as continuously refreshed vision.
Use lightweight local motion/registration checks to pause or gray guidance.
Motion stability alone does not prove visibility: a stationary hand may still
hide the contacts. Clear-view and insertion evidence are separate gates.

Hand and gesture tracking are excluded. Use explicit scans and fresh verification.

First approve a bounded physical proof batch: healthy, wrong strip A, repaired.
Only after that succeeds, prepare and authorize a rehearsal batch containing both
wrong strips, healthy controls, repairs, unchanged faults, occlusions and board
movement. Archive captures once and replay them offline wherever possible.

Target at least ten consecutive complete physical demonstration cycles with zero
incorrect confirmed diagnoses, exact-hole instructions or repair confirmations
within the declared setup. This is a rehearsal acceptance target, not a general
accuracy claim. Measure human interventions, abstentions, identity errors,
localization errors, end-to-end latency and actual provider usage. Report median
and tail latency before choosing the presentation pacing.

## 11. Implementation surfaces

Proposed additions, with final names kept consistent with repository conventions:

| Area | Changes |
| --- | --- |
| Backend schemas | Versioned circuit profile, switch state, capture/session linkage, repair instruction and verification result |
| Backend services | Profile validation, capture evidence adaptation, repair planning, before/after graph comparison |
| Existing job/worker path | Frozen capture context, explicit selected stages, durable request/pixel accounting and no replay |
| Backend persistence | Session-to-analysis links, pose evidence, profile bindings, repair/verification artifacts and history under existing retention |
| Frontend camera component | Live preview, immutable capture, device/error handling and correct image/display transforms |
| Frontend circuit/profile controls | Prepared profile selection and off-stage physical setup/review; preserve ordinary uploads |
| Frontend graph component | Connection/netlist projections and shared wire/edge hover/selection |
| Frontend guidance overlay | Current supported fault highlighting, pose-bound arrow and stale/occluded states |
| Existing review/export UI | Minimal clarification controls and full session evidence bundle linking original analysis archives |

Use session endpoints for profile/capture linkage and analysis-scoped actions for
graph/repair artifacts. Upload a prepared capture through the existing image/job
creation code. A verification action evaluates a named fresh completed capture;
it never authorizes hidden inference merely by changing an output status.

## 12. Tests and final acceptance

Automated checks must cover:

- Existing upload, calibration, endpoint, connector and connectivity regressions.
- Button released/open/unknown states and verified physical-contact aliases.
- Camera transforms, resize/mirroring, drift, cancellation and duplicate clicks.
- New-image hashes, ambiguous identities and safe invalidation of transferred facts.
- Wire/edge hover semantics before and after conductive union.
- Healthy and both faulty placements; equivalent holes and alternate valid paths.
- Unknown/occupied destinations, wrong-end moves, stale repair plans and forbidden
  merges in counterfactual planning.
- Fresh repaired captures, unchanged wrong placement, removed wire, stationary
  occlusion, camera movement and missing post-repair evidence.
- Zero model calls from graph building, hover, repair planning and offline replay;
  bounded explicit calls from requested captures, with restart-safe accounting.
- Persisted session replay and exports retaining profiles, original frames,
  captures, masks, pose transforms, mappings, graphs, findings, repair instructions,
  reviews, verification decisions, timings and request accounting.

The final physical demonstration passes only when the selected real circuit is
diagnosed from current image evidence, the correct wire/end and a supported repair
destination are highlighted, a fresh post-move capture verifies restoration, and
the judge can press the button and observe D2 lighting. If a fact is unsupported,
the product must ask a specific question or state that it cannot verify.

## 13. Required physical inputs and sequencing

Before Milestone A can pass, provide the actual assembled circuit photograph,
verified schematic, board model, supply, LED/resistor specifications, switch
part/contact mapping and chosen accessible J1 routing. Do not assume a historical
analysis is this circuit or that the illustrative hole numbers match the board.

Implement A and B first, then C/D, then E/F/G, then presentation polish and rehearsal.
The critical path is trustworthy physical endpoint evidence and fresh-capture
verification. Camera preview and graph styling can proceed once those contracts
are defined, but they do not substitute for the physical exit gates.

Synthetic tests, physical rehearsals, manual confirmations and independently
reviewed evidence remain separately labeled throughout. No full analog simulation,
arbitrary-circuit autonomy, extra connector optimization or continuous inference
is required for this first demonstration.
