using System;

namespace AGPT.Shared
{
    public static class RoomOpeningsPolicy
    {
        // User-configured project assumption, not a normative value.
        public const double DefaultAreaM2 = 0.011;
        public const string DefaultSource = "UserConfiguredDefaultOpenings0011M2";

        public static double? Resolve(double? explicitValue, bool hasUnresolvedSource)
        {
            if (hasUnresolvedSource) return null;
            if (!explicitValue.HasValue) return DefaultAreaM2;
            if (!double.IsFinite(explicitValue.Value) || explicitValue.Value < 0)
                throw new ArgumentException("Площадь открытых проёмов должна быть конечной и неотрицательной.", nameof(explicitValue));
            return explicitValue.Value;
        }
    }
}
