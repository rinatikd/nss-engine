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
