"""Central fail-closed gate for paid model API calls.

This staging release has a zero paid-API budget. Environment variables and CLI
flags cannot enable paid calls; a future policy change must be an explicit
source review and release decision.
"""

PAID_API_ALLOWED = False


def require_paid_api_allowed() -> None:
    # This release has no runtime opt-in path. Changing flags, environment
    # variables, or the public constant must not turn a live request on.
    raise PermissionError("Paid model API calls are disabled by project policy")
