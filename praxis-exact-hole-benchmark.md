# Praxis exact-hole benchmark

Date: 28 October 2026

Photograph: https://iot-kmutnb.github.io/blogs/electronics/breadboard_prototyping/jumper_wires_breadboard.png (1426 × 1008).

Ground truth was recorded in the conversation and browser session before requesting any Muse endpoint proposals. Five exposed solid-core red jumpers on the lower terminal strip were selected in advance. Printed row numbers run right-to-left. A/B reversal is allowed; board, letter, and number must match exactly. Unresolved proposals count as failures in end-to-end exact-hole success because all 10 selected ground-truth endpoints are visible. Corrections are excluded from initial accuracy.

| Physical wire | SAM ID | Left hole | Right hole |
|---|---|---|---|
| Upper long red on lower strip | jumper_wire_5 | f23 | f10 |
| Short middle-left red | jumper_wire_7 | h30 | h25 |
| Long middle red | jumper_wire_6 | h23 | h10 |
| Short bottom-left red | jumper_wire_11 | j30 | j24 |
| Bottom-right red | jumper_wire_10 | j20 | j10 |

Calibration: standard 30-row template; a1=(1205,296), j1=(1202,680), j30=(170,685), a30=(181,290). The right edge reference positions were located using neighboring grid positions where wires overlapped; alignment was visually checked against exposed interior and end holes at 200% before inference. Calibration is a potential source of mapping error; it was not independently surveyed.

No power rail is used by these five wires. No repository changes were made.

## Results

**7/10 exact-hole successes (70%) before correction.** All 10 ground-truth endpoints were visible and remain in the denominator. Three original proposals failed to resolve; zero proposals resolved to a wrong neighboring hole. Precision among resolved endpoints was 7/7, with 70% resolution coverage. Two of five wires had both endpoints correct without correction.

| Wire | End | Truth | Muse pixels | Original hole | Snap px | Exact? | Saved hole / review |
|---|---|---|---|---|---:|---|---|
| 5 | A | f23 | (432, 544) | f23 | 5.53 | Yes | f23 / confirmed |
| 5 | B | f10 | (898, 532) | unresolved | — | No | f10 / corrected |
| 6 | A | h23 | (412, 604) | unresolved | — | No | h23 / corrected |
| 6 | B | h10 | (893, 602) | h10 | 9.56 | Yes | h10 / confirmed |
| 7 | A | h30 | (156, 616) | unresolved | — | No | h30 / corrected |
| 7 | B | h25 | (351, 614) | h25 | 3.41 | Yes | h25 / confirmed |
| 10 | A | j20 | (534, 683) | j20 | 1.52 | Yes | j20 / confirmed |
| 10 | B | j10 | (887, 675) | j10 | 6.59 | Yes | j10 / confirmed |
| 11 | A | j30 | (159, 688) | j30 | 11.40 | Yes | j30 / confirmed |
| 11 | B | j24 | (378, 687) | j24 | 10.80 | Yes | j24 / confirmed |

All original endpoint evidence values were `visible_insertion`; all connector-junction positions were null. The markers corresponded to the selected physical wires, rather than adjacent jumpers. All five reviewed records were saved with validity `complete`: seven AI-confirmed endpoints and three manual corrections. Original proposals and diagnostics were retained in saved JSON; wire identity remains formally unverified and electrical contact unknown.

## Timings and API evidence

| Wire | Client total s | Backend total s | Muse inference s |
|---|---:|---:|---:|
| 5 | 16.592 | 16.435 | 16.288 |
| 6 | 22.851 | 22.689 | 22.549 |
| 7 | 16.904 | 16.825 | 16.730 |
| 10 | 14.784 | 14.694 | 14.595 |
| 11 | 21.151 | 21.079 | 20.969 |

Mean endpoint-request latency: **18.456 seconds per wire**; range 14.784–22.851 seconds. All five endpoint calls used `muse-spark-1.3`, attempt 1, upstream status 200, without retries. Original SAM/Muse analysis: backend 23.261 seconds; UI 23.5 seconds; SAM 3.1 and Muse Spark 1.3.

## Interpretation and limits

This meets the requested minimum: 10 endpoints were pre-labelled and scored against exact logical holes, not connector junctions. The measured value is end-to-end Muse-pixel-plus-calibration resolution success, not a standalone language-model hole-classification accuracy. Muse supplies pixels; Praxis maps those pixels to holes.

The three unresolved original points were (898,532), (412,604), and (156,616). Their reviewed corrections were (886,538) → f10, (428,612) → h23, and (173,615) → h30. Do not count those corrections as AI successes. The saved calibration was unchanged throughout all five endpoint calls (revision 1).

This is one photograph, one calibration, five red solid-core wires, and one inference per wire. It does not measure other boards, rail endpoints, crowded or obscured connectors, crossing-wire cases, or run-to-run variability. The shared board and calibration mean these ten endpoints are not independent samples of all real-world circuits. Calibration was checked visually at 200%, not measured by an independent instrument.

The immediate result supports further measurement of pixel localization and calibration/snap behavior before an architectural change. Do not relax the snapping tolerance merely to raise this score; check whether any change creates neighboring-hole false positives. A larger benchmark should preserve blinded ground truth and report exact-hole yield, unresolved rate, wrong-hole rate, and latency separately.

## Original proposals and saved review evidence

The following machine-readable appendix preserves all original proposal fields, timings, request IDs, and the complete saved assignment records.

