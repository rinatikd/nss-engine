using System;
using AGPT.Shared;
using Xunit;

public class RoomTemperaturePolicyTests
{
    [Fact]
    public void MissingTemperatureUsesUsersTwentyDegreeDefault()
    {
        Assert.Equal(20, RoomTemperaturePolicy.DefaultC);
        Assert.Equal(20, RoomTemperaturePolicy.Resolve(null, false));
    }

    [Theory]
    [InlineData(-73.15)]
    [InlineData(-10)]
    [InlineData(0)]
    [InlineData(18)]
    [InlineData(20)]
    [InlineData(35.5)]
    public void ExplicitValidTemperatureOverridesDefaultWithoutAlteration(double value)
    {
        Assert.Equal(value, RoomTemperaturePolicy.Resolve(value, false));
    }

    [Fact]
    public void DefaultSourceCanBeDistinguishedFromDrawingOrExplicitInput()
    {
        Assert.Equal("UserConfiguredDefault20C", RoomTemperaturePolicy.DefaultSource);
        Assert.NotEqual("Default", RoomTemperaturePolicy.DefaultSource);
        Assert.NotEqual("Drawing", RoomTemperaturePolicy.DefaultSource);
    }

    [Theory]
    [InlineData(double.NaN)]
    [InlineData(double.PositiveInfinity)]
    [InlineData(double.NegativeInfinity)]
    [InlineData(-73.15001)]
    [InlineData(-100)]
    public void InvalidExistingTemperatureIsRejectedWithoutDefaultFallback(double value)
    {
        Assert.Throws<ArgumentException>(() => RoomTemperaturePolicy.Resolve(value, false));
    }

    [Theory]
    [InlineData(null)]
    [InlineData(18d)]
    [InlineData(20d)]
    [InlineData(double.NaN)]
    public void UnresolvedOrContradictorySourceCannotAcquireADefault(double? value)
    {
        Assert.Null(RoomTemperaturePolicy.Resolve(value, true));
    }
}
