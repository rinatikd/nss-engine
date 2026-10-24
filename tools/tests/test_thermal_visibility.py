"""Synthetic visibility regressions; no project drawing inputs are required."""

import math
import unittest

from shapely.geometry import LineString, Point, Polygon

from tools.cctv.thermal_visibility import thermal_visible_sector


class ThermalVisibilityTests(unittest.TestCase):
    def assert_sampled_sight_lines_clear(self, fence, camera, sector):
        """Check retained interior points against the opaque fence interior."""
        interior = fence.buffer(-1e-5)
        xmin, ymin, xmax, ymax = sector.bounds
        tested = 0
        for ix in range(1, 51):
            for iy in range(1, 51):
                target = Point(xmin + (xmax - xmin) * ix / 51,
                               ymin + (ymax - ymin) * iy / 51)
                if sector.contains(target):
                    tested += 1
                    sight = LineString([camera, target.coords[0]])
                    self.assertLessEqual(sight.intersection(interior).length, 1e-7,
                                         f"occluded retained point: {target}")
        self.assertGreater(tested, 100)

    def test_vertex_shadow_between_uniform_rays_is_excluded(self):
        fence = Polygon([(-10, .6), (49, .6), (49, .1),
                         (51, .1), (51, 100), (-10, 100)])
        camera = (0, 0)
        self.assertAlmostEqual(fence.boundary.distance(Point(camera)), .6)
        target = Point(75, .2)
        self.assertGreater(LineString([camera, target.coords[0]]).intersection(fence).length, 2)
        sector = thermal_visible_sector(fence, *camera, aim=0)
        self.assertFalse(sector.covers(target))
        self.assertTrue(sector.covers(Point(75, -.2)))
        self.assertEqual(sector.intersection(fence).area, 0)
        self.assert_sampled_sight_lines_clear(fence, camera, sector)

    def test_convex_and_concave_corners_have_clear_retained_sight_lines(self):
        cases = [
            (Polygon([(0, 0), (20, 0), (20, 20), (0, 20)]), (-.6, 10), 0),
            (Polygon([(0, 0), (30, 0), (30, 10), (10, 10), (10, 30), (0, 30)]),
             (10.6, 20), 310),
            (Polygon([(20, .1), (23, .1), (23, 20), (20, 20)]), (0, 0), 359),
        ]
        for fence, camera, aim in cases:
            with self.subTest(camera=camera, aim=aim):
                sector = thermal_visible_sector(fence, *camera, aim=aim)
                self.assertTrue(sector.is_valid)
                self.assertFalse(sector.is_empty)
                self.assert_sampled_sight_lines_clear(fence, camera, sector)

    def test_unobstructed_range_and_fov_are_preserved(self):
        fence = Polygon([(-10, -10), (-5, -10), (-5, 10), (-10, 10)])
        sector = thermal_visible_sector(fence, 0, 0, aim=359, reach=105, fov=42.5)
        self.assertTrue(sector.covers(Point(100 * math.cos(math.radians(359)),
                                           100 * math.sin(math.radians(359)))))
        self.assertFalse(sector.covers(Point(106, 0)))
        self.assertFalse(sector.covers(Point(50, 50)))
        for px, py in sector.exterior.coords:
            self.assertLessEqual(math.hypot(px, py), 105 + 1e-9)
        # Chords approximate the range arc from inside, within 0.01% here.
        exact_area = math.radians(42.5) * 105 ** 2 / 2
        self.assertLess(sector.area, exact_area)
        self.assertGreater(sector.area, exact_area * .9999)

    def test_camera_inside_or_on_fence_is_rejected(self):
        fence = Polygon([(0, 0), (10, 0), (10, 10), (0, 10)])
        for camera in ((5, 5), (0, 5)):
            with self.subTest(camera=camera), self.assertRaises(ValueError):
                thermal_visible_sector(fence, *camera, aim=0)


if __name__ == "__main__":
    unittest.main()