```json
{
  "truth": {
    "recordedBeforeEndpointInference": true,
    "source": "https://iot-kmutnb.github.io/blogs/electronics/breadboard_prototyping/jumper_wires_breadboard.png",
    "image": {
      "width": 1426,
      "height": 1008
    },
    "wires": [
      {
        "key": "lower_top_long_red",
        "holes": [
          "f23",
          "f10"
        ]
      },
      {
        "key": "lower_middle_short_left_red",
        "holes": [
          "h30",
          "h25"
        ]
      },
      {
        "key": "lower_middle_long_red",
        "holes": [
          "h23",
          "h10"
        ]
      },
      {
        "key": "lower_bottom_short_left_red",
        "holes": [
          "j30",
          "j24"
        ]
      },
      {
        "key": "lower_bottom_right_red",
        "holes": [
          "j20",
          "j10"
        ]
      }
    ]
  },
  "proposals": [
    {
      "id": "6264ab42-8e76-4c81-93ca-944fc00c1d74",
      "analysisId": "13b08953-936a-474a-adf3-79f3ec0d2c34",
      "imageId": "e3fb4b2b-968a-4870-be62-65b9866f6883",
      "wireCandidateId": "jumper_wire_5",
      "calibrationRevisions": {
        "board_1": 1
      },
      "model": "muse-spark-1.3",
      "diagnostics": {
        "requestId": "b9ad431c-6acd-40e6-b7fc-a5d65ea66a07",
        "elapsedMs": 16435,
        "timings": [
          {
            "stage": "upload",
            "startedAtMs": 1,
            "durationMs": 7,
            "status": "completed",
            "kind": "work"
          },
          {
            "stage": "image.prepare",
            "startedAtMs": 12,
            "durationMs": 50,
            "status": "completed",
            "kind": "work"
          },
          {
            "stage": "wire.grounding",
            "startedAtMs": 62,
            "durationMs": 82,
            "status": "completed",
            "kind": "work"
          },
          {
            "stage": "muse.endpoints",
            "startedAtMs": 146,
            "durationMs": 16288,
            "status": "completed",
            "kind": "request",
            "model": "muse-spark-1.3",
            "attempt": 1,
            "timeoutMs": 45000,
            "upstreamStatus": 200
          }
        ]
      },
      "endpoints": [
        {
          "role": "A",
          "proposedImagePosition": [
            432,
            544
          ],
          "connectorJunctionPosition": null,
          "evidence": "visible_insertion",
          "proposedHole": {
            "boardId": "board_1",
            "holeId": "f23",
            "snapDistancePx": 5.528146573848934
          },
          "reviewStatus": "proposed"
        },
        {
          "role": "B",
          "proposedImagePosition": [
            898,
            532
          ],
          "connectorJunctionPosition": null,
          "evidence": "visible_insertion",
          "proposedHole": null,
          "reviewStatus": "proposed"
        }
      ],
      "clientElapsedMs": 16591.599999999627
    },
    {
      "id": "7db29a43-fe6d-469e-a9cf-18ed1a2881bb",
      "analysisId": "13b08953-936a-474a-adf3-79f3ec0d2c34",
      "imageId": "e3fb4b2b-968a-4870-be62-65b9866f6883",
      "wireCandidateId": "jumper_wire_6",
      "calibrationRevisions": {
        "board_1": 1
      },
      "model": "muse-spark-1.3",
      "diagnostics": {
        "requestId": "6e79dfc8-2350-405c-b466-9366bd5c730d",
        "elapsedMs": 22689,
        "timings": [
          {
            "stage": "upload",
            "startedAtMs": 0,
            "durationMs": 8,
            "status": "completed",
            "kind": "work"
          },
          {
            "stage": "image.prepare",
            "startedAtMs": 10,
            "durationMs": 41,
            "status": "completed",
            "kind": "work"
          },
          {
            "stage": "wire.grounding",
            "startedAtMs": 51,
            "durationMs": 84,
            "status": "completed",
            "kind": "work"
          },
          {
            "stage": "muse.endpoints",
            "startedAtMs": 139,
            "durationMs": 22549,
            "status": "completed",
            "kind": "request",
            "model": "muse-spark-1.3",
            "attempt": 1,
            "timeoutMs": 45000,
            "upstreamStatus": 200
          }
        ]
      },
      "endpoints": [
        {
          "role": "A",
          "proposedImagePosition": [
            412,
            604
          ],
          "connectorJunctionPosition": null,
          "evidence": "visible_insertion",
          "proposedHole": null,
          "reviewStatus": "proposed"
        },
        {
          "role": "B",
          "proposedImagePosition": [
            893,
            602
          ],
          "connectorJunctionPosition": null,
          "evidence": "visible_insertion",
          "proposedHole": {
            "boardId": "board_1",
            "holeId": "h10",
            "snapDistancePx": 9.563163535327131
          },
          "reviewStatus": "proposed"
        }
      ],
      "clientElapsedMs": 22851.39999999851
    },
    {
      "id": "fba4e3ab-6d85-44af-8924-a83fcacd3a33",
      "analysisId": "13b08953-936a-474a-adf3-79f3ec0d2c34",
      "imageId": "e3fb4b2b-968a-4870-be62-65b9866f6883",
      "wireCandidateId": "jumper_wire_7",
      "calibrationRevisions": {
        "board_1": 1
      },
      "model": "muse-spark-1.3",
      "diagnostics": {
        "requestId": "9476fe9e-90ff-49e8-a835-5f583748475a",
        "elapsedMs": 16825,
        "timings": [
          {
            "stage": "upload",
            "startedAtMs": 0,
            "durationMs": 3,
            "status": "completed",
            "kind": "work"
          },
          {
            "stage": "image.prepare",
            "startedAtMs": 4,
            "durationMs": 30,
            "status": "completed",
            "kind": "work"
          },
          {
            "stage": "wire.grounding",
            "startedAtMs": 34,
            "durationMs": 59,
            "status": "completed",
            "kind": "work"
          },
          {
            "stage": "muse.endpoints",
            "startedAtMs": 94,
            "durationMs": 16730,
            "status": "completed",
            "kind": "request",
            "model": "muse-spark-1.3",
            "attempt": 1,
            "timeoutMs": 45000,
            "upstreamStatus": 200
          }
        ]
      },
      "endpoints": [
        {
          "role": "A",
          "proposedImagePosition": [
            156,
            616
          ],
          "connectorJunctionPosition": null,
          "evidence": "visible_insertion",
          "proposedHole": null,
          "reviewStatus": "proposed"
        },
        {
          "role": "B",
          "proposedImagePosition": [
            351,
            614
          ],
          "connectorJunctionPosition": null,
          "evidence": "visible_insertion",
          "proposedHole": {
            "boardId": "board_1",
            "holeId": "h25",
            "snapDistancePx": 3.4068068813519896
          },
          "reviewStatus": "proposed"
        }
      ],
      "clientElapsedMs": 16904.099999999627
    },
    {
      "id": "0429ae9b-0462-43a6-8686-f1d73aa8652a",
      "analysisId": "13b08953-936a-474a-adf3-79f3ec0d2c34",
      "imageId": "e3fb4b2b-968a-4870-be62-65b9866f6883",
      "wireCandidateId": "jumper_wire_10",
      "calibrationRevisions": {
        "board_1": 1
      },
      "model": "muse-spark-1.3",
      "diagnostics": {
        "requestId": "ee77da17-ff14-44a9-9479-2fced862dfbe",
        "elapsedMs": 14694,
        "timings": [
          {
            "stage": "upload",
            "startedAtMs": 1,
            "durationMs": 5,
            "status": "completed",
            "kind": "work"
          },
          {
            "stage": "image.prepare",
            "startedAtMs": 7,
            "durationMs": 28,
            "status": "completed",
            "kind": "work"
          },
          {
            "stage": "wire.grounding",
            "startedAtMs": 35,
            "durationMs": 61,
            "status": "completed",
            "kind": "work"
          },
          {
            "stage": "muse.endpoints",
            "startedAtMs": 98,
            "durationMs": 14595,
            "status": "completed",
            "kind": "request",
            "model": "muse-spark-1.3",
            "attempt": 1,
            "timeoutMs": 45000,
            "upstreamStatus": 200
          }
        ]
      },
      "endpoints": [
        {
          "role": "A",
          "proposedImagePosition": [
            534,
            683
          ],
          "connectorJunctionPosition": null,
          "evidence": "visible_insertion",
          "proposedHole": {
            "boardId": "board_1",
            "holeId": "j20",
            "snapDistancePx": 1.5165548369325883
          },
          "reviewStatus": "proposed"
        },
        {
          "role": "B",
          "proposedImagePosition": [
            887,
            675
          ],
          "connectorJunctionPosition": null,
          "evidence": "visible_insertion",
          "proposedHole": {
            "boardId": "board_1",
            "holeId": "j10",
            "snapDistancePx": 6.591018275945127
          },
          "reviewStatus": "proposed"
        }
      ],
      "clientElapsedMs": 14783.5
    },
    {
      "id": "9416c52a-8448-422e-bff2-7427d9321a2d",
      "analysisId": "13b08953-936a-474a-adf3-79f3ec0d2c34",
      "imageId": "e3fb4b2b-968a-4870-be62-65b9866f6883",
      "wireCandidateId": "jumper_wire_11",
      "calibrationRevisions": {
        "board_1": 1
      },
      "model": "muse-spark-1.3",
      "diagnostics": {
        "requestId": "fc01b298-3c54-45d4-906c-fc69ca929de5",
        "elapsedMs": 21079,
        "timings": [
          {
            "stage": "upload",
            "startedAtMs": 1,
            "durationMs": 6,
            "status": "completed",
            "kind": "work"
          },
          {
            "stage": "image.prepare",
            "startedAtMs": 11,
            "durationMs": 32,
            "status": "completed",
            "kind": "work"
          },
          {
            "stage": "wire.grounding",
            "startedAtMs": 45,
            "durationMs": 63,
            "status": "completed",
            "kind": "work"
          },
          {
            "stage": "muse.endpoints",
            "startedAtMs": 110,
            "durationMs": 20969,
            "status": "completed",
            "kind": "request",
            "model": "muse-spark-1.3",
            "attempt": 1,
            "timeoutMs": 45000,
            "upstreamStatus": 200
          }
        ]
      },
      "endpoints": [
        {
          "role": "A",
          "proposedImagePosition": [
            159,
            688
          ],
          "connectorJunctionPosition": null,
          "evidence": "visible_insertion",
          "proposedHole": {
            "boardId": "board_1",
            "holeId": "j30",
            "snapDistancePx": 11.401754250991406
          },
          "reviewStatus": "proposed"
        },
        {
          "role": "B",
          "proposedImagePosition": [
            378,
            687
          ],
          "connectorJunctionPosition": null,
          "evidence": "visible_insertion",
          "proposedHole": {
            "boardId": "board_1",
            "holeId": "j24",
            "snapDistancePx": 10.80167927003507
          },
          "reviewStatus": "proposed"
        }
      ],
      "clientElapsedMs": 21150.900000000373
    }
  ],
  "assignments": [
    {
      "id": "connection_5",
      "photoId": "e3fb4b2b-968a-4870-be62-65b9866f6883",
      "analysisRunId": "13b08953-936a-474a-adf3-79f3ec0d2c34",
      "wireCandidateId": "jumper_wire_11",
      "wireIdentity": {
        "status": "unverified",
        "associationSource": "user"
      },
      "endpoints": [
        {
          "selectionSource": "ai_user_confirmed",
          "inputMethod": "ai_proposal",
          "locationVerification": "user_confirmed",
          "selectedImagePosition": {
            "x": 159,
            "y": 688
          },
          "boardId": "board_1",
          "calibrationRevision": 1,
          "resolution": {
            "status": "resolved",
            "source": "calibrated_grid",
            "holeId": "j30",
            "imagePosition": {
              "x": 170.00000000000003,
              "y": 685
            },
            "electricalGroup": "board_1:terminal-f-j-30",
            "groupBasis": "template",
            "snapDistancePx": 11.401754250991406
          },
          "electricalContact": "unknown"
        },
        {
          "selectionSource": "ai_user_confirmed",
          "inputMethod": "ai_proposal",
          "locationVerification": "user_confirmed",
          "selectedImagePosition": {
            "x": 378,
            "y": 687
          },
          "boardId": "board_1",
          "calibrationRevision": 1,
          "resolution": {
            "status": "resolved",
            "source": "calibrated_grid",
            "holeId": "j24",
            "imagePosition": {
              "x": 388.35979001466046,
              "y": 683.9420552809368
            },
            "electricalGroup": "board_1:terminal-f-j-24",
            "groupBasis": "template",
            "snapDistancePx": 10.80167927003507
          },
          "electricalContact": "unknown"
        }
      ],
      "endpointReview": {
        "proposal": {
          "id": "9416c52a-8448-422e-bff2-7427d9321a2d",
          "analysisId": "13b08953-936a-474a-adf3-79f3ec0d2c34",
          "imageId": "e3fb4b2b-968a-4870-be62-65b9866f6883",
          "wireCandidateId": "jumper_wire_11",
          "calibrationRevisions": {
            "board_1": 1
          },
          "model": "muse-spark-1.3",
          "diagnostics": {
            "requestId": "fc01b298-3c54-45d4-906c-fc69ca929de5",
            "elapsedMs": 21079,
            "timings": [
              {
                "stage": "upload",
                "startedAtMs": 1,
                "durationMs": 6,
                "status": "completed",
                "kind": "work"
              },
              {
                "stage": "image.prepare",
                "startedAtMs": 11,
                "durationMs": 32,
                "status": "completed",
                "kind": "work"
              },
              {
                "stage": "wire.grounding",
                "startedAtMs": 45,
                "durationMs": 63,
                "status": "completed",
                "kind": "work"
              },
              {
                "stage": "muse.endpoints",
                "startedAtMs": 110,
                "durationMs": 20969,
                "status": "completed",
                "kind": "request",
                "model": "muse-spark-1.3",
                "attempt": 1,
                "timeoutMs": 45000,
                "upstreamStatus": 200
              }
            ]
          },
          "endpoints": [
            {
              "role": "A",
              "proposedImagePosition": [
                159,
                688
              ],
              "connectorJunctionPosition": null,
              "evidence": "visible_insertion",
              "proposedHole": {
                "boardId": "board_1",
                "holeId": "j30",
                "snapDistancePx": 11.401754250991406
              },
              "reviewStatus": "proposed"
            },
            {
              "role": "B",
              "proposedImagePosition": [
                378,
                687
              ],
              "connectorJunctionPosition": null,
              "evidence": "visible_insertion",
              "proposedHole": {
                "boardId": "board_1",
                "holeId": "j24",
                "snapDistancePx": 10.80167927003507
              },
              "reviewStatus": "proposed"
            }
          ],
          "clientElapsedMs": 21150.900000000373
        },
        "endpoints": [
          {
            "role": "A",
            "originalProposal": {
              "role": "A",
              "proposedImagePosition": [
                159,
                688
              ],
              "connectorJunctionPosition": null,
              "evidence": "visible_insertion",
              "proposedHole": {
                "boardId": "board_1",
                "holeId": "j30",
                "snapDistancePx": 11.401754250991406
              },
              "reviewStatus": "proposed"
            },
            "finalPosition": [
              159,
              688
            ],
            "finalHole": {
              "boardId": "board_1",
              "holeId": "j30",
              "snapDistancePx": 11.401754250991406
            },
            "reviewStatus": "confirmed",
            "source": "ai_user_confirmed",
            "observation": {
              "selectionSource": "ai_user_confirmed",
              "inputMethod": "ai_proposal",
              "locationVerification": "user_confirmed",
              "selectedImagePosition": {
                "x": 159,
                "y": 688
              },
              "boardId": "board_1",
              "calibrationRevision": 1,
              "resolution": {
                "status": "resolved",
                "source": "calibrated_grid",
                "holeId": "j30",
                "imagePosition": {
                  "x": 170.00000000000003,
                  "y": 685
                },
                "electricalGroup": "board_1:terminal-f-j-30",
                "groupBasis": "template",
                "snapDistancePx": 11.401754250991406
              },
              "electricalContact": "unknown"
            }
          },
          {
            "role": "B",
            "originalProposal": {
              "role": "B",
              "proposedImagePosition": [
                378,
                687
              ],
              "connectorJunctionPosition": null,
              "evidence": "visible_insertion",
              "proposedHole": {
                "boardId": "board_1",
                "holeId": "j24",
                "snapDistancePx": 10.80167927003507
              },
              "reviewStatus": "proposed"
            },
            "finalPosition": [
              378,
              687
            ],
            "finalHole": {
              "boardId": "board_1",
              "holeId": "j24",
              "snapDistancePx": 10.80167927003507
            },
            "reviewStatus": "confirmed",
            "source": "ai_user_confirmed",
            "observation": {
              "selectionSource": "ai_user_confirmed",
              "inputMethod": "ai_proposal",
              "locationVerification": "user_confirmed",
              "selectedImagePosition": {
                "x": 378,
                "y": 687
              },
              "boardId": "board_1",
              "calibrationRevision": 1,
              "resolution": {
                "status": "resolved",
                "source": "calibrated_grid",
                "holeId": "j24",
                "imagePosition": {
                  "x": 388.35979001466046,
                  "y": 683.9420552809368
                },
                "electricalGroup": "board_1:terminal-f-j-24",
                "groupBasis": "template",
                "snapDistancePx": 10.80167927003507
              },
              "electricalContact": "unknown"
            }
          }
        ],
        "pendingCorrections": [
          null,
          null
        ],
        "savedAssignmentId": "connection_5",
        "dirty": false
      },
      "validity": {
        "status": "complete",
        "reasons": []
      }
    },
    {
      "id": "connection_4",
      "photoId": "e3fb4b2b-968a-4870-be62-65b9866f6883",
      "analysisRunId": "13b08953-936a-474a-adf3-79f3ec0d2c34",
      "wireCandidateId": "jumper_wire_10",
      "wireIdentity": {
        "status": "unverified",
        "associationSource": "user"
      },
      "endpoints": [
        {
          "selectionSource": "ai_user_confirmed",
          "inputMethod": "ai_proposal",
          "locationVerification": "user_confirmed",
          "selectedImagePosition": {
            "x": 534,
            "y": 683
          },
          "boardId": "board_1",
          "calibrationRevision": 1,
          "resolution": {
            "status": "resolved",
            "source": "calibrated_grid",
            "holeId": "j20",
            "imagePosition": {
              "x": 532.503151454045,
              "y": 683.2436862817149
            },
            "electricalGroup": "board_1:terminal-f-j-20",
            "groupBasis": "template",
            "snapDistancePx": 1.5165548369325883
          },
          "electricalContact": "unknown"
        },
        {
          "selectionSource": "ai_user_confirmed",
          "inputMethod": "ai_proposal",
          "locationVerification": "user_confirmed",
          "selectedImagePosition": {
            "x": 887,
            "y": 675
          },
          "boardId": "board_1",
          "calibrationRevision": 1,
          "resolution": {
            "status": "resolved",
            "source": "calibrated_grid",
            "holeId": "j10",
            "imagePosition": {
              "x": 887.9544946847066,
              "y": 681.5215383009463
            },
            "electricalGroup": "board_1:terminal-f-j-10",
            "groupBasis": "template",
            "snapDistancePx": 6.591018275945127
          },
          "electricalContact": "unknown"
        }
      ],
      "endpointReview": {
        "proposal": {
          "id": "0429ae9b-0462-43a6-8686-f1d73aa8652a",
          "analysisId": "13b08953-936a-474a-adf3-79f3ec0d2c34",
          "imageId": "e3fb4b2b-968a-4870-be62-65b9866f6883",
          "wireCandidateId": "jumper_wire_10",
          "calibrationRevisions": {
            "board_1": 1
          },
          "model": "muse-spark-1.3",
          "diagnostics": {
            "requestId": "ee77da17-ff14-44a9-9479-2fced862dfbe",
            "elapsedMs": 14694,
            "timings": [
              {
                "stage": "upload",
                "startedAtMs": 1,
                "durationMs": 5,
                "status": "completed",
                "kind": "work"
              },
              {
                "stage": "image.prepare",
                "startedAtMs": 7,
                "durationMs": 28,
                "status": "completed",
                "kind": "work"
              },
              {
                "stage": "wire.grounding",
                "startedAtMs": 35,
                "durationMs": 61,
                "status": "completed",
                "kind": "work"
              },
              {
                "stage": "muse.endpoints",
                "startedAtMs": 98,
                "durationMs": 14595,
                "status": "completed",
                "kind": "request",
                "model": "muse-spark-1.3",
                "attempt": 1,
                "timeoutMs": 45000,
                "upstreamStatus": 200
              }
            ]
          },
          "endpoints": [
            {
              "role": "A",
              "proposedImagePosition": [
                534,
                683
              ],
              "connectorJunctionPosition": null,
              "evidence": "visible_insertion",
              "proposedHole": {
                "boardId": "board_1",
                "holeId": "j20",
                "snapDistancePx": 1.5165548369325883
              },
              "reviewStatus": "proposed"
            },
            {
              "role": "B",
              "proposedImagePosition": [
                887,
                675
              ],
              "connectorJunctionPosition": null,
              "evidence": "visible_insertion",
              "proposedHole": {
                "boardId": "board_1",
                "holeId": "j10",
                "snapDistancePx": 6.591018275945127
              },
              "reviewStatus": "proposed"
            }
          ],
          "clientElapsedMs": 14783.5
        },
        "endpoints": [
          {
            "role": "A",
            "originalProposal": {
              "role": "A",
              "proposedImagePosition": [
                534,
                683
              ],
              "connectorJunctionPosition": null,
              "evidence": "visible_insertion",
              "proposedHole": {
                "boardId": "board_1",
                "holeId": "j20",
                "snapDistancePx": 1.5165548369325883
              },
              "reviewStatus": "proposed"
            },
            "finalPosition": [
              534,
              683
            ],
            "finalHole": {
              "boardId": "board_1",
              "holeId": "j20",
              "snapDistancePx": 1.5165548369325883
            },
            "reviewStatus": "confirmed",
            "source": "ai_user_confirmed",
            "observation": {
              "selectionSource": "ai_user_confirmed",
              "inputMethod": "ai_proposal",
              "locationVerification": "user_confirmed",
              "selectedImagePosition": {
                "x": 534,
                "y": 683
              },
              "boardId": "board_1",
              "calibrationRevision": 1,
              "resolution": {
                "status": "resolved",
                "source": "calibrated_grid",
                "holeId": "j20",
                "imagePosition": {
                  "x": 532.503151454045,
                  "y": 683.2436862817149
                },
                "electricalGroup": "board_1:terminal-f-j-20",
                "groupBasis": "template",
                "snapDistancePx": 1.5165548369325883
              },
              "electricalContact": "unknown"
            }
          },
          {
            "role": "B",
            "originalProposal": {
              "role": "B",
              "proposedImagePosition": [
                887,
                675
              ],
              "connectorJunctionPosition": null,
              "evidence": "visible_insertion",
              "proposedHole": {
                "boardId": "board_1",
                "holeId": "j10",
                "snapDistancePx": 6.591018275945127
              },
              "reviewStatus": "proposed"
            },
            "finalPosition": [
              887,
              675
            ],
            "finalHole": {
              "boardId": "board_1",
              "holeId": "j10",
              "snapDistancePx": 6.591018275945127
            },
            "reviewStatus": "confirmed",
            "source": "ai_user_confirmed",
            "observation": {
              "selectionSource": "ai_user_confirmed",
              "inputMethod": "ai_proposal",
              "locationVerification": "user_confirmed",
              "selectedImagePosition": {
                "x": 887,
                "y": 675
              },
              "boardId": "board_1",
              "calibrationRevision": 1,
              "resolution": {
                "status": "resolved",
                "source": "calibrated_grid",
                "holeId": "j10",
                "imagePosition": {
                  "x": 887.9544946847066,
                  "y": 681.5215383009463
                },
                "electricalGroup": "board_1:terminal-f-j-10",
                "groupBasis": "template",
                "snapDistancePx": 6.591018275945127
              },
              "electricalContact": "unknown"
            }
          }
        ],
        "pendingCorrections": [
          null,
          null
        ],
        "savedAssignmentId": "connection_4",
        "dirty": false
      },
      "validity": {
        "status": "complete",
        "reasons": []
      }
    },
    {
      "id": "connection_3",
      "photoId": "e3fb4b2b-968a-4870-be62-65b9866f6883",
      "analysisRunId": "13b08953-936a-474a-adf3-79f3ec0d2c34",
      "wireCandidateId": "jumper_wire_7",
      "wireIdentity": {
        "status": "unverified",
        "associationSource": "user"
      },
      "endpoints": [
        {
          "selectionSource": "manual_correction",
          "inputMethod": "pixel_entry",
          "locationVerification": "user_selected",
          "selectedImagePosition": {
            "x": 173,
            "y": 615
          },
          "boardId": "board_1",
          "calibrationRevision": 1,
          "resolution": {
            "status": "resolved",
            "source": "calibrated_grid",
            "holeId": "h30",
            "imagePosition": {
              "x": 172.01262843829562,
              "y": 612.7283424430218
            },
            "electricalGroup": "board_1:terminal-f-j-30",
            "groupBasis": "template",
            "snapDistancePx": 2.476959962744392
          },
          "electricalContact": "unknown"
        },
        {
          "selectionSource": "ai_user_confirmed",
          "inputMethod": "ai_proposal",
          "locationVerification": "user_confirmed",
          "selectedImagePosition": {
            "x": 351,
            "y": 614
          },
          "boardId": "board_1",
          "calibrationRevision": 1,
          "resolution": {
            "status": "resolved",
            "source": "calibrated_grid",
            "holeId": "h25",
            "imagePosition": {
              "x": 353.89449167597087,
              "y": 612.2032665571759
            },
            "electricalGroup": "board_1:terminal-f-j-25",
            "groupBasis": "template",
            "snapDistancePx": 3.4068068813519896
          },
          "electricalContact": "unknown"
        }
      ],
      "endpointReview": {
        "proposal": {
          "id": "fba4e3ab-6d85-44af-8924-a83fcacd3a33",
          "analysisId": "13b08953-936a-474a-adf3-79f3ec0d2c34",
          "imageId": "e3fb4b2b-968a-4870-be62-65b9866f6883",
          "wireCandidateId": "jumper_wire_7",
          "calibrationRevisions": {
            "board_1": 1
          },
          "model": "muse-spark-1.3",
          "diagnostics": {
            "requestId": "9476fe9e-90ff-49e8-a835-5f583748475a",
            "elapsedMs": 16825,
            "timings": [
              {
                "stage": "upload",
                "startedAtMs": 0,
                "durationMs": 3,
                "status": "completed",
                "kind": "work"
              },
              {
                "stage": "image.prepare",
                "startedAtMs": 4,
                "durationMs": 30,
                "status": "completed",
                "kind": "work"
              },
              {
                "stage": "wire.grounding",
                "startedAtMs": 34,
                "durationMs": 59,
                "status": "completed",
                "kind": "work"
              },
              {
                "stage": "muse.endpoints",
                "startedAtMs": 94,
                "durationMs": 16730,
                "status": "completed",
                "kind": "request",
                "model": "muse-spark-1.3",
                "attempt": 1,
                "timeoutMs": 45000,
                "upstreamStatus": 200
              }
            ]
          },
          "endpoints": [
            {
              "role": "A",
              "proposedImagePosition": [
                156,
                616
              ],
              "connectorJunctionPosition": null,
              "evidence": "visible_insertion",
              "proposedHole": null,
              "reviewStatus": "proposed"
            },
            {
              "role": "B",
              "proposedImagePosition": [
                351,
                614
              ],
              "connectorJunctionPosition": null,
              "evidence": "visible_insertion",
              "proposedHole": {
                "boardId": "board_1",
                "holeId": "h25",
                "snapDistancePx": 3.4068068813519896
              },
              "reviewStatus": "proposed"
            }
          ],
          "clientElapsedMs": 16904.099999999627
        },
        "endpoints": [
          {
            "role": "A",
            "originalProposal": {
              "role": "A",
              "proposedImagePosition": [
                156,
                616
              ],
              "connectorJunctionPosition": null,
              "evidence": "visible_insertion",
              "proposedHole": null,
              "reviewStatus": "proposed"
            },
            "finalPosition": [
              173,
              615
            ],
            "finalHole": {
              "boardId": "board_1",
              "holeId": "h30",
              "snapDistancePx": 2.476959962744392
            },
            "reviewStatus": "corrected",
            "source": "manual_correction",
            "observation": {
              "selectionSource": "manual_correction",
              "inputMethod": "pixel_entry",
              "locationVerification": "user_selected",
              "selectedImagePosition": {
                "x": 173,
                "y": 615
              },
              "boardId": "board_1",
              "calibrationRevision": 1,
              "resolution": {
                "status": "resolved",
                "source": "calibrated_grid",
                "holeId": "h30",
                "imagePosition": {
                  "x": 172.01262843829562,
                  "y": 612.7283424430218
                },
                "electricalGroup": "board_1:terminal-f-j-30",
                "groupBasis": "template",
                "snapDistancePx": 2.476959962744392
              },
              "electricalContact": "unknown"
            }
          },
          {
            "role": "B",
            "originalProposal": {
              "role": "B",
              "proposedImagePosition": [
                351,
                614
              ],
              "connectorJunctionPosition": null,
              "evidence": "visible_insertion",
              "proposedHole": {
                "boardId": "board_1",
                "holeId": "h25",
                "snapDistancePx": 3.4068068813519896
              },
              "reviewStatus": "proposed"
            },
            "finalPosition": [
              351,
              614
            ],
            "finalHole": {
              "boardId": "board_1",
              "holeId": "h25",
              "snapDistancePx": 3.4068068813519896
            },
            "reviewStatus": "confirmed",
            "source": "ai_user_confirmed",
            "observation": {
              "selectionSource": "ai_user_confirmed",
              "inputMethod": "ai_proposal",
              "locationVerification": "user_confirmed",
              "selectedImagePosition": {
                "x": 351,
                "y": 614
              },
              "boardId": "board_1",
              "calibrationRevision": 1,
              "resolution": {
                "status": "resolved",
                "source": "calibrated_grid",
                "holeId": "h25",
                "imagePosition": {
                  "x": 353.89449167597087,
                  "y": 612.2032665571759
                },
                "electricalGroup": "board_1:terminal-f-j-25",
                "groupBasis": "template",
                "snapDistancePx": 3.4068068813519896
              },
              "electricalContact": "unknown"
            }
          }
        ],
        "pendingCorrections": [
          null,
          null
        ],
        "savedAssignmentId": "connection_3",
        "dirty": false
      },
      "validity": {
        "status": "complete",
        "reasons": []
      }
    },
    {
      "id": "connection_2",
      "photoId": "e3fb4b2b-968a-4870-be62-65b9866f6883",
      "analysisRunId": "13b08953-936a-474a-adf3-79f3ec0d2c34",
      "wireCandidateId": "jumper_wire_6",
      "wireIdentity": {
        "status": "unverified",
        "associationSource": "user"
      },
      "endpoints": [
        {
          "selectionSource": "manual_correction",
          "inputMethod": "pixel_entry",
          "locationVerification": "user_selected",
          "selectedImagePosition": {
            "x": 428,
            "y": 612
          },
          "boardId": "board_1",
          "calibrationRevision": 1,
          "resolution": {
            "status": "resolved",
            "source": "calibrated_grid",
            "holeId": "h23",
            "imagePosition": {
              "x": 426.1462493651224,
              "y": 611.9946825070829
            },
            "electricalGroup": "board_1:terminal-f-j-23",
            "groupBasis": "template",
            "snapDistancePx": 1.8537582614893522
          },
          "electricalContact": "unknown"
        },
        {
          "selectionSource": "ai_user_confirmed",
          "inputMethod": "ai_proposal",
          "locationVerification": "user_confirmed",
          "selectedImagePosition": {
            "x": 893,
            "y": 602
          },
          "boardId": "board_1",
          "calibrationRevision": 1,
          "resolution": {
            "status": "resolved",
            "source": "calibrated_grid",
            "holeId": "h10",
            "imagePosition": {
              "x": 888.9401904264877,
              "y": 610.6586397909965
            },
            "electricalGroup": "board_1:terminal-f-j-10",
            "groupBasis": "template",
            "snapDistancePx": 9.563163535327131
          },
          "electricalContact": "unknown"
        }
      ],
      "endpointReview": {
        "proposal": {
          "id": "7db29a43-fe6d-469e-a9cf-18ed1a2881bb",
          "analysisId": "13b08953-936a-474a-adf3-79f3ec0d2c34",
          "imageId": "e3fb4b2b-968a-4870-be62-65b9866f6883",
          "wireCandidateId": "jumper_wire_6",
          "calibrationRevisions": {
            "board_1": 1
          },
          "model": "muse-spark-1.3",
          "diagnostics": {
            "requestId": "6e79dfc8-2350-405c-b466-9366bd5c730d",
            "elapsedMs": 22689,
            "timings": [
              {
                "stage": "upload",
                "startedAtMs": 0,
                "durationMs": 8,
                "status": "completed",
                "kind": "work"
              },
              {
                "stage": "image.prepare",
                "startedAtMs": 10,
                "durationMs": 41,
                "status": "completed",
                "kind": "work"
              },
              {
                "stage": "wire.grounding",
                "startedAtMs": 51,
                "durationMs": 84,
                "status": "completed",
                "kind": "work"
              },
              {
                "stage": "muse.endpoints",
                "startedAtMs": 139,
                "durationMs": 22549,
                "status": "completed",
                "kind": "request",
                "model": "muse-spark-1.3",
                "attempt": 1,
                "timeoutMs": 45000,
                "upstreamStatus": 200
              }
            ]
          },
          "endpoints": [
            {
              "role": "A",
              "proposedImagePosition": [
                412,
                604
              ],
              "connectorJunctionPosition": null,
              "evidence": "visible_insertion",
              "proposedHole": null,
              "reviewStatus": "proposed"
            },
            {
              "role": "B",
              "proposedImagePosition": [
                893,
                602
              ],
              "connectorJunctionPosition": null,
              "evidence": "visible_insertion",
              "proposedHole": {
                "boardId": "board_1",
                "holeId": "h10",
                "snapDistancePx": 9.563163535327131
              },
              "reviewStatus": "proposed"
            }
          ],
          "clientElapsedMs": 22851.39999999851
        },
        "endpoints": [
          {
            "role": "A",
            "originalProposal": {
              "role": "A",
              "proposedImagePosition": [
                412,
                604
              ],
              "connectorJunctionPosition": null,
              "evidence": "visible_insertion",
              "proposedHole": null,
              "reviewStatus": "proposed"
            },
            "finalPosition": [
              428,
              612
            ],
            "finalHole": {
              "boardId": "board_1",
              "holeId": "h23",
              "snapDistancePx": 1.8537582614893522
            },
            "reviewStatus": "corrected",
            "source": "manual_correction",
            "observation": {
              "selectionSource": "manual_correction",
              "inputMethod": "pixel_entry",
              "locationVerification": "user_selected",
              "selectedImagePosition": {
                "x": 428,
                "y": 612
              },
              "boardId": "board_1",
              "calibrationRevision": 1,
              "resolution": {
                "status": "resolved",
                "source": "calibrated_grid",
                "holeId": "h23",
                "imagePosition": {
                  "x": 426.1462493651224,
                  "y": 611.9946825070829
                },
                "electricalGroup": "board_1:terminal-f-j-23",
                "groupBasis": "template",
                "snapDistancePx": 1.8537582614893522
              },
              "electricalContact": "unknown"
            }
          },
          {
            "role": "B",
            "originalProposal": {
              "role": "B",
              "proposedImagePosition": [
                893,
                602
              ],
              "connectorJunctionPosition": null,
              "evidence": "visible_insertion",
              "proposedHole": {
                "boardId": "board_1",
                "holeId": "h10",
                "snapDistancePx": 9.563163535327131
              },
              "reviewStatus": "proposed"
            },
            "finalPosition": [
              893,
              602
            ],
            "finalHole": {
              "boardId": "board_1",
              "holeId": "h10",
              "snapDistancePx": 9.563163535327131
            },
            "reviewStatus": "confirmed",
            "source": "ai_user_confirmed",
            "observation": {
              "selectionSource": "ai_user_confirmed",
              "inputMethod": "ai_proposal",
              "locationVerification": "user_confirmed",
              "selectedImagePosition": {
                "x": 893,
                "y": 602
              },
              "boardId": "board_1",
              "calibrationRevision": 1,
              "resolution": {
                "status": "resolved",
                "source": "calibrated_grid",
                "holeId": "h10",
                "imagePosition": {
                  "x": 888.9401904264877,
                  "y": 610.6586397909965
                },
                "electricalGroup": "board_1:terminal-f-j-10",
                "groupBasis": "template",
                "snapDistancePx": 9.563163535327131
              },
              "electricalContact": "unknown"
            }
          }
        ],
        "pendingCorrections": [
          null,
          null
        ],
        "savedAssignmentId": "connection_2",
        "dirty": false
      },
      "validity": {
        "status": "complete",
        "reasons": []
      }
    },
    {
      "id": "connection_1",
      "photoId": "e3fb4b2b-968a-4870-be62-65b9866f6883",
      "analysisRunId": "13b08953-936a-474a-adf3-79f3ec0d2c34",
      "wireCandidateId": "jumper_wire_5",
      "wireIdentity": {
        "status": "unverified",
        "associationSource": "user"
      },
      "endpoints": [
        {
          "selectionSource": "ai_user_confirmed",
          "inputMethod": "ai_proposal",
          "locationVerification": "user_confirmed",
          "selectedImagePosition": {
            "x": 432,
            "y": 544
          },
          "boardId": "board_1",
          "calibrationRevision": 1,
          "resolution": {
            "status": "resolved",
            "source": "calibrated_grid",
            "holeId": "f23",
            "imagePosition": {
              "x": 427.785794667476,
              "y": 540.4221685398437
            },
            "electricalGroup": "board_1:terminal-f-j-23",
            "groupBasis": "template",
            "snapDistancePx": 5.528146573848934
          },
          "electricalContact": "unknown"
        },
        {
          "selectionSource": "manual_correction",
          "inputMethod": "pixel_entry",
          "locationVerification": "user_selected",
          "selectedImagePosition": {
            "x": 886,
            "y": 538
          },
          "boardId": "board_1",
          "calibrationRevision": 1,
          "resolution": {
            "status": "resolved",
            "source": "calibrated_grid",
            "holeId": "f10",
            "imagePosition": {
              "x": 889.923177454563,
              "y": 539.9904740939179
            },
            "electricalGroup": "board_1:terminal-f-j-10",
            "groupBasis": "template",
            "snapDistancePx": 4.399239531845178
          },
          "electricalContact": "unknown"
        }
      ],
      "endpointReview": {
        "proposal": {
          "id": "6264ab42-8e76-4c81-93ca-944fc00c1d74",
          "analysisId": "13b08953-936a-474a-adf3-79f3ec0d2c34",
          "imageId": "e3fb4b2b-968a-4870-be62-65b9866f6883",
          "wireCandidateId": "jumper_wire_5",
          "calibrationRevisions": {
            "board_1": 1
          },
          "model": "muse-spark-1.3",
          "diagnostics": {
            "requestId": "b9ad431c-6acd-40e6-b7fc-a5d65ea66a07",
            "elapsedMs": 16435,
            "timings": [
              {
                "stage": "upload",
                "startedAtMs": 1,
                "durationMs": 7,
                "status": "completed",
                "kind": "work"
              },
              {
                "stage": "image.prepare",
                "startedAtMs": 12,
                "durationMs": 50,
                "status": "completed",
                "kind": "work"
              },
              {
                "stage": "wire.grounding",
                "startedAtMs": 62,
                "durationMs": 82,
                "status": "completed",
                "kind": "work"
              },
              {
                "stage": "muse.endpoints",
                "startedAtMs": 146,
                "durationMs": 16288,
                "status": "completed",
                "kind": "request",
                "model": "muse-spark-1.3",
                "attempt": 1,
                "timeoutMs": 45000,
                "upstreamStatus": 200
              }
            ]
          },
          "endpoints": [
            {
              "role": "A",
              "proposedImagePosition": [
                432,
                544
              ],
              "connectorJunctionPosition": null,
              "evidence": "visible_insertion",
              "proposedHole": {
                "boardId": "board_1",
                "holeId": "f23",
                "snapDistancePx": 5.528146573848934
              },
              "reviewStatus": "proposed"
            },
            {
              "role": "B",
              "proposedImagePosition": [
                898,
                532
              ],
              "connectorJunctionPosition": null,
              "evidence": "visible_insertion",
              "proposedHole": null,
              "reviewStatus": "proposed"
            }
          ],
          "clientElapsedMs": 16591.599999999627
        },
        "endpoints": [
          {
            "role": "A",
            "originalProposal": {
              "role": "A",
              "proposedImagePosition": [
                432,
                544
              ],
              "connectorJunctionPosition": null,
              "evidence": "visible_insertion",
              "proposedHole": {
                "boardId": "board_1",
                "holeId": "f23",
                "snapDistancePx": 5.528146573848934
              },
              "reviewStatus": "proposed"
            },
            "finalPosition": [
              432,
              544
            ],
            "finalHole": {
              "boardId": "board_1",
              "holeId": "f23",
              "snapDistancePx": 5.528146573848934
            },
            "reviewStatus": "confirmed",
            "source": "ai_user_confirmed",
            "observation": {
              "selectionSource": "ai_user_confirmed",
              "inputMethod": "ai_proposal",
              "locationVerification": "user_confirmed",
              "selectedImagePosition": {
                "x": 432,
                "y": 544
              },
              "boardId": "board_1",
              "calibrationRevision": 1,
              "resolution": {
                "status": "resolved",
                "source": "calibrated_grid",
                "holeId": "f23",
                "imagePosition": {
                  "x": 427.785794667476,
                  "y": 540.4221685398437
                },
                "electricalGroup": "board_1:terminal-f-j-23",
                "groupBasis": "template",
                "snapDistancePx": 5.528146573848934
              },
              "electricalContact": "unknown"
            }
          },
          {
            "role": "B",
            "originalProposal": {
              "role": "B",
              "proposedImagePosition": [
                898,
                532
              ],
              "connectorJunctionPosition": null,
              "evidence": "visible_insertion",
              "proposedHole": null,
              "reviewStatus": "proposed"
            },
            "finalPosition": [
              886,
              538
            ],
            "finalHole": {
              "boardId": "board_1",
              "holeId": "f10",
              "snapDistancePx": 4.399239531845178
            },
            "reviewStatus": "corrected",
            "source": "manual_correction",
            "observation": {
              "selectionSource": "manual_correction",
              "inputMethod": "pixel_entry",
              "locationVerification": "user_selected",
              "selectedImagePosition": {
                "x": 886,
                "y": 538
              },
              "boardId": "board_1",
              "calibrationRevision": 1,
              "resolution": {
                "status": "resolved",
                "source": "calibrated_grid",
                "holeId": "f10",
                "imagePosition": {
                  "x": 889.923177454563,
                  "y": 539.9904740939179
                },
                "electricalGroup": "board_1:terminal-f-j-10",
                "groupBasis": "template",
                "snapDistancePx": 4.399239531845178
              },
              "electricalContact": "unknown"
            }
          }
        ],
        "pendingCorrections": [
          null,
          null
        ],
        "savedAssignmentId": "connection_1",
        "dirty": false
      },
      "validity": {
        "status": "complete",
        "reasons": []
      }
    }
  ]
}
```
