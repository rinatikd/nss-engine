# AGPT/APPT preview.7: operator-reported native check, 2026-10-30

Basis: command history supplied by the user from their Windows AutoCAD session. The cloud agent did not run AutoCAD. Source candidate: 5ec5aba5d32e2ffd7c06064067ab3883e75f5bb8, draft PR #59.

## Confirmed by the supplied log

- NETLOAD initialized AGPT/APPT 1.1.0-preview.7.
- AGPT_ZONE immediately prompted for the first corner, accepted subsequent points, and completed the boundary.
- The height prompt accepted 3 metres.
- The configured minimum-temperature default of 18°C was applied and identified as a user setting.
- A room contour was stored; no manual requests for Cn, K4 or total pipe volume occurred.
- Missing gas-agent and opening-area data were reported; the room remained incomplete rather than calculating with invented values.

## Not confirmed

- Actual physical drawing scale. The command used the template's declared millimetres and reported area 0.3761877498870742 m². This establishes interpretation of metadata, not that the rectangle represents the intended real room size. No known physical dimension was supplied in this test.
- Temperature editing/persistence, cancellation/rollback, source refresh, or unit-evidence conflict handling in native AutoCAD.
- Pipe-volume calculation on a real network, album generation, visual output, numerical or normative acceptance.

## Remaining data prerequisites

A new rectangle in an acadiso template has no engineering gas-agent choice or opening/leakage information. Gas must come from an identified project profile or explicit model evidence. FH must come from a verified opening/leakage model; absence of detected objects is not proof of FH=0. Do not use arbitrary values or pretend the supplied-project HFC profile is universally applicable.

The native capture/height/default-temperature workflow is partially accepted from operator evidence. Full automatic engineering design and final product acceptance remain open.

A separate missing historical NssEngine.dll startup path appears in the log. Preview.7 loaded subsequently; that startup error is not evidence of a failed AGPT load in this test.

## Preview.8 operator check (additional command history)

Source candidate: 1453b6cfb187f5dcd87460515c520e8015a300d6. Evidence is supplied by the operator; the cloud agent did not execute AutoCAD.

- NETLOAD initialized 1.1.0-preview.8 successfully despite the separate obsolete NssEngine startup-path error.
- Corner picking completed. An empty height entry was rejected with a numeric-value prompt, then 3 metres was accepted.
- HFC-227ea and 18°C defaults were applied and explicitly labelled as user settings.
- The contour was stored with an incomplete status; FH was the only missing model-input field reported by AGPT_ZONE in this log. This does not establish readiness of network geometry or other commands.
- Reported area: 0.8627861212340887 m², based on declared millimetres. Physical scale is still unverified: no known room dimension was provided.
- No gas-agent, concentration, density, K4 or total-pipe-volume prompt occurred.

FH has no confirmed numeric default. The reference-project value 0.011 m² has been proposed for clarification only; it has not been assigned or described as a universal normative minimum. Do not infer approval from an unanswered question.

Preview.8 capture and default application are confirmed by the supplied command log. Calculation, album generation, drawing quality and engineering acceptance remain unverified.

## Preview.10 operator check (additional command history)

Source candidate: 27a14cf56dbbc6a53d0aa9610e183c174018663e. Operator supplied command history; no cloud-hosted AutoCAD execution.

- NETLOAD and AGPT_VERSION identify 1.1.0-preview.10 loaded from the operator's AutoCAD2026 runtime folder.
- The first corner attempt was rejected with a self-intersection/touching-edge validation message. Coordinates and screen geometry were not supplied: neither an actual invalid boundary nor a false positive can be established from the log alone. This is not a successful native acceptance of that corner sequence.
- A subsequent existing rectangle selected through the Contour option was accepted; height 3 metres was entered.
- User-configured defaults HFC-227ea, FH=0.011 m² and 20°C were applied and labelled. The contour became READY for the implemented input checks.
- AGPT_ZONE_LIST reported one source zone with S=0.4388697723300058 m², H=3m, Vp approximately1.31661m³ and the expected defaults. Its handle and READY status were present.
- AGPT_CALC returned Mg=1kg, module40L and Fc=0m², reported zero pipe segments/Vtr=0 and explicitly warned that the network model was unconfirmed.
- The command reported saving historical CALC_SNAPSHOT_* data. Actual stored XData persistence/reopen was not separately inspected.

The declared millimetres gave XY bounds0.850718×0.515882metres. These are reported bounds, not independently verified physical room dimensions. This small test geometry explains the small input volume; the result does not validate an ordinary full-size room design or the engineering method. No automatic rescaling is justified by the log.

Not demonstrated: actual on-plan label appearance/replacement, opening/temperature edits, snapshot persistence/reopen, real pipe/hydraulic calculation, UGO import, album generation or visual quality. Separate missing historical NssEngine startup-path errors preceded successful AGPT loading.
