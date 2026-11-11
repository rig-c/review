/** Synthetic test data only. Baseline bytes captured before #746; no producer or browser claim. */
export const noFeedbackBaseline = {
  "provenance": "Synthetic complete writer envelopes captured before #746 source edits at parent-verified Review 65b98fd25fa295a03936c357ad7a97dc137762bc. No browser or owner-act claim.",
  "actId": "12345678-1234-4abc-8def-123456789abc",
  "at": "2026-11-12T00:00:00.000Z",
  "source": {
    "sourceHash": "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    "projectHash": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "package": {
      "id": "legacy",
      "revision": "one"
    },
    "selector": {
      "kind": "rig",
      "version": 1
    },
    "model": {
      "path": "skeleton.model.json",
      "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    },
    "direction": null,
    "optionSet": null,
    "appliedResult": null,
    "plan": {
      "steps": [
        {
          "id": "step-one",
          "hash": "1111111111111111111111111111111111111111111111111111111111111111"
        }
      ]
    },
    "parts": {
      "enumeratorVersion": "2.25.1",
      "manifest": {
        "path": "parts/parts.json",
        "sha256": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
      },
      "images": []
    }
  },
  "still": {
    "path": "2a2ec6576636f9b8c375736484374208a12359e95d1f13ea38f634edf44fb9c2.png",
    "sha256": "2a2ec6576636f9b8c375736484374208a12359e95d1f13ea38f634edf44fb9c2",
    "camera": "fixed",
    "frame": "setup"
  },
  "cases": [
    {
      "name": "empty",
      "value": {
        "stage": "rig-review",
        "verdict": "approved",
        "words": ""
      },
      "raw": "{\"schema\":\"rig-review/act@6\",\"actId\":\"12345678-1234-4abc-8def-123456789abc\",\"jobId\":\"job-746\",\"askId\":\"verdict-746\",\"publicationId\":\"publication-746\",\"authority\":{\"actor\":\"human\",\"channel\":\"review-ui\",\"reviewer\":{\"id\":\"owner\",\"role\":\"owner\"}},\"at\":\"2026-11-12T00:00:00.000Z\",\"kind\":\"review-verdict\",\"source\":{\"sourceHash\":\"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff\",\"projectHash\":\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\",\"package\":{\"id\":\"legacy\",\"revision\":\"one\"},\"selector\":{\"kind\":\"rig\",\"version\":1},\"model\":{\"path\":\"skeleton.model.json\",\"sha256\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"},\"direction\":null,\"optionSet\":null,\"appliedResult\":null,\"plan\":{\"steps\":[{\"id\":\"step-one\",\"hash\":\"1111111111111111111111111111111111111111111111111111111111111111\"}]},\"parts\":{\"enumeratorVersion\":\"2.25.1\",\"manifest\":{\"path\":\"parts/parts.json\",\"sha256\":\"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc\"},\"images\":[]}},\"value\":{\"stage\":\"rig-review\",\"verdict\":\"approved\",\"comments\":[]},\"still\":{\"path\":\"2a2ec6576636f9b8c375736484374208a12359e95d1f13ea38f634edf44fb9c2.png\",\"sha256\":\"2a2ec6576636f9b8c375736484374208a12359e95d1f13ea38f634edf44fb9c2\",\"camera\":\"fixed\",\"frame\":\"setup\"}}",
      "sha256": "a6895faca44d336faa92cbfd2a915754677e8e48fb344af81de01fe51eaf4c03"
    },
    {
      "name": "whitespace",
      "value": {
        "stage": "rig-review",
        "verdict": "pending",
        "words": " \n\t "
      },
      "raw": "{\"schema\":\"rig-review/act@6\",\"actId\":\"12345678-1234-4abc-8def-123456789abc\",\"jobId\":\"job-746\",\"askId\":\"verdict-746\",\"publicationId\":\"publication-746\",\"authority\":{\"actor\":\"human\",\"channel\":\"review-ui\",\"reviewer\":{\"id\":\"owner\",\"role\":\"owner\"}},\"at\":\"2026-11-12T00:00:00.000Z\",\"kind\":\"review-verdict\",\"source\":{\"sourceHash\":\"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff\",\"projectHash\":\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\",\"package\":{\"id\":\"legacy\",\"revision\":\"one\"},\"selector\":{\"kind\":\"rig\",\"version\":1},\"model\":{\"path\":\"skeleton.model.json\",\"sha256\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"},\"direction\":null,\"optionSet\":null,\"appliedResult\":null,\"plan\":{\"steps\":[{\"id\":\"step-one\",\"hash\":\"1111111111111111111111111111111111111111111111111111111111111111\"}]},\"parts\":{\"enumeratorVersion\":\"2.25.1\",\"manifest\":{\"path\":\"parts/parts.json\",\"sha256\":\"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc\"},\"images\":[]}},\"value\":{\"stage\":\"rig-review\",\"verdict\":\"pending\",\"comments\":[]},\"still\":{\"path\":\"2a2ec6576636f9b8c375736484374208a12359e95d1f13ea38f634edf44fb9c2.png\",\"sha256\":\"2a2ec6576636f9b8c375736484374208a12359e95d1f13ea38f634edf44fb9c2\",\"camera\":\"fixed\",\"frame\":\"setup\"}}",
      "sha256": "d33a33ded61211187492ded1c3f2d5f792d0c539e2f7b6b1884890518f34f723"
    },
    {
      "name": "verbatim",
      "value": {
        "stage": "rig-review",
        "verdict": "changes-requested",
        "words": "  Exact 한글\n"
      },
      "raw": "{\"schema\":\"rig-review/act@6\",\"actId\":\"12345678-1234-4abc-8def-123456789abc\",\"jobId\":\"job-746\",\"askId\":\"verdict-746\",\"publicationId\":\"publication-746\",\"authority\":{\"actor\":\"human\",\"channel\":\"review-ui\",\"reviewer\":{\"id\":\"owner\",\"role\":\"owner\"}},\"at\":\"2026-11-12T00:00:00.000Z\",\"kind\":\"review-verdict\",\"source\":{\"sourceHash\":\"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff\",\"projectHash\":\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\",\"package\":{\"id\":\"legacy\",\"revision\":\"one\"},\"selector\":{\"kind\":\"rig\",\"version\":1},\"model\":{\"path\":\"skeleton.model.json\",\"sha256\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"},\"direction\":null,\"optionSet\":null,\"appliedResult\":null,\"plan\":{\"steps\":[{\"id\":\"step-one\",\"hash\":\"1111111111111111111111111111111111111111111111111111111111111111\"}]},\"parts\":{\"enumeratorVersion\":\"2.25.1\",\"manifest\":{\"path\":\"parts/parts.json\",\"sha256\":\"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc\"},\"images\":[]}},\"value\":{\"stage\":\"rig-review\",\"verdict\":\"changes-requested\",\"comments\":[{\"text\":\"  Exact 한글\\n\"}]},\"still\":{\"path\":\"2a2ec6576636f9b8c375736484374208a12359e95d1f13ea38f634edf44fb9c2.png\",\"sha256\":\"2a2ec6576636f9b8c375736484374208a12359e95d1f13ea38f634edf44fb9c2\",\"camera\":\"fixed\",\"frame\":\"setup\"}}",
      "sha256": "51e16cd9f9296b113bcff413e5098109ff6bcb71fcdbcf26945d207b65cab7d5"
    },
    {
      "name": "projection",
      "value": {
        "stage": "rig-review",
        "verdict": "changes-requested",
        "words": "[[\"slot\",\"sleeve\",3,5,null]]\nSleeve tears"
      },
      "raw": "{\"schema\":\"rig-review/act@6\",\"actId\":\"12345678-1234-4abc-8def-123456789abc\",\"jobId\":\"job-746\",\"askId\":\"verdict-746\",\"publicationId\":\"publication-746\",\"authority\":{\"actor\":\"human\",\"channel\":\"review-ui\",\"reviewer\":{\"id\":\"owner\",\"role\":\"owner\"}},\"at\":\"2026-11-12T00:00:00.000Z\",\"kind\":\"review-verdict\",\"source\":{\"sourceHash\":\"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff\",\"projectHash\":\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\",\"package\":{\"id\":\"legacy\",\"revision\":\"one\"},\"selector\":{\"kind\":\"rig\",\"version\":1},\"model\":{\"path\":\"skeleton.model.json\",\"sha256\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"},\"direction\":null,\"optionSet\":null,\"appliedResult\":null,\"plan\":{\"steps\":[{\"id\":\"step-one\",\"hash\":\"1111111111111111111111111111111111111111111111111111111111111111\"}]},\"parts\":{\"enumeratorVersion\":\"2.25.1\",\"manifest\":{\"path\":\"parts/parts.json\",\"sha256\":\"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc\"},\"images\":[]}},\"value\":{\"stage\":\"rig-review\",\"verdict\":\"changes-requested\",\"comments\":[{\"text\":\"[[\\\"slot\\\",\\\"sleeve\\\",3,5,null]]\\nSleeve tears\"}]},\"still\":{\"path\":\"2a2ec6576636f9b8c375736484374208a12359e95d1f13ea38f634edf44fb9c2.png\",\"sha256\":\"2a2ec6576636f9b8c375736484374208a12359e95d1f13ea38f634edf44fb9c2\",\"camera\":\"fixed\",\"frame\":\"setup\"}}",
      "sha256": "f05796b1a4cb6598d2d1954d343f8526d0ac32231ad7f819bec4e5a5c8530fea"
    }
  ]
};

