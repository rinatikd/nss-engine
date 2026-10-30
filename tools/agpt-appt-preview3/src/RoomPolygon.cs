using System;
using System.Collections.Generic;

namespace AGPT.Shared
{
    /// <summary>Validates a new room boundary made from straight, horizontally coplanar corners.</summary>
    public static class RoomPolygon
    {
        // Coordinates are translated and normalized before geometric predicates.
        // Features closer than this relative tolerance are rejected conservatively.
        private const double Tolerance = 1e-12;

        public static void Validate(IReadOnlyList<PlanVertex> vertices)
        {
            if (vertices == null || vertices.Count < 3)
                throw new ArgumentException("Укажите не менее трёх углов помещения.", nameof(vertices));

            var local = new PlanVertex[vertices.Count];
            PlanVertex origin = vertices[0];
            double scale = 0;
            for (int i = 0; i < vertices.Count; i++)
            {
                PlanVertex p = vertices[i];
                if (!p.IsFinite || p.Bulge != 0 || p.Z != origin.Z)
                    throw new ArgumentException("Углы должны быть конечными точками одной горизонтальной плоскости, без дуг.", nameof(vertices));
                double x = p.X - origin.X, y = p.Y - origin.Y;
                if (!double.IsFinite(x) || !double.IsFinite(y))
                    throw new ArgumentException("Переполнение координат контура.", nameof(vertices));
                local[i] = new PlanVertex(x, y);
                scale = Math.Max(scale, Math.Max(Math.Abs(x), Math.Abs(y)));
            }
            if (scale <= 0) throw new ArgumentException("Контур должен иметь ненулевые стороны.", nameof(vertices));
            for (int i = 0; i < local.Length; i++)
                local[i] = new PlanVertex(local[i].X / scale, local[i].Y / scale);

            for (int i = 0; i < local.Length; i++)
                for (int j = i + 1; j < local.Length; j++)
                    if (Math.Abs(local[i].X - local[j].X) <= Tolerance && Math.Abs(local[i].Y - local[j].Y) <= Tolerance)
                        throw new ArgumentException("Углы контура не должны совпадать.", nameof(vertices));

            double twiceArea = 0, compensation = 0;
            for (int i = 0; i < local.Length; i++)
            {
                PlanVertex a = local[i], b = local[(i + 1) % local.Length], c = local[(i + 2) % local.Length];
                // Consecutive collinear edges may continue straight, but cannot retrace each other.
                if (Math.Abs(Cross(a, b, c)) <= Tolerance
                    && (a.X - b.X) * (c.X - b.X) + (a.Y - b.Y) * (c.Y - b.Y) > Tolerance)
                    throw new ArgumentException("Стороны контура не должны накладываться.", nameof(vertices));
                double term = a.X * b.Y - b.X * a.Y - compensation;
                double sum = twiceArea + term;
                compensation = (sum - twiceArea) - term;
                twiceArea = sum;
                for (int j = i + 1; j < local.Length; j++)
                {
                    if (j == i + 1 || (i == 0 && j == local.Length - 1)) continue;
                    if (Intersects(a, b, local[j], local[(j + 1) % local.Length]))
                        throw new ArgumentException("Стороны контура не должны пересекаться или касаться.", nameof(vertices));
                }
            }
            double area = Math.Abs(twiceArea / 2) * scale * scale;
            if (!double.IsFinite(twiceArea) || Math.Abs(twiceArea) <= Tolerance || !double.IsFinite(area) || area <= 0)
                throw new ArgumentException("Площадь контура должна быть конечной и положительной.", nameof(vertices));
        }

        private static double Cross(PlanVertex a, PlanVertex b, PlanVertex c)
        {
            double value = (b.X - a.X) * (c.Y - a.Y) - (b.Y - a.Y) * (c.X - a.X);
            if (!double.IsFinite(value)) throw new ArgumentException("Переполнение при проверке контура.");
            return value;
        }

        private static bool OnSegment(PlanVertex a, PlanVertex b, PlanVertex p) =>
            p.X >= Math.Min(a.X, b.X) - Tolerance && p.X <= Math.Max(a.X, b.X) + Tolerance
            && p.Y >= Math.Min(a.Y, b.Y) - Tolerance && p.Y <= Math.Max(a.Y, b.Y) + Tolerance;

        private static bool Intersects(PlanVertex a, PlanVertex b, PlanVertex c, PlanVertex d)
        {
            double abc = Cross(a, b, c), abd = Cross(a, b, d), cda = Cross(c, d, a), cdb = Cross(c, d, b);
            if ((Math.Abs(abc) <= Tolerance && OnSegment(a, b, c))
                || (Math.Abs(abd) <= Tolerance && OnSegment(a, b, d))
                || (Math.Abs(cda) <= Tolerance && OnSegment(c, d, a))
                || (Math.Abs(cdb) <= Tolerance && OnSegment(c, d, b))) return true;
            return ((abc > Tolerance && abd < -Tolerance) || (abc < -Tolerance && abd > Tolerance))
                && ((cda > Tolerance && cdb < -Tolerance) || (cda < -Tolerance && cdb > Tolerance));
        }
    }
}
