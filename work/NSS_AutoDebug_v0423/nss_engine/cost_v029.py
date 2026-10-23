"""Conceptual quantities and cost estimate; all inputs engineer-supplied, no normative defaults."""
from dataclasses import dataclass, asdict
from math import isfinite, hypot
from typing import Sequence


@dataclass(frozen=True)
class ConstructionInputs:
    trench_width_m: float
    trench_depth_m: float
    pipe_count: int
    well_count: int
    excavation_rate_per_m3: float
    backfill_rate_per_m3: float
    pipe_rate_per_m: float
    well_rate_each: float
    special_crossings_count: int = 0
    special_crossing_rate_each: float = 0.0
    spoil_fraction: float = 0.0
    spoil_disposal_rate_per_m3: float = 0.0
    contingency_fraction: float = 0.0
    currency: str = "KZT"


def _nonnegative(name, value):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not isfinite(value) or value < 0:
        raise ValueError(f"{name} must be finite and nonnegative")


def _validate(config):
    for name, value in asdict(config).items():
        if name == "currency":
            if not isinstance(value, str) or not value.strip():
                raise ValueError("currency must be a nonempty string")
        elif name in ("pipe_count", "well_count", "special_crossings_count"):
            _nonnegative(name, value)
            if not isinstance(value, int) or isinstance(value, bool):
                raise ValueError(f"{name} must be integer")
        else:
            _nonnegative(name, value)
    if config.trench_width_m == 0 or config.trench_depth_m == 0 or config.pipe_count == 0:
        raise ValueError("trench width/depth and pipe count must be positive")
    if config.spoil_fraction > 1 or config.contingency_fraction > 1:
        raise ValueError("fractions must not exceed 1")


def route_length(points: Sequence[tuple[float,float]]) -> float:
    if len(points) < 2:
        raise ValueError("route requires at least two points")
    total = 0.0
    for p, q in zip(points, points[1:]):
        if len(p) != 2 or len(q) != 2:
            raise ValueError("XY points required")
        for v in (*p, *q):
            if isinstance(v, bool) or not isinstance(v, (int,float)) or not isfinite(v):
                raise ValueError("route coordinates must be finite")
        total += hypot(q[0]-p[0], q[1]-p[1])
    if total == 0:
        raise ValueError("route length must be positive")
    return total


def estimate(points, config: ConstructionInputs):
    _validate(config)
    length = route_length(points)
    excavation = length * config.trench_width_m * config.trench_depth_m
    spoil = excavation * config.spoil_fraction
    backfill = excavation - spoil  # Simplified: ignores bedding, pipes, settlement and bulking.
    pipe_length = length * config.pipe_count
    costs = {
        "excavation": excavation * config.excavation_rate_per_m3,
        "backfill": backfill * config.backfill_rate_per_m3,
        "spoil_disposal": spoil * config.spoil_disposal_rate_per_m3,
        "pipes": pipe_length * config.pipe_rate_per_m,
        "wells": config.well_count * config.well_rate_each,
        "special_crossings": config.special_crossings_count * config.special_crossing_rate_each,
    }
    subtotal = sum(costs.values())
    contingency = subtotal * config.contingency_fraction
    return {
        "status": "conceptual_estimate", "currency": config.currency,
        "quantities": {"route_length_m": length, "excavation_m3": excavation,
                       "backfill_m3": backfill, "spoil_m3": spoil,
                       "pipe_length_m": pipe_length, "well_count": config.well_count,
                       "special_crossings_count": config.special_crossings_count},
        "costs": costs, "subtotal": subtotal, "contingency": contingency,
        "total": subtotal + contingency,
        "cost_per_route_m": (subtotal + contingency) / length,
        "assumptions": ["constant rectangular trench cross-section",
            "no soil classes, shoring, groundwater, bedding, pavement reinstatement or VAT",
            "backfill is conceptual excavation minus spoil fraction; not a physical material balance",
            "special crossings are fixed-price allowances; not engineered HDD estimates",
            "all prices, geometry and quantities must be verified by an engineer"],
    }


def compare_estimates(routes, config_by_route):
    """routes: mapping of name -> XY points; configs: mapping of name -> ConstructionInputs."""
    if not routes:
        raise ValueError("at least one route required")
    if set(routes) != set(config_by_route):
        raise ValueError("route/config keys must match")
    results = {name: estimate(points, config_by_route[name]) for name, points in routes.items()}
    currencies = {item["currency"] for item in results.values()}
    if len(currencies) != 1:
        raise ValueError("cannot compare different currencies")
    ranking = sorted(results, key=lambda name: (results[name]["total"], name))
    return {"estimates": results, "ranking_lowest_cost_first": ranking,
            "note": "Ranking is indicative only; excludes unpriced construction risks."}
