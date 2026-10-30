using System;
using System.Globalization;
using System.Collections.Generic;
using System.IO;
using System.Linq;

namespace AGPT.Shared
{
    // Host-independent input contract shared by the CAD commands and regression tests.
    public static class NumericData
    {
        public static bool TryParseFinite(string text, out double value)
        {
            value = 0;
            if (string.IsNullOrWhiteSpace(text)) return false;
            return double.TryParse(text.Trim().Replace(',', '.'),
                       NumberStyles.Float, CultureInfo.InvariantCulture, out value)
                   && double.IsFinite(value);
        }

        public static double ParseOrDefault(string text, double fallback = 0)
        {
            if (!double.IsFinite(fallback))
                throw new ArgumentOutOfRangeException(nameof(fallback));
            if (string.IsNullOrWhiteSpace(text)) return fallback;
            if (TryParseFinite(text, out var value)) return value;
            throw new FormatException("Invalid numeric XData: expected a finite decimal number.");
        }

        public static double ParseRequired(string text)
        {
            if (TryParseFinite(text, out var value)) return value;
            throw new FormatException("A finite numeric value is required; missing values cannot use a default.");
        }

        public static string Format(double value)
        {
            if (!double.IsFinite(value))
                throw new ArgumentOutOfRangeException(nameof(value));
            return value.ToString("R", CultureInfo.InvariantCulture);
        }
    }

    public static class ZoneIdentity
    {
        public static bool IsZone(string kind, string actualLayer, string expectedZoneLayer,
                                  string name, string volumeText)
        {
            if (!string.IsNullOrEmpty(kind) &&
                !string.Equals(kind, "ZONE", StringComparison.Ordinal)) return false;
            return !string.IsNullOrWhiteSpace(expectedZoneLayer)
                && string.Equals(actualLayer, expectedZoneLayer, StringComparison.OrdinalIgnoreCase)
                && !string.IsNullOrWhiteSpace(name)
                && NumericData.TryParseFinite(volumeText, out var volume) && volume > 0;
        }
    }

    public static class PlanUnits
    {
        private static void RequirePositive(double value, string name)
        {
            if (!double.IsFinite(value) || value <= 0)
                throw new ArgumentOutOfRangeException(name, "Expected a finite positive value.");
        }

        public static double LengthInMetres(double length, double metresPerUnit)
        {
            RequirePositive(length, nameof(length));
            RequirePositive(metresPerUnit, nameof(metresPerUnit));
            double result = length * metresPerUnit;
            RequirePositive(result, nameof(length));
            return result;
        }

        public static double RectangleVolume(double width, double length,
                                             double heightMetres, double metresPerUnit)
        {
            RequirePositive(heightMetres, nameof(heightMetres));
            double result = LengthInMetres(width, metresPerUnit)
                          * LengthInMetres(length, metresPerUnit) * heightMetres;
            RequirePositive(result, nameof(width));
            return result;
        }

        public static double AreaVolume(double areaDrawingUnits, double heightMetres, double metresPerUnit)
        {
            RequirePositive(areaDrawingUnits, nameof(areaDrawingUnits));
            RequirePositive(heightMetres, nameof(heightMetres));
            RequirePositive(metresPerUnit, nameof(metresPerUnit));
            double result = areaDrawingUnits * metresPerUnit * metresPerUnit * heightMetres;
            RequirePositive(result, nameof(areaDrawingUnits));
            return result;
        }
    }

    public static class ResourceLocator
    {
        public static string FindBlockFile(string assemblyDirectory, params string[] names)
        {
            if (string.IsNullOrWhiteSpace(assemblyDirectory)) return null;
            foreach (var directory in new[] {
                Path.Combine(assemblyDirectory, "blocks"),
                Path.Combine(assemblyDirectory, "..", "blocks"),
                Path.Combine(assemblyDirectory, "..", "..", "blocks") })
            foreach (var name in names)
            {
                if (string.IsNullOrWhiteSpace(name) || Path.GetFileName(name) != name)
                    throw new ArgumentException("Resource names must be file names.", nameof(names));
                string candidate = Path.GetFullPath(Path.Combine(directory, name));
                if (File.Exists(candidate)) return candidate;
            }
            return null;
        }
    }

    public sealed class BillItem
    {
        public string Name { get; }
        public string Mark { get; }
        public string Unit { get; }
        public string Note { get; }
        public double Quantity { get; internal set; }

        internal BillItem(string name, string mark, string unit, string note)
        { Name = name; Mark = mark; Unit = unit; Note = note; }
    }

    public sealed class BillOfMaterials
    {
        private readonly Dictionary<(string, string, string, string), BillItem> items = new();

        public void Add(string name, string mark, string unit, double quantity, string note = "")
        {
            if (string.IsNullOrWhiteSpace(name) || string.IsNullOrWhiteSpace(unit))
                throw new ArgumentException("An item needs a name and unit.");
            if (!double.IsFinite(quantity) || quantity <= 0)
                throw new ArgumentOutOfRangeException(nameof(quantity));
            var key = (name.Trim(), (mark ?? "").Trim(), unit.Trim(), (note ?? "").Trim());
            items.TryGetValue(key, out var item);
            double total = (item?.Quantity ?? 0) + quantity;
            if (!double.IsFinite(total)) throw new ArgumentOutOfRangeException(nameof(quantity));
            if (item == null)
            {
                item = new BillItem(key.Item1, key.Item2, key.Item3, key.Item4);
                items.Add(key, item);
            }
            item.Quantity = total;
        }

        public IReadOnlyList<BillItem> Rows => items.Values
            .OrderBy(x => x.Name, StringComparer.Ordinal)
            .ThenBy(x => x.Mark, StringComparer.Ordinal)
            .ThenBy(x => x.Unit, StringComparer.Ordinal)
            .ThenBy(x => x.Note, StringComparer.Ordinal).ToArray();
    }
}
