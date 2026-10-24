# SEC-01: quoted passphrases in repository checks

Base: origin/main79a53fec612b80c1c6cf3afff6c39931f5939675, fetched2026-10-24.

The generic credential-assignment check previously discarded every quoted value containing a space. A synthetic password phrase therefore passed even though the equivalent value without spaces was flagged. Whitespace inside a quoted literal is now reviewed by the same assignment check. Recognized placeholder markers and the existing expression-marker exclusions remain unchanged. JSON/artifact restrictions are unchanged.

The initial observation came from Qwen's QWEN-01 text review and was independently reproduced locally. Its proposed diff was not applied: implementation here changes only the space exclusion. The guard remains heuristic; this does not establish that all credential formats or expressions are detected.

## Verification

- Seven stdlib integration tests in tools/test_repo_guard.py create disposable Git repositories, stage synthetic data and run the actual guard as a subprocess. They cover a phrase with spaces, ordinary assignments, placeholders, expression markers, staged versus unstaged content, committed trees versus current indexes, unchanged artifact/JSON handling, and value redaction.
- Against the unchanged source, exactly three tests fail: phrase detection and its staged/tree variants. The remaining four control tests pass. Against this implementation all seven pass.
- tools/run_portable_checks.py now includes the guard suite. All80 local tests pass:7guard +37editor +9CCTV +27diagnostics. The existing private-fixture omission remains. TEMP/TMP pointed into a dedicated task directory; no real credentials, drawings or network-dependent model calls used.
- Local Python/ezdxf/networkx differ from pinned clean-CI versions. Local environment already has Shapely; main's requirements-test.txt still lacks the dependency addressed by existing PR1. This branch does not duplicate that pending fix. Clean CI must be rechecked after that dependency is integrated/rebased; no fresh successful CI is claimed.
- Required graphify update . was attempted, but graphify is not installed in PATH in this environment. No graph exists in this clean worktree; no graph update is claimed or dump committed.

AutoCAD/Revit and private engineering fixtures were not run; this change concerns repository checks only. No merge to main or final project acceptance is implied. Independent code review and integration belong to the primary PC. Additional placeholder/format gaps remain separate work rather than being silently included in this fix.
