using System;
using AGPT.Shared;
using Xunit;

public class RoomOpeningsPolicyTests
{
    [Fact]
    public void MissingOpeningsAreaUsesUsersProjectDefaultInSquareMetres()
    {
        Assert.Equal(0.011, RoomOpeningsPolicy.DefaultAreaM2);
        Assert.Equal(0.011, RoomOpeningsPolicy.Resolve(null, false));
    }

    [Theory]
    [InlineData(0)]
    [InlineData(0.05)]
    public void ExplicitValidAreaOverridesDefaultWithoutAlteration(double value)
    {
        Assert.Equal(value, RoomOpeningsPolicy.Resolve(value, false));
    }

    [Fact]
    public void DefaultSourceIdentifiesUserConfiguredOpeningsArea()
    {
        Assert.Equal("UserConfiguredDefaultOpenings0011M2", RoomOpeningsPolicy.DefaultSource);
    }

    [Theory]
    [InlineData(double.NaN)]
    [InlineData(double.PositiveInfinity)]
    [InlineData(double.NegativeInfinity)]
    [InlineData(-0.001)]
    public void InvalidExistingAreaIsRejectedWithoutDefaultFallback(double value)
    {
        Assert.Throws<ArgumentException>(() => RoomOpeningsPolicy.Resolve(value, false));
    }

    [Theory]
    [InlineData(null)]
    [InlineData(0d)]
    [InlineData(0.05)]
    [InlineData(double.NaN)]
    [InlineData(double.PositiveInfinity)]
    [InlineData(-0.001)]
    public void UnresolvedOrContradictorySourceCannotAcquireADefault(double? value)
    {
        Assert.Null(RoomOpeningsPolicy.Resolve(value, true));
    }
}
