using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text.RegularExpressions;

namespace AGPT.Shared
{
    public sealed class RoomTextFactsResult
    {
        public Dictionary<string, string> Values { get; } = new(StringComparer.Ordinal);
        public HashSet<string> InvalidFields { get; } = new(StringComparer.Ordinal);
        public List<string> Issues { get; } = new();
    }

    /// <summary>Reads complete explicitly labelled lines; unlabelled text supplies no facts.</summary>
    public static class RoomTextFacts
    {
        private const RegexOptions Options = RegexOptions.IgnoreCase | RegexOptions.CultureInvariant;
        private const string Number = @"[+-]?(?:\d+(?:[.,]\d*)?|[.,]\d+)(?:[eE][+-]?\d+)?";
        private static readonly Regex Label = new(
            @"^\s*(?<label>Высота помещения|Минимальная температура|Площадь про[её]мов|HEIGHT_M|OPENINGS_M2|ROOM_NAME|Помещение|TM_C|Tmin|ГОТВ|FH|H)(?=\s|:|=|$)\s*(?:[:=]\s*)?(?<value>.*?)\s*$", Options);
        private static readonly Regex Height = new(@"^(?<number>" + Number + @")\s*(?<unit>мм|mm|см|cm|м|m)$", Options);
        private static readonly Regex Temperature = new(@"^(?<number>" + Number + @")\s*°\s*[CС]$", Options);
        private static readonly Regex Area = new(@"^(?<number>" + Number + @")\s*[мm](?:²|2)$", Options);
        private static readonly Regex Scalar = new(@"^(?<number>" + Number + @")$", Options);

        public static RoomTextFactsResult Parse(string text)
        {
            var result = new RoomTextFactsResult();
            if (string.IsNullOrWhiteSpace(text)) return result;
            foreach (string line in text.Replace(@"\P", "\n").Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries))
            {
                Match match = Label.Match(line);
                if (!match.Success) continue;
                string label = match.Groups["label"].Value;
                string raw = match.Groups["value"].Value.Trim();
                string key = Field(label);
                string value = Normalize(key, label, raw);
                if (value == null)
                {
                    Invalidate(result, key, "некорректное значение или отсутствуют явные единицы измерения.");
                    continue;
                }
                if (result.InvalidFields.Contains(key)) continue;
                if (result.Values.TryGetValue(key, out string previous) && !string.Equals(previous, value, StringComparison.Ordinal))
                    Invalidate(result, key, "противоречивые значения в тексте помещения.");
                else result.Values[key] = value;
            }
            return result;
        }

        private static string Field(string label)
        {
            if (label.Equals("H", StringComparison.OrdinalIgnoreCase) || label.Equals("HEIGHT_M", StringComparison.OrdinalIgnoreCase)
                || label.Equals("Высота помещения", StringComparison.OrdinalIgnoreCase)) return "H";
            if (label.Equals("TM_C", StringComparison.OrdinalIgnoreCase) || label.Equals("Tmin", StringComparison.OrdinalIgnoreCase)
                || label.Equals("Минимальная температура", StringComparison.OrdinalIgnoreCase)) return "TM";
            if (label.Equals("ГОТВ", StringComparison.OrdinalIgnoreCase)) return "GOTV";
            if (label.Equals("Помещение", StringComparison.OrdinalIgnoreCase) || label.Equals("ROOM_NAME", StringComparison.OrdinalIgnoreCase)) return "ZONE_NAME";
            return "FH";
        }

        private static string Normalize(string key, string label, string raw)
        {
            if (raw.Length == 0) return null;
            if (key == "ZONE_NAME") return raw;
            if (key == "GOTV")
            {
                if (raw.Equals(GasAgentCatalog.SupportedAgent, StringComparison.OrdinalIgnoreCase)
                    || Regex.IsMatch(raw, @"^Хладон\s*227[еe][аa]$", Options)) return GasAgentCatalog.SupportedAgent;
                return raw;
            }
            bool unitInLabel = label.Equals("HEIGHT_M", StringComparison.OrdinalIgnoreCase)
                || label.Equals("OPENINGS_M2", StringComparison.OrdinalIgnoreCase)
                || label.Equals("TM_C", StringComparison.OrdinalIgnoreCase);
            Match measure = (unitInLabel ? Scalar : key == "H" ? Height : key == "TM" ? Temperature : Area).Match(raw);
            if (!measure.Success || !double.TryParse(measure.Groups["number"].Value.Replace(',', '.'), NumberStyles.Float,
                CultureInfo.InvariantCulture, out double number) || !double.IsFinite(number)) return null;
            if (key == "H" && !unitInLabel)
            {
                string unit = measure.Groups["unit"].Value;
                if (unit.Equals("mm", StringComparison.OrdinalIgnoreCase) || unit.Equals("мм", StringComparison.OrdinalIgnoreCase)) number /= 1000;
                if (unit.Equals("cm", StringComparison.OrdinalIgnoreCase) || unit.Equals("см", StringComparison.OrdinalIgnoreCase)) number /= 100;
            }
            if (!double.IsFinite(number) || (key == "H" && number <= 0) || (key == "FH" && number < 0)
                || (key == "TM" && number < GasZoneInput.MinimumTemperatureC)) return null;
            return (number == 0 ? 0 : number).ToString("R", CultureInfo.InvariantCulture);
        }

        private static void Invalidate(RoomTextFactsResult result, string key, string reason)
        {
            result.Values.Remove(key);
            result.InvalidFields.Add(key);
            result.Issues.Add(key + ": " + reason);
        }
    }
}
