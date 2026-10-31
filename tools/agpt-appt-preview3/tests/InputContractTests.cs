using System;
using System.Globalization;
using AGPT.Shared;
using Xunit;

public class InputContractTests
{
    [Theory]
    [InlineData("ru-RU")]
    [InlineData("en-US")]
    [InlineData("kk-KZ")]
    [InlineData("de-DE")]
    public void DecimalInputAndRoundTripAreIndependentOfWindowsCulture(string culture)
    {
        var old = CultureInfo.CurrentCulture;
        try
        {
            CultureInfo.CurrentCulture = CultureInfo.GetCultureInfo(culture);
            Assert.Equal(7.28, NumericData.ParseOrDefault("7.28"));
            Assert.Equal(7.28, NumericData.ParseOrDefault("7,28"));
            Assert.Equal(0.00119, NumericData.ParseOrDefault("0,00119"));
            Assert.Equal(1200, NumericData.ParseOrDefault("1.2e3"));
            Assert.Equal(7.28, NumericData.ParseOrDefault(NumericData.Format(7.28)));
        }
        finally { CultureInfo.CurrentCulture = old; }
    }

    [Theory]
    [InlineData("NaN")]
    [InlineData("Infinity")]
    [InlineData("-Infinity")]
    [InlineData("1e9999")]
    [InlineData("1.234,56")]
    [InlineData("not a number")]
    public void CorruptPresentValuesCannotBecomePlausibleDefaults(string text)
    {
        Assert.False(NumericData.TryParseFinite(text, out _));
        Assert.Throws<FormatException>(() => NumericData.ParseOrDefault(text, 28.5));
    }

    [Fact]
    public void MissingOptionalValueUsesExplicitFallback()
    {
        Assert.Equal(28.5, NumericData.ParseOrDefault(null, 28.5));
        Assert.Equal(0, NumericData.ParseOrDefault(""));
    }

    [Fact]
    public void ModulesWithZoneNamesAreNotAdditionalZones()
    {
        int zones = 0;
        if (ZoneIdentity.IsZone("ZONE", "AGPT-ZONE", "AGPT-ZONE", "Room 1", "150")) zones++;
        if (ZoneIdentity.IsZone("MODULE", "AGPT-EQ", "AGPT-ZONE", "Room 1", "150")) zones++;
        if (ZoneIdentity.IsZone("MODULE", "AGPT-ZONE", "AGPT-ZONE", "Room 1", "150")) zones++;
        Assert.Equal(1, zones);
    }

    [Theory]
    [InlineData(null, "AGPT-ZONE", "Room", "150", true)]
    [InlineData("", "agpt-zone", "Room", "150", true)]
    [InlineData("ZONE", "APPT-ZONE", "Room", "150", false)]
    [InlineData("NOZZLE", "AGPT-ZONE", "Room", "150", false)]
    [InlineData(null, "AGPT-EQ", "Room", "150", false)]
    [InlineData("ZONE", "AGPT-ZONE", "Room", "NaN", false)]
    [InlineData("ZONE", "AGPT-ZONE", "Room", "0", false)]
    [InlineData("ZONE", "AGPT-ZONE", "", "150", false)]
    public void ZoneIdentitySeparatesSystemsAndLegacyEquipment(
        string kind, string layer, string name, string volume, bool expected)
    {
        Assert.Equal(expected, ZoneIdentity.IsZone(kind, layer, "AGPT-ZONE", name, volume));
    }

    [Theory]
    [InlineData(5000, 10000, 0.001)]
    [InlineData(500, 1000, 0.01)]
    [InlineData(5, 10, 1)]
    public void SameRoomInMillimetresCentimetresAndMetresHasSameVolume(
        double width, double length, double metresPerUnit)
    {
        Assert.Equal(150, PlanUnits.RectangleVolume(width, length, 3, metresPerUnit), 10);
        Assert.Equal(5, PlanUnits.LengthInMetres(width, metresPerUnit), 10);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-1)]
    [InlineData(double.NaN)]
    [InlineData(double.PositiveInfinity)]
    public void InvalidGeometryIsRejectedBeforeEngineeringCalculation(double width)
    {
        Assert.Throws<ArgumentOutOfRangeException>(() => PlanUnits.RectangleVolume(width, 10, 3, 1));
    }

    [Fact]
    public void ConversionRejectsOverflowAndUnknownScale()
    {
        Assert.Throws<ArgumentOutOfRangeException>(() => PlanUnits.RectangleVolume(double.MaxValue, 10, 3, 1));
        Assert.Throws<ArgumentOutOfRangeException>(() => PlanUnits.RectangleVolume(5, 10, 3, 0));
    }
}
