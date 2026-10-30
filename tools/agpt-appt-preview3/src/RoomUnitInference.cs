using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.RegularExpressions;

namespace AGPT.Shared
{
    public enum RoomUnitConfidence { Declared, DimensionEvidence, Heuristic, Ambiguous }

    public sealed class RoomUnitSuggestion
    {
        public double MetresPerUnit { get; }
        public string UnitName { get; }
        public RoomUnitConfidence Confidence { get; }
        public bool IsVerified { get; }
        public string Reason { get; }

        internal RoomUnitSuggestion(double scale, RoomUnitConfidence confidence, bool verified, string reason)
        {
            MetresPerUnit = scale;
            UnitName = scale == .001 ? "мм" : scale == .01 ? "см" : "м";
            Confidence = confidence;
            IsVerified = verified;
            Reason = reason;
        }
    }

    /// <summary>Proposes room units without changing drawing settings. Bounds alone never verify scale.</summary>
    public static class RoomUnitInference
    {
        private static readonly double[] Scales = { .001, .01, 1 };
        private static readonly Regex DimensionLabel = new Regex(
            @"\A\s*(?<value><>|[+-]?(?:\d+(?:[.,]\d*)?|[.,]\d+))\s*(?<unit>мм|см|м|mm|cm|m)\s*\z",
            RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

        /// <summary>Reads only dimension labels with explicit supported units; bare numbers are not scale evidence.</summary>
        public static bool TryScaleFromDimensionLabel(string text, double measurement, double linearFactor, out double scale)
        {
            scale = 0;
            if (string.IsNullOrWhiteSpace(text) || text.Length > 256) return false;
            Match match = DimensionLabel.Match(text);
            if (!match.Success) return false;
            string unit = match.Groups["unit"].Value.ToLowerInvariant();
            double unitScale = unit == "мм" || unit == "mm" ? .001 : unit == "см" || unit == "cm" ? .01 : 1;
            double candidate;
            if (match.Groups["value"].Value == "<>")
            {
                if (!double.IsFinite(linearFactor) || linearFactor <= 0) return false;
                candidate = linearFactor * unitScale;
            }
            else
            {
                if (!double.IsFinite(measurement) || measurement <= 0
                    || !double.TryParse(match.Groups["value"].Value.Replace(',', '.'), NumberStyles.Float,
                        CultureInfo.InvariantCulture, out double displayed)
                    || !double.IsFinite(displayed) || displayed <= 0) return false;
                candidate = displayed / measurement * unitScale;
            }
            return TrySupportedScale(candidate, out scale);
        }

        public static RoomUnitSuggestion Suggest(double widthNative, double heightNative, double? declaredScale,
            IEnumerable<double> explicitDimensionScales = null)
        {
            if (!double.IsFinite(widthNative) || widthNative <= 0)
                throw new ArgumentException("Ширина должна быть конечной и положительной.", nameof(widthNative));
            if (!double.IsFinite(heightNative) || heightNative <= 0)
                throw new ArgumentException("Высота должна быть конечной и положительной.", nameof(heightNative));

            double? declared = declaredScale.HasValue ? SupportedScale(declaredScale.Value, nameof(declaredScale)) : null;
            var dimensions = (explicitDimensionScales ?? Array.Empty<double>())
                .Select(value => SupportedScale(value, nameof(explicitDimensionScales))).Distinct().ToArray();
            var ranked = Scales.OrderBy(scale => Score(widthNative, heightNative, scale)).ToArray();
            double proposed = ranked[0];

            if (dimensions.Length > 1 || (declared.HasValue && dimensions.Length == 1 && declared.Value != dimensions[0]))
                return new RoomUnitSuggestion(proposed, RoomUnitConfidence.Ambiguous, false,
                    "Данные о единицах противоречат друг другу. Предложение по габаритам предварительное; масштаб не подтверждён.");

            if (declared.HasValue)
                return new RoomUnitSuggestion(declared.Value, RoomUnitConfidence.Declared, true,
                    "Масштаб подтверждён объявленными единицами чертежа.");

            if (dimensions.Length == 1)
                return new RoomUnitSuggestion(dimensions[0], RoomUnitConfidence.DimensionEvidence, true,
                    "Масштаб подтверждён согласованными размерными данными.");

            int plausibleCount = Scales.Count(scale => IsRoomSized(widthNative, heightNative, scale));
            bool unique = plausibleCount == 1;
            return new RoomUnitSuggestion(proposed, unique ? RoomUnitConfidence.Heuristic : RoomUnitConfidence.Ambiguous, false,
                unique
                    ? "Единицы предложены по вероятным габаритам помещения. Это предварительная оценка; масштаб не подтверждён данными."
                    : "По одним габаритам единицы неоднозначны. Предложение предварительное; масштаб не подтверждён данными.");
        }

        private static double SupportedScale(double value, string parameter)
        {
            if (TrySupportedScale(value, out double scale)) return scale;
            throw new ArgumentException("Поддерживаются только положительные конечные масштабы мм, см и м.", parameter);
        }

        private static bool TrySupportedScale(double value, out double result)
        {
            result = 0;
            if (double.IsFinite(value) && value > 0)
                foreach (double scale in Scales)
                    if (Math.Abs(value / scale - 1) <= 1e-6) { result = scale; return true; }
            return false;
        }

        private static bool IsRoomSized(double width, double height, double scale)
        {
            double a = width * scale, b = height * scale;
            return a >= 2 && a <= 30 && b >= 2 && b <= 30 && Math.Max(a, b) / Math.Min(a, b) <= 20;
        }

        private static double Score(double width, double height, double scale)
        {
            // Work in logarithms so even extreme finite extents cannot overflow the ranking.
            double a = Math.Log(width) + Math.Log(scale), b = Math.Log(height) + Math.Log(scale);
            double min = Math.Log(2), max = Math.Log(30), typical = Math.Log(8);
            double Outside(double side) => Math.Max(min - side, 0) + Math.Max(side - max, 0);
            return 10 * (Outside(a) + Outside(b)) + Math.Abs(a - typical) + Math.Abs(b - typical);
        }
    }
}
