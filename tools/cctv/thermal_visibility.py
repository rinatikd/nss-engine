"""Planar thermal visibility, independent of project files and CAD applications.

Fence vertices are angular visibility events: uniformly spaced rays alone can
join a clear ray to an obstructed ray and incorrectly fill the shadow between
them. Include each event and rays immediately on either side before joining
the nearest intersections. Range arcs remain polygonal approximations, and a
small setback keeps the result conservative at fence intersections. This is
not a height, terrain, or detection-performance calculation.
"""

import math

from shapely.geometry import LineString, Point, Polygon


def thermal_visible_sector(fence, x, y, aim, reach=105, fov=42.5):
    """Return an exterior, fence-occluded FOV polygon; distances are in metres.

    ``fence`` must be a valid Polygon and the camera must be strictly outside
    it. ``aim`` and ``fov`` are degrees; the supported FOV is between 0 and 180
    degrees. The range arc uses at least 87 samples, augmented by vertex rays.
    Vertex-side rays differ by 1e-7 radians and hits stop 1 mm before the fence;
    these are numerical tolerances, not an exact-area visibility guarantee.
    """
    if not isinstance(fence, Polygon) or fence.is_empty or not fence.is_valid:
        raise ValueError("fence must be a nonempty valid Polygon")
    if not all(math.isfinite(v) for v in (x, y, aim, reach, fov)):
        raise ValueError("camera coordinates and FOV parameters must be finite")
    if reach <= 0 or not 0 < fov < 180:
        raise ValueError("reach must be positive and FOV must be between 0 and 180 degrees")
    origin = Point(x, y)
    if fence.covers(origin):
        raise ValueError("camera must be strictly outside the fence")

    heading = math.radians(aim % 360)
    half = math.radians(fov / 2)
    angles = {-half + 2 * half * k / 86 for k in range(87)}
    epsilon = 1e-7
    for ring in (fence.exterior, *fence.interiors):
        for vx, vy, *_ in ring.coords:
            bearing = math.atan2(vy - y, vx - x)
            relative = (bearing - heading + math.pi) % (2 * math.pi) - math.pi
            for delta in (-epsilon, 0.0, epsilon):
                angle = relative + delta
                if -half < angle < half:
                    angles.add(angle)

    def distances(geometry):
        if geometry.is_empty:
            return
        if hasattr(geometry, "geoms"):
            for part in geometry.geoms:
                yield from distances(part)
        else:
            for px, py, *_ in geometry.coords:
                yield math.hypot(px - x, py - y)

    boundary = fence.boundary
    points = [(x, y)]
    for angle in sorted(angles):
        direction = heading + angle
        dx, dy = math.cos(direction), math.sin(direction)
        end = (x + reach * dx, y + reach * dy)
        hit = LineString([(x, y), end]).intersection(boundary)
        nearest = min(distances(hit), default=None)
        if nearest is not None:
            distance = max(0.0, nearest - .001)
            end = (x + distance * dx, y + distance * dy)
        points.append(end)
    sector = Polygon(points)
    if not sector.is_valid:
        sector = sector.buffer(0)
    return sector.difference(fence)
