using System;

namespace AGPT.Shared
{
    public static class RoomTemperaturePolicy
    {
        public const double DefaultC = 18;
        public const string DefaultSource = "UserConfiguredDefault18C";

        public static double? Resolve(double? explicitValue, bool hasUnresolvedSource)
        {
            if (hasUnresolvedSource) return null;
            if (!explicitValue.HasValue) return DefaultC;
            if (!double.IsFinite(explicitValue.Value) || explicitValue.Value < GasZoneInput.MinimumTemperatureC)
                throw new ArgumentException("Минимальная температура должна быть конечной и не ниже допустимой границы.", nameof(explicitValue));
            return explicitValue.Value;
        }
    }
}
