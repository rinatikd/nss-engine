using System;
using AGPT.Shared;
using Xunit;

public class RequiredProjectInputTests
{
    [Theory]
    [InlineData("70", 70)]
    [InlineData("1,2", 1.2)]
    [InlineData("0.011", .011)]
    public void RequiredZoneInputsAreReadWithoutNonFiniteSentinelFallback(string input, double expected)
    {
        Assert.Equal(expected, NumericData.ParseRequired(input));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData(" ")]
    [InlineData("NaN")]
    [InlineData("Infinity")]
    [InlineData("not numeric")]
    public void MissingOrDamagedMandatoryFieldStopsCalculation(string input)
    {
        Assert.Throws<FormatException>(() => NumericData.ParseRequired(input));
    }

    [Theory]
    [InlineData(50000000, .001)]
    [InlineData(500000, .01)]
    [InlineData(50, 1)]
    public void ActualPolylineAreaProducesSameRoomVolumeInEachSupportedUnit(double area, double scale)
    {
        Assert.Equal(150, PlanUnits.AreaVolume(area, 3, scale), 9);
    }
}