export const markedFeedback = {
  "provenance": "Synthetic stage comments using existing StageComment/time-only fields and inline PNG evidence; no browser or producer claim.",
  "feedback": [
    {
      "id": "pointed",
      "frameStart": 3,
      "frameEnd": 3,
      "target": {
        "kind": "rig",
        "name": "legacy"
      },
      "category": "defect",
      "summary": "  원문 그대로 · point and crop  ",
      "context": {
        "time": 0.25,
        "frame": 3,
        "animation": null,
        "interval": {
          "frameStart": 3,
          "frameEnd": 3,
          "inclusive": true
        },
        "comment": {
          "schema": "rig-review-comment/1",
          "mode": "animate",
          "viewport": "rig",
          "frame": {
            "index": 3,
            "basis": "producer"
          },
          "time": 0.25,
          "animation": null,
          "sourceHash": "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
          "modelHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "referenceId": null,
          "referenceHash": null,
          "camera": {
            "space": "world",
            "center": {
              "x": 0,
              "y": 0
            },
            "zoom": 1,
            "viewport": {
              "width": 100,
              "height": 100
            },
            "visible": {
              "x": -50,
              "y": -50,
              "width": 100,
              "height": 100
            }
          },
          "screen": {
            "x": 50,
            "y": 50,
            "width": 0,
            "height": 0
          },
          "world": {
            "x": 0,
            "y": 0,
            "width": 0,
            "height": 0
          },
          "slots": [],
          "crop": {
            "path": "comment-crops/2a2ec6576636f9b8c375736484374208a12359e95d1f13ea38f634edf44fb9c2.png",
            "sha256": "2a2ec6576636f9b8c375736484374208a12359e95d1f13ea38f634edf44fb9c2",
            "png": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4AWNgZGL+DwABFAEGJMkltwAAAABJRU5ErkJggg==",
            "width": 1,
            "height": 1
          },
          "bookmark": {
            "schema": "rig-review-inspection/1",
            "binding": {
              "mode": "single",
              "sourceHash": "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
              "rigs": [
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
              ]
            },
            "time": 0.25,
            "animation": null,
            "theme": "dark",
            "layers": {
              "images": true,
              "meshes": false,
              "bones": false
            },
            "view": {
              "schema": "rig-review-view/1",
              "cameras": {
                "rig": {
                  "space": "world",
                  "center": {
                    "x": 0,
                    "y": 0
                  },
                  "zoom": 1,
                  "viewport": {
                    "width": 100,
                    "height": 100
                  },
                  "visible": {
                    "x": -50,
                    "y": -50,
                    "width": 100,
                    "height": 100
                  }
                },
                "a": null,
                "b": null,
                "reference": null
              }
            },
            "selection": {
              "inspector": "playback"
            }
          }
        }
      }
    },
    {
      "id": "time-only",
      "frameStart": null,
      "frameEnd": null,
      "target": {
        "kind": "rig",
        "name": "legacy"
      },
      "category": "defect",
      "summary": "  원문 그대로 · point and crop  ",
      "context": {
        "time": 0.25,
        "frame": null,
        "animation": null,
        "interval": null,
        "comment": {
          "schema": "rig-review-comment/1",
          "mode": "animate",
          "viewport": "rig",
          "frame": null,
          "time": 0.25,
          "animation": null,
          "sourceHash": "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
          "modelHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "referenceId": null,
          "referenceHash": null,
          "camera": {
            "space": "world",
            "center": {
              "x": 0,
              "y": 0
            },
            "zoom": 1,
            "viewport": {
              "width": 100,
              "height": 100
            },
            "visible": {
              "x": -50,
              "y": -50,
              "width": 100,
              "height": 100
            }
          },
          "screen": {
            "x": 50,
            "y": 50,
            "width": 0,
            "height": 0
          },
          "world": {
            "x": 0,
            "y": 0,
            "width": 0,
            "height": 0
          },
          "slots": [],
          "crop": {
            "path": "comment-crops/2a2ec6576636f9b8c375736484374208a12359e95d1f13ea38f634edf44fb9c2.png",
            "sha256": "2a2ec6576636f9b8c375736484374208a12359e95d1f13ea38f634edf44fb9c2",
            "png": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4AWNgZGL+DwABFAEGJMkltwAAAABJRU5ErkJggg==",
            "width": 1,
            "height": 1
          },
          "bookmark": {
            "schema": "rig-review-inspection/1",
            "binding": {
              "mode": "single",
              "sourceHash": "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
              "rigs": [
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
              ]
            },
            "time": 0.25,
            "animation": null,
            "theme": "dark",
            "layers": {
              "images": true,
              "meshes": false,
              "bones": false
            },
            "view": {
              "schema": "rig-review-view/1",
              "cameras": {
                "rig": {
                  "space": "world",
                  "center": {
                    "x": 0,
                    "y": 0
                  },
                  "zoom": 1,
                  "viewport": {
                    "width": 100,
                    "height": 100
                  },
                  "visible": {
                    "x": -50,
                    "y": -50,
                    "width": 100,
                    "height": 100
                  }
                },
                "a": null,
                "b": null,
                "reference": null
              }
            },
            "selection": {
              "inspector": "playback"
            }
          },
          "timeBasis": {
            "schema": "rig-review-time-only/1",
            "basis": "seconds",
            "reason": "frame is unavailable: no explicit producer frame index at this time (COMMENT_FRAME_UNAVAILABLE)"
          }
        }
      }
    }
  ]
};
