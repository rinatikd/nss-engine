using System;
using System.Collections.Generic;
using System.Text.RegularExpressions;

namespace AGPT.Shared
{
    /// <summary>Immutable data from the supplied project calculation sheet, not a universal normative profile.</summary>
    public sealed class GasAgentReferenceProfile
    {
        internal GasAgentReferenceProfile(string agent, double concentration, double vaporDensity,
            double referenceTemperatureC, double referencePressureKPa, string sourceLabel, string sourceKind)
        {
            Agent = agent;
            Concentration = concentration;
            VaporDensity = vaporDensity;
            ReferenceTemperatureC = referenceTemperatureC;
            ReferencePressureKPa = referencePressureKPa;
            SourceLabel = sourceLabel;
            SourceKind = sourceKind;
        }

        public string Agent { get; }
        /// <summary>Concentration in volume percent for the supplied project reference only.</summary>
        public double Concentration { get; }
        /// <summary>Vapor density in kg/m³ at the stated reference temperature and pressure.</summary>
        public double VaporDensity { get; }
        public double ReferenceTemperatureC { get; }
        public double ReferencePressureKPa { get; }
        public string SourceLabel { get; }
        public string SourceKind { get; }
    }

    /// <summary>Supported agents and project reference data; applicability to other materials is not established.</summary>
    public static class GasAgentCatalog
    {
        public const string SupportedAgent = "HFC-227ea";
        private static readonly Regex Hfc227eaAlias = new Regex(
            @"\A(?:HFC|Хладон)[ \t\u00a0]*(?:[-\u2010-\u2015\u2212][ \t\u00a0]*)?227[еe][аa]\z",
            RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
        private static readonly GasAgentReferenceProfile Hfc227eaReference = new GasAgentReferenceProfile(
            SupportedAgent, 7.2, 7.28, 20, 101.3,
            "Предоставленный проектный эталон: лист расчёта ГОТВ", "ProjectReference");

        public static IReadOnlyList<string> Options { get; } = Array.AsReadOnly(new[]
        {
            SupportedAgent
        });

        /// <summary>Canonicalizes only known spellings; unknown agents remain trimmed for validation.</summary>
        public static string NormalizeAgent(string agent)
        {
            string value = agent?.Trim();
            return value != null && Hfc227eaAlias.IsMatch(value) ? SupportedAgent : value;
        }

        public static GasAgentReferenceProfile GetReferenceProfile(string agent)
        {
            if (!string.Equals(NormalizeAgent(agent), SupportedAgent, StringComparison.Ordinal))
                throw new ArgumentException("Проектный профиль доступен только для HFC-227ea.", nameof(agent));
            return Hfc227eaReference;
        }
    }

    /// <summary>Internal pipe volume in m³ from measured length in metres and internal diameter in millimetres.</summary>
    public static class PipeVolumeCalculator
    {
        public static double Compute(double lengthMetres, double innerDiameterMm)
        {
            if (!double.IsFinite(lengthMetres) || lengthMetres <= 0)
                throw new ArgumentOutOfRangeException(nameof(lengthMetres), "Длина должна быть конечным положительным числом в метрах.");
            if (!double.IsFinite(innerDiameterMm) || innerDiameterMm <= 0)
                throw new ArgumentOutOfRangeException(nameof(innerDiameterMm), "Внутренний диаметр должен быть конечным положительным числом в миллиметрах.");
            var diameterMetres = innerDiameterMm / 1000;
            var volume = Math.PI / 4 * diameterMetres * diameterMetres * lengthMetres;
            if (!double.IsFinite(volume) || volume <= 0)
                throw new OverflowException("Объём трубы выходит за диапазон представимых положительных чисел.");
            return volume;
        }

        public static double Sum(IEnumerable<(double LengthMetres, double InnerDiameterMm)> segments)
        {
            if (segments == null) throw new ArgumentNullException(nameof(segments));
            double total = 0;
            foreach (var segment in segments)
            {
                total += Compute(segment.LengthMetres, segment.InnerDiameterMm);
                if (!double.IsFinite(total))
                    throw new OverflowException("Суммарный объём труб превышает диапазон конечных чисел.");
            }
            return total;
        }
    }

