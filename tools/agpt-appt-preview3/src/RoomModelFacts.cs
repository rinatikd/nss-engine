using System;
using System.Collections.Generic;
using System.Globalization;
using AGPT.Shared;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.Geometry;

namespace AGPT.Cad
{
    public sealed class RoomFactsResult
    {
        public Dictionary<string, string> Values { get; } = new(StringComparer.Ordinal);
        public List<string> Issues { get; } = new();
    }

    /// <summary>Read explicit room attributes in ModelSpace without changing the drawing.</summary>
    public static class RoomModelFacts
    {
        public static RoomFactsResult Read(Database db, Transaction tr, Polyline boundary,
            IReadOnlyDictionary<string, string> existing)
        {
            if (db == null) throw new ArgumentNullException(nameof(db));
            if (tr == null) throw new ArgumentNullException(nameof(tr));
            if (boundary == null) throw new ArgumentNullException(nameof(boundary));
            var result = new RoomFactsResult();
            if (existing != null)
                foreach (var pair in existing) result.Values.Add(pair.Key, pair.Value);
            // Derived values are a cache, never evidence that a source still exists.
            foreach (string key in new[] { "ZONE_NAME", "H", "FH", "TM", "GOTV" })
            {
                if (result.Values.TryGetValue(key + "__SOURCE", out string savedSource)
                    && savedSource != null
                    && (savedSource.StartsWith("ModelSpace block ", StringComparison.Ordinal)
                        || savedSource.StartsWith("GeneratedIdentifier", StringComparison.Ordinal)))
                    RemoveFact(result.Values, key);
            }

            // Curves are deliberately rejected rather than flattened with an arbitrary tolerance.
            if (!TryPolygon(boundary, result.Issues, out var polygon, out double tolerance)) return result;
            var candidates = new Dictionary<string, Dictionary<string, List<string>>>(StringComparer.Ordinal);
            var invalid = new HashSet<string>(StringComparer.Ordinal);
            var table = (BlockTable)tr.GetObject(db.BlockTableId, OpenMode.ForRead);
            var source = (BlockTableRecord)tr.GetObject(table[BlockTableRecord.ModelSpace], OpenMode.ForRead);
            foreach (ObjectId id in source)
            {
                if (tr.GetObject(id, OpenMode.ForRead) is not BlockReference block
                    || AlbumOutput.IsGenerated(block)) continue;
                int location = Locate(polygon, block.Position, tolerance);
                if (location < 0) continue;
                foreach (ObjectId attributeId in block.AttributeCollection)
                {
                    if (tr.GetObject(attributeId, OpenMode.ForRead) is not AttributeReference attribute
                        || AlbumOutput.IsGenerated(attribute)) continue;
                    string key = Field(attribute.Tag);
                    if (key == null || string.IsNullOrWhiteSpace(attribute.TextString)) continue;
                    string provenance = "ModelSpace block " + block.Handle + ", attribute " + attribute.Handle + " (" + attribute.Tag + ")";
                    if (location == 0)
                    {
                        invalid.Add(key);
                        result.Issues.Add(key + ": источник на границе помещения: " + provenance + ".");
                        continue;
                    }
                    string value = Normalize(key, attribute.TextString);
                    if (value == null)
                    {
                        invalid.Add(key);
                        result.Issues.Add(key + ": некорректное исходное значение: " + provenance + ".");
                        continue;
                    }
                    if (!candidates.TryGetValue(key, out var values))
                        candidates.Add(key, values = new Dictionary<string, List<string>>(StringComparer.Ordinal));
                    if (!values.TryGetValue(value, out var sources)) values.Add(value, sources = new List<string>());
                    sources.Add(provenance);
                }
            }
            foreach (string key in invalid) RemoveFact(result.Values, key);
            foreach (var field in candidates)
            {
                if (field.Value.Count != 1)
                {
                    RemoveFact(result.Values, field.Key);
                    result.Issues.Add(field.Key + ": противоречивые значения в исходных атрибутах помещения; поле не заполнено.");
                    continue;
                }
                if (invalid.Contains(field.Key)) continue;
                foreach (var value in field.Value)
                {
                    if (Known(result.Values, field.Key)
                        && !string.Equals(Normalize(field.Key, result.Values[field.Key]), value.Key, StringComparison.Ordinal))
                    {
                        RemoveFact(result.Values, field.Key);
                        result.Issues.Add(field.Key + ": сохранённое значение противоречит исходному атрибуту помещения; поле не заполнено.");
                        continue;
                    }
                    // Preserve an equivalent explicit legacy value; adopt current source provenance.
                    if (!Known(result.Values, field.Key)) result.Values[field.Key] = value.Key;
                    string sourceKey = field.Key + "__SOURCE";
                    result.Values[sourceKey] = string.Join("; ", value.Value);
                }
            }
            return result;
        }

        private static bool Known(Dictionary<string, string> values, string key) =>
            values.TryGetValue(key, out string value) && !string.IsNullOrWhiteSpace(value);

        private static void RemoveFact(Dictionary<string, string> values, string key)
        {
            values.Remove(key);
            values.Remove(key + "__SOURCE");
        }

        // A bare H/FH/TM tag does not declare units and is never interpreted as a measurement.
        private static string Field(string tag) => tag switch
        {
            "ROOM_NAME" => "ZONE_NAME",
            "H_M" or "HEIGHT_M" => "H",
            "FH_M2" or "OPENINGS_M2" => "FH",
            "TM_C" or "MIN_TEMP_C" => "TM",
            "GOTV" => "GOTV",
            _ => null
        };

