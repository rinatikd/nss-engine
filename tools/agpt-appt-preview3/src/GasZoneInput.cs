using System;
using System.Collections.Generic;

namespace AGPT.Shared
{
    /// <summary>Agents supported by the current calculation implementation; no physical presets.</summary>
    public static class GasAgentCatalog
    {
        public const string SupportedAgent = "HFC-227ea";

        public static IReadOnlyList<string> Options { get; } = Array.AsReadOnly(new[]
        {
            SupportedAgent
        });
    }

    public static class K4InputModes
    {
        public const string UnitMultiplier = "UNIT_MULTIPLIER";
        public const string MethodValue = "METHOD_VALUE";

        public static string Restore(string savedMode, double? savedValue)
        {
            if (savedMode == MethodValue) return MethodValue;
            if (savedMode == UnitMultiplier) return savedValue == 1 ? UnitMultiplier : null;
            if (!string.IsNullOrWhiteSpace(savedMode)) return null;
            // Legacy numeric data is displayed, not evidence of methodology approval.
            if (!savedValue.HasValue || !double.IsFinite(savedValue.Value)) return null;
            return savedValue == 1 ? UnitMultiplier : MethodValue;
        }
    }

    /// <summary>Explicit zone inputs; validation checks the prototype's input domain only.</summary>
    public sealed class GasZoneInput
    {
        public const double MinimumTemperatureC = -73.15;
        public string Name { get; set; }
        public string Gotv { get; set; }
        public double? Height { get; set; }
        public double? OpeningsArea { get; set; }
        public double? MinimumTemperature { get; set; }
        public double? Concentration { get; set; }
        public double? Density { get; set; }
        public double? K4 { get; set; }
        public double? PipeVolume { get; set; }

        public List<string> Validate()
        {
            var errors = new List<string>();
            if (string.IsNullOrWhiteSpace(Name)) errors.Add("Название зоны: укажите название.");
            if (string.IsNullOrWhiteSpace(Gotv))
                errors.Add("ГОТВ: выберите вещество.");
            else if (!string.Equals(Gotv.Trim(), GasAgentCatalog.SupportedAgent, StringComparison.Ordinal))
                errors.Add("ГОТВ: текущая расчётная методика реализована только для HFC-227ea (хладон 227ea).");

            ValidateNumber(errors, Height, "Высота H", x => x > 0, "должна быть больше 0 м.");
            ValidateNumber(errors, OpeningsArea, "Площадь проёмов FH", x => x >= 0, "должна быть не меньше 0 м².");
            // This is the existing calculation prototype's lower bound, not a normative temperature limit.
            ValidateNumber(errors, MinimumTemperature, "Минимальная температура Tм", x => x >= MinimumTemperatureC,
                "должна быть не ниже −73,15 °C (граница прототипа).");
            ValidateNumber(errors, Concentration, "Концентрация Cн", x => x > 0 && x < 100,
                "должна быть больше 0 и меньше 100 %.");
            ValidateNumber(errors, Density, "Плотность ρ₀", x => x > 0, "должна быть больше 0 кг/м³.");
            ValidateNumber(errors, K4, "Коэффициент K4", x => x > 0, "должен быть больше 0.");
            ValidateNumber(errors, PipeVolume, "Объём труб Vтр", x => x >= 0, "должен быть не меньше 0 м³.");
            return errors;
        }

        private static void ValidateNumber(List<string> errors, double? value, string field,
            Func<double, bool> withinDomain, string domainMessage)
        {
            if (!value.HasValue)
                errors.Add(field + ": укажите числовое значение.");
            else if (!double.IsFinite(value.Value))
                errors.Add(field + ": требуется конечное число.");
            else if (!withinDomain(value.Value))
                errors.Add(field + ": " + domainMessage);
        }
    }
}