    /// <summary>Explicit zone inputs checked against the prototype domain and supplied project profile.</summary>
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

        public List<string> Validate()
        {
            var errors = new List<string>();
            string agent = GasAgentCatalog.NormalizeAgent(Gotv);
            if (string.IsNullOrWhiteSpace(Name)) errors.Add("Название зоны: укажите название.");
            if (string.IsNullOrWhiteSpace(Gotv))
                errors.Add("ГОТВ: выберите вещество.");
            else if (!string.Equals(agent, GasAgentCatalog.SupportedAgent, StringComparison.Ordinal))
                errors.Add("ГОТВ: текущая расчётная методика реализована только для HFC-227ea (хладон 227ea).");

            ValidateNumber(errors, Height, "Высота H", x => x > 0, "должна быть больше 0 м.");
            ValidateNumber(errors, OpeningsArea, "Площадь проёмов FH", x => x >= 0, "должна быть не меньше 0 м².");
            // This is the existing calculation prototype's lower bound, not a normative temperature limit.
            ValidateNumber(errors, MinimumTemperature, "Минимальная температура Tм", x => x >= MinimumTemperatureC,
                "должна быть не ниже −73,15 °C (граница прототипа).");
            ValidateNumber(errors, Concentration, "Концентрация Cн", x => x > 0 && x < 100,
                "должна быть больше 0 и меньше 100 %.", "примените профиль ГОТВ.");
            ValidateNumber(errors, Density, "Плотность ρ₀", x => x > 0, "должна быть больше 0 кг/м³.", "примените профиль ГОТВ.");
            if (string.Equals(agent, GasAgentCatalog.SupportedAgent, StringComparison.Ordinal))
            {
                var profile = GasAgentCatalog.GetReferenceProfile(Gotv);
                if (Concentration.HasValue && double.IsFinite(Concentration.Value) &&
                    Concentration.Value > 0 && Concentration.Value < 100 && Concentration.Value != profile.Concentration)
                    errors.Add("Концентрация Cн: используйте значение из проектного профиля HFC-227ea (7,2 % об.).");
                if (Density.HasValue && double.IsFinite(Density.Value) &&
                    Density.Value > 0 && Density.Value != profile.VaporDensity)
                    errors.Add("Плотность ρ₀: используйте значение из проектного профиля HFC-227ea (7,28 кг/м³ при +20 °C и 101,3 кПа).");
            }
            return errors;
        }

        public List<string> DescribeModelIssues()
        {
            var issues = new List<string>();
            bool knownAgent = string.Equals(GasAgentCatalog.NormalizeAgent(Gotv), GasAgentCatalog.SupportedAgent, StringComparison.Ordinal);
            foreach (string error in Validate())
            {
                if (!knownAgent && (error.StartsWith("Концентрация", StringComparison.Ordinal)
                    || error.StartsWith("Плотность", StringComparison.Ordinal))) continue;
                issues.Add(error.Replace("укажите название.", "наименование отсутствует в модели.")
                    .Replace("выберите вещество.", "вид вещества не найден в данных модели.")
                    .Replace("укажите числовое значение.", "значение не найдено в данных модели.")
                    .Replace("примените профиль ГОТВ.", "справочные данные профиля не определены."));
            }
            return issues;
        }

        private static void ValidateNumber(List<string> errors, double? value, string field,
            Func<double, bool> withinDomain, string domainMessage, string missingMessage = null)
        {
            if (!value.HasValue)
                errors.Add(field + ": " + (missingMessage ?? "укажите числовое значение."));
            else if (!double.IsFinite(value.Value))
                errors.Add(field + ": требуется конечное число.");
            else if (!withinDomain(value.Value))
                errors.Add(field + ": " + domainMessage);
        }
    }
}