        private static string Normalize(string key, string text)
        {
            text = text.Trim();
            if (key == "ZONE_NAME") return text;
            if (key == "GOTV")
            {
                if (string.Equals(text, GasAgentCatalog.SupportedAgent, StringComparison.OrdinalIgnoreCase)
                    || string.Equals(text, "Хладон 227ea", StringComparison.OrdinalIgnoreCase))
                    return GasAgentCatalog.SupportedAgent;
                return text; // Explicit unsupported agents remain facts; downstream validation decides applicability.
            }
            if (!NumericData.TryParseFinite(text, out double number)
                || (key == "H" && number <= 0) || (key == "FH" && number < 0)) return null;
            return number.ToString("R", CultureInfo.InvariantCulture);
        }

        private static bool TryPolygon(Polyline boundary, List<string> issues,
            out List<Point3d> points, out double tolerance)
        {
            points = new List<Point3d>();
            tolerance = 0;
            if (!boundary.Closed || boundary.NumberOfVertices < 3
                || !double.IsFinite(boundary.Area) || boundary.Area <= 0
                || Math.Abs(boundary.Normal.X) > 1e-10 || Math.Abs(boundary.Normal.Y) > 1e-10)
            {
                issues.Add("Автосбор параметров: нужен замкнутый ненулевой контур в плоскости WCS XY.");
                return false;
            }
            double minX = double.PositiveInfinity, minY = double.PositiveInfinity;
            double maxX = double.NegativeInfinity, maxY = double.NegativeInfinity;
            for (int i = 0; i < boundary.NumberOfVertices; i++)
            {
                if (boundary.GetBulgeAt(i) != 0)
                {
                    issues.Add("Автосбор параметров: дуговой контур требует точной проверки; приближение не применяется.");
                    return false;
                }
                Point3d point = boundary.GetPoint3dAt(i);
                if (!double.IsFinite(point.X) || !double.IsFinite(point.Y) || !double.IsFinite(point.Z))
                {
                    issues.Add("Автосбор параметров: контур содержит неконечные координаты.");
                    return false;
                }
                points.Add(point);
                minX = Math.Min(minX, point.X); maxX = Math.Max(maxX, point.X);
                minY = Math.Min(minY, point.Y); maxY = Math.Max(maxY, point.Y);
            }
            tolerance = Math.Max(1, Math.Max(maxX - minX, maxY - minY)) * 1e-9;
            if (!double.IsFinite(tolerance))
            {
                issues.Add("Автосбор параметров: размер контура выходит за числовой диапазон.");
                return false;
            }
            for (int i = 0; i < points.Count; i++)
            {
                Point3d a = points[i], b = points[(i + 1) % points.Count];
                if (Math.Abs(a.Z - points[0].Z) > tolerance)
                {
                    issues.Add("Автосбор параметров: вершины контура должны иметь общую отметку WCS Z.");
                    return false;
                }
                if (Math.Abs(a.X - b.X) + Math.Abs(a.Y - b.Y) <= tolerance)
                {
                    issues.Add("Автосбор параметров: вырожденный сегмент контура.");
                    return false;
                }
                for (int j = i + 1; j < points.Count; j++)
                {
                    if (j == i + 1 || (i == 0 && j == points.Count - 1)) continue;
                    Point3d c = points[j], d = points[(j + 1) % points.Count];
                    if (Intersects(a, b, c, d, tolerance))
                    {
                        issues.Add("Автосбор параметров: контур пересекается или касается сам себя.");
                        return false;
                    }
                }
            }
            return true;
        }

        // -1 outside/another elevation, 0 on boundary, 1 strictly inside in the boundary's XY plane.
        private static int Locate(List<Point3d> polygon, Point3d point, double tolerance)
        {
            if (!double.IsFinite(point.X) || !double.IsFinite(point.Y) || !double.IsFinite(point.Z)
                || Math.Abs(point.Z - polygon[0].Z) > tolerance) return -1;
            bool inside = false;
            for (int i = 0; i < polygon.Count; i++)
            {
                Point3d a = polygon[i], b = polygon[(i + 1) % polygon.Count];
                if (DistanceToSegment(point, a, b) <= tolerance) return 0;
                if ((a.Y > point.Y) != (b.Y > point.Y)
                    && point.X < a.X + (b.X - a.X) * ((point.Y - a.Y) / (b.Y - a.Y))) inside = !inside;
            }
            return inside ? 1 : -1;
        }

        private static double DistanceToSegment(Point3d p, Point3d a, Point3d b)
        {
            double dx = b.X - a.X, dy = b.Y - a.Y;
            double length = Math.Sqrt(dx * dx + dy * dy);
            if (length == 0) return Math.Sqrt((p.X - a.X) * (p.X - a.X) + (p.Y - a.Y) * (p.Y - a.Y));
            double ux = dx / length, uy = dy / length;
            double along = Math.Clamp((p.X - a.X) * ux + (p.Y - a.Y) * uy, 0, length);
            double x = p.X - a.X - along * ux, y = p.Y - a.Y - along * uy;
            return Math.Sqrt(x * x + y * y);
        }

        private static bool Intersects(Point3d a, Point3d b, Point3d c, Point3d d, double tolerance)
        {
            if (DistanceToSegment(a, c, d) <= tolerance || DistanceToSegment(b, c, d) <= tolerance
                || DistanceToSegment(c, a, b) <= tolerance || DistanceToSegment(d, a, b) <= tolerance) return true;
            static double Cross(Point3d p, Point3d q, Point3d r) =>
                (q.X - p.X) * (r.Y - p.Y) - (q.Y - p.Y) * (r.X - p.X);
            double abC = Cross(a, b, c), abD = Cross(a, b, d), cdA = Cross(c, d, a), cdB = Cross(c, d, b);
            return ((abC > 0 && abD < 0) || (abC < 0 && abD > 0))
                && ((cdA > 0 && cdB < 0) || (cdA < 0 && cdB > 0));
        }
    }
}
