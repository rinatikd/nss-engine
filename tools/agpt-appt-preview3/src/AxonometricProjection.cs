using System;
using System.Collections.Generic;
using System.Linq;

namespace AGPT.Shared
{
    /// <summary>Unit-independent isometric projection of source XYZ; no inferred elevations.</summary>
    public sealed class AxonometricProjection
    {
        private PlanVertex anchor;
        private double minimumX, minimumY, originX, originY;
        public double Factor { get; private set; }

        private PlanVertex Iso(PlanVertex p)
        {
            if (!p.IsFinite) throw new ArgumentException("Finite source coordinates are required.");
            var v = new PlanVertex((p.X - anchor.X - (p.Y - anchor.Y)) * Math.Sqrt(3) / 2,
                ((p.X - anchor.X) + (p.Y - anchor.Y)) / 2 + (p.Z - anchor.Z));
            if (!v.IsFinite) throw new ArgumentException("Projection overflow.");
            return v;
        }

        public PlanVertex Project(PlanVertex p)
        {
            var v = Iso(p);
            var result = new PlanVertex(originX + (v.X - minimumX) * Factor,
                originY + (v.Y - minimumY) * Factor);
            if (!result.IsFinite) throw new ArgumentException("Paper coordinate overflow.");
            return result;
        }

        public static AxonometricProjection Fit(IEnumerable<PlanVertex> points,
            double x, double y, double width, double height)
        {
            if (points == null) throw new ArgumentNullException(nameof(points));
            if (!double.IsFinite(x) || !double.IsFinite(y) || !double.IsFinite(width)
                || !double.IsFinite(height) || width <= 0 || height <= 0
                || !double.IsFinite(x + width) || !double.IsFinite(y + height))
                throw new ArgumentException("Finite positive paper rectangle is required.");
            var source = points.ToArray();
            if (source.Length == 0) throw new ArgumentException("Source geometry is required.");
            var view = new AxonometricProjection { anchor = source[0] };
            var projected = source.Select(view.Iso).ToArray();
            view.minimumX = projected.Min(p => p.X);
            view.minimumY = projected.Min(p => p.Y);
            double spanX = projected.Max(p => p.X) - view.minimumX;
            double spanY = projected.Max(p => p.Y) - view.minimumY;
            view.Factor = Math.Min(width / Math.Max(spanX, 1e-9), height / Math.Max(spanY, 1e-9));
            if (!double.IsFinite(view.Factor) || view.Factor <= 0)
                throw new ArgumentException("Source extents cannot be fitted.");
            view.originX = x + (width - spanX * view.Factor) / 2;
            view.originY = y + (height - spanY * view.Factor) / 2;
            foreach (var p in source) view.Project(p);
            return view;
        }

        public static bool IsPlanar(IEnumerable<PlanVertex> points)
        {
            if (points == null) throw new ArgumentNullException(nameof(points));
            var source = points.ToArray();
            if (source.Length == 0 || source.Any(p => !p.IsFinite))
                throw new ArgumentException("Finite source geometry is required.");
            double minimum = source.Min(p => p.Z), maximum = source.Max(p => p.Z);
            return maximum - minimum <= 1e-8;
        }

        public static List<PlanVertex> Sample(PlanRoute route)
        {
            if (route == null) throw new ArgumentNullException(nameof(route));
            if (route.Vertices.Count < 2 || route.Vertices.Any(p => !p.IsFinite))
                throw new ArgumentException("нет конечных координат трассы.");
            var result = new List<PlanVertex> { route.Vertices[0] };
            int segments = route.Closed ? route.Vertices.Count : route.Vertices.Count - 1;
            for (int i = 0; i < segments; i++)
            {
                var a = route.Vertices[i];
                var b = route.Vertices[(i + 1) % route.Vertices.Count];
                if (Math.Abs(a.Bulge) < 1e-12) { result.Add(b); continue; }
                double dx = b.X - a.X, dy = b.Y - a.Y;
                double offset = (1 - a.Bulge * a.Bulge) / (4 * a.Bulge);
                double cx = a.X + dx / 2 - dy * offset, cy = a.Y + dy / 2 + dx * offset;
                double radius = Math.Sqrt((a.X - cx) * (a.X - cx) + (a.Y - cy) * (a.Y - cy));
                if (!double.IsFinite(radius) || radius <= 0 || Math.Abs(a.Z - b.Z) > 1e-8)
                    throw new ArgumentException("некорректная плоская дуга Polyline.");
                double start = Math.Atan2(a.Y - cy, a.X - cx), sweep = 4 * Math.Atan(a.Bulge);
                int steps = Math.Max(2, (int)Math.Ceiling(Math.Abs(sweep) / (Math.PI / 180)));
                for (int step = 1; step < steps; step++)
                {
                    double angle = start + sweep * step / steps;
                    var p = new PlanVertex(cx + radius * Math.Cos(angle), cy + radius * Math.Sin(angle), a.Z);
                    if (!p.IsFinite) throw new ArgumentException("переполнение координат дуги.");
                    result.Add(p);
                }
                result.Add(b);
            }
            return result;
        }

        public static PlanVertex Midpoint(List<PlanVertex> points)
        {
            if (points == null) throw new ArgumentNullException(nameof(points));
            if (points.Count == 0 || points.Any(p => !p.IsFinite))
                throw new ArgumentException("Finite source geometry is required.");
            double Distance(PlanVertex a, PlanVertex b) => Math.Sqrt(Math.Pow(a.X - b.X, 2)
                + Math.Pow(a.Y - b.Y, 2) + Math.Pow(a.Z - b.Z, 2));
            double half = 0;
            for (int i = 1; i < points.Count; i++) half += Distance(points[i - 1], points[i]) / 2;
            for (int i = 1; i < points.Count; i++)
            {
                double length = Distance(points[i - 1], points[i]);
                if (half <= length && length > 0)
                {
                    double t = half / length;
                    var a = points[i - 1]; var b = points[i];
                    return new PlanVertex(a.X + (b.X - a.X) * t, a.Y + (b.Y - a.Y) * t, a.Z + (b.Z - a.Z) * t);
                }
                half -= length;
            }
            return points[0];
        }
    }
}
