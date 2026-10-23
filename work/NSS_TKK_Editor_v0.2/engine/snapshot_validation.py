"""Validate the worker boundary before constructing GEOS or graph objects."""
import math


def _identity(value, label):
    if not isinstance(value, str) or not value or len(value) > 180:
        raise ValueError(f"{label}: expected a non-empty identity of at most 180 characters")
    if value.startswith(("END:", "ENTRY:")):
        raise ValueError(f"{label}: reserved identity prefix")


def _point(value, label):
    if not isinstance(value, (list, tuple)) or len(value) not in (2, 3):
        raise ValueError(f"{label}: expected XY or XYZ coordinates")
    if any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) for v in value):
        raise ValueError(f"{label}: coordinates must be finite numbers")


def validate_snapshot(data):
    if not isinstance(data, dict):
        raise ValueError("Snapshot must be an object")
    for field in ("wells", "routes"):
        if not isinstance(data.get(field), list):
            raise ValueError(f"{field}: expected an array")
        if len(data[field]) > 50000:
            raise ValueError(f"{field}: snapshot limit exceeded (50000)")
        identities = set()
        for item in data[field]:
            if not isinstance(item, dict):
                raise ValueError(f"{field}: expected objects")
            key = item.get("id")
            _identity(key, field)
            if key in identities:
                raise ValueError(f"Duplicate {field} identity: {key}")
            identities.add(key)
            if field == "wells":
                _point(item.get("xyz"), f"Well {key}")
                radius = item.get("radius", .315)
                if isinstance(radius, bool) or not isinstance(radius, (int, float)) or not math.isfinite(radius) or radius <= 0:
                    raise ValueError(f"Well {key}: radius must be positive and finite")
                if not isinstance(item.get("description", "") or "", str):
                    raise ValueError(f"Well {key}: description must be text")
            else:
                points = item.get("points")
                if not isinstance(points, list) or not 2 <= len(points) <= 100000:
                    raise ValueError(f"Route {key}: expected 2..100000 points")
                for point in points:
                    _point(point, f"Route {key}")
                if sum(math.dist(a[:2], b[:2]) for a, b in zip(points, points[1:])) < .005:
                    raise ValueError(f"Route {key}: length is below the 0.005 m resolution")
    protected = data.get("protected", {})
    if not isinstance(protected, dict):
        raise ValueError("protected: expected an identity-to-number object")
    numbers = set()
    for key, number in protected.items():
        _identity(key, "protected")
        if isinstance(number, bool) or not isinstance(number, int) or not 1 <= number <= 2147483647:
            raise ValueError(f"Protected well {key}: number must be a positive integer")
        if number in numbers:
            raise ValueError(f"Duplicate protected number: {number}")
        numbers.add(number)
    if set(w["id"] for w in data["wells"]) & set(r["id"] for r in data["routes"]):
        raise ValueError("Well and route identities must be distinct")
