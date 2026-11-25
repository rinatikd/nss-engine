# TKK topology regression cycle 0055

Baseline: `ac6eb0495307506c1bb80b0d5389af06944ef18a` (`main`). The TKK editor and AutoDebug remain separate packages: `work/NSS_TKK_Editor_v0.2` is the AutoCAD 2026 / .NET 8 editor, while `work/NSS_AutoDebug_v0423` is the independent v0.42.3 diagnostic tool.

## Current data path

1. `TkkEditor.Capture()` scans modelspace entities on the supported route and well layers. It gives route and well records their DXF entity handle as `id`.
2. Routes are limited to `Line`, `Arc`, or `Polyline` on `RouteLayers`; wells are circles or block references on `WellLayers`, plus the existing `НСС` / `ккс-2` reference case. `Center()` currently searches a block definition for a direct `Circle` or `Ellipse`.
3. `AnalysisWorker` writes an immutable snapshot, starts the Python worker with isolated interpreter flags, and validates the returned job/fingerprint and annotation contract before application.
4. `snapshot_validation.py` validates finite XY/XYZ coordinates, identities, and route lengths. `tkk_editor_core.analyze()` uses XY only to cut route edges at registered wells and construct a graph. It does not join two crossing route handles automatically. `diagnostics.py` locates issues and writes worker-local JSON/Markdown reports.

The local AutoCAD adapter is the DXF-to-snapshot boundary; the Python worker receives JSON, not a DWG/DXF document. Therefore worker tests alone do not validate actual AutoCAD entity extraction, block attribute conventions, or modelspace/block traversal.

AutoDebug is a separate pipeline and does not share these TKK records. Its older `nss_engine.analyzer` models a segment as `(handle, a: XY, b: XY, layer)` and a well as `(handle, point: XY)`; findings bind one or more handles to a planar point. Its v0.42 exporter instead retains top-level entity `handle`, `layer`, `type`, XYZ `vertices`, polyline `bulges`, `closed`, `block_name`, `attributes`, extrusion `normal`, and `is_xref`. `SnapshotContractV042` validates this entity schema and unique handles. The offline DXF audit explicitly does not expand blocks/Xrefs; the native exporter has a separate attribute transfer check. These schemas and test outcomes must not be treated as interchangeable with TKK editor's `routes`/`wells` snapshot.

## Regression gap reproduced and addressed

Before the patch, all of these synthetic snapshots returned `phase=READY` without a corresponding warning:

- a route with a repeated consecutive XY vertex (a zero XY segment);
- two distinct well handles only 4 mm apart;
- a self-crossing route whose non-adjacent segments intersect at XY `(5, 5)`.

The worker now reports `ZERO_LENGTH_SEGMENT`, `WELL_SPACING_BELOW_RESOLUTION`, and `SELF_INTERSECTION`. Reports keep source handle IDs and local XY bounds/points. These diagnostics do not mutate geometry, connect graph nodes, or claim a standards violation. The close-well tolerance (default 0.005 m) and zero-XY tolerance (default 1e-12 m) are explicit keyword parameters and are emitted in the diagnostic summary. A dense close-well cluster caps pair details at 10,000 and emits `WELL_PAIR_REVIEW_LIMIT`.

Z remains outside topology: a segment with no XY length is reported even if its Z differs, and routes crossing in XY remain separate graphs when their Z values differ. This is intentional, explicit 2D behavior; it is not a 3D clearance or over/underpass analysis. The existing TKK worker labels WCS coordinates/distances as meters, but the current `Capture()` path does not independently validate `$INSUNITS`; the numeric thresholds inherit that assumption and are not standards-derived.

## Existing DXF block coverage

`tools/cctv/tkk_integrity.py` fingerprints reachable nested BLOCK definitions for the separate CCTV save/read path. Portable tests cover nested INSERT traversal, changed nested primitives, missing nested definitions, unchanged DXF save/read, and mutation after save/read. This does not establish TKK editor block-attribute validation. The editor source has no declared required attribute tag/value schema, and its direct-child `Center()` lookup does not descend through nested INSERTs. Missing/wrong attribute semantics and nested well-center extraction therefore remain **BLOCKED pending an explicit block/attribute contract and a native adapter test**; AutoDebug v0.42 attribute preservation is independent evidence only. No attribute requirements were invented in this patch.

`tests/test_dxf_roundtrip.py` builds a small synthetic R2010 DXF with route LINEs and well CIRCLEs, maps the fixture to the TKK worker's JSON contract, saves/reloads it, and verifies stable handles, spans, and warnings. The fixture checks crossing routes at different Z values remain separate; it is not an integration test of the AutoCAD `.NET` `Capture()` implementation.

## Verification boundary

Source-only verification on Python 3.12 with the pinned test dependencies: portable runner **112 PASS, 0 FAIL, 1 SKIP** (the private-fixture test is intentionally omitted). AutoCAD NETLOAD, private DWG/DXF inputs, native extension behavior, actual entity handles from a production drawing, and Kazakhstan normative clauses are outside this source-only pass. No standard distances are asserted. No production drawing was opened or modified.
