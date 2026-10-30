using System;
using System.Collections.Generic;
using AGPT.Shared;
using Xunit;

public class GasZoneInputTests
{
    private static GasZoneInput ValidInput() => new GasZoneInput
    {
        Name = "Серверная", Gotv = "HFC-227ea", Height = 3,
        OpeningsArea = 0, MinimumTemperature = 20, Concentration = 7,
        Density = 7.28, K4 = 1, PipeVolume = 0
    };

    public static IEnumerable<object[]> NumericFields()
    {
        yield return new object[] { nameof(GasZoneInput.Height), "Высота H" };
        yield return new object[] { nameof(GasZoneInput.OpeningsArea), "Площадь проёмов FH" };
        yield return new object[] { nameof(GasZoneInput.MinimumTemperature), "Минимальная температура Tм" };
        yield return new object[] { nameof(GasZoneInput.Concentration), "Концентрация Cн" };
        yield return new object[] { nameof(GasZoneInput.Density), "Плотность ρ₀" };
        yield return new object[] { nameof(GasZoneInput.K4), "Коэффициент K4" };
        yield return new object[] { nameof(GasZoneInput.PipeVolume), "Объём труб Vтр" };
    }

    [Fact]
    public void EmptyInputReportsEachRequiredField()
    {
        Assert.Equal(9, new GasZoneInput().Validate().Count);
    }

    [Theory]
    [MemberData(nameof(NumericFields))]
    public void EveryNumericFieldRejectsMissingAndNonFiniteValues(string property, string label)
    {
        foreach (double? value in new double?[] { null, double.NaN, double.PositiveInfinity, double.NegativeInfinity })
        {
            var input = ValidInput();
            typeof(GasZoneInput).GetProperty(property).SetValue(input, value);
            var error = Assert.Single(input.Validate());
            Assert.StartsWith(label + ":", error);
            Assert.Contains(value.HasValue ? "конечное число" : "укажите числовое значение", error);
        }
    }

    [Theory]
    [InlineData(nameof(GasZoneInput.Height), 0)]
    [InlineData(nameof(GasZoneInput.Height), -1)]
    [InlineData(nameof(GasZoneInput.OpeningsArea), -0.01)]
    [InlineData(nameof(GasZoneInput.MinimumTemperature), -73.1501)]
    [InlineData(nameof(GasZoneInput.Concentration), 0)]
    [InlineData(nameof(GasZoneInput.Concentration), 100)]
    [InlineData(nameof(GasZoneInput.Density), 0)]
    [InlineData(nameof(GasZoneInput.Density), -1)]
    [InlineData(nameof(GasZoneInput.K4), 0)]
    [InlineData(nameof(GasZoneInput.K4), -1)]
    [InlineData(nameof(GasZoneInput.PipeVolume), -0.01)]
    public void OutOfDomainInputReportsOneField(string property, double value)
    {
        var input = ValidInput();
        typeof(GasZoneInput).GetProperty(property).SetValue(input, value);
        Assert.Single(input.Validate());
    }

    [Fact]
    public void InclusiveAndExclusiveBoundariesAllowExplicitValidValues()
    {
        var input = ValidInput();
        input.Height = double.Epsilon;
        input.OpeningsArea = 0;
        input.MinimumTemperature = -73.15;
        input.Concentration = double.Epsilon;
        input.Density = double.Epsilon;
        input.K4 = double.Epsilon;
        input.PipeVolume = 0;
        Assert.Empty(input.Validate());
        input.Concentration = Math.BitDecrement(100);
        Assert.Empty(input.Validate());
    }

    [Fact]
    public void LargeFiniteValuesHaveNoInventedUpperBound()
    {
        var input = ValidInput();
        input.Height = input.OpeningsArea = input.MinimumTemperature = input.Density = input.K4 = input.PipeVolume = double.MaxValue;
        Assert.Empty(input.Validate());
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData(" \t ")]
    public void NameAndAgentAreRequired(string text)
    {
        var input = ValidInput();
        input.Name = input.Gotv = text;
        Assert.Equal(2, input.Validate().Count);
    }

    [Fact]
    public void CatalogContainsOnlyImplementedAgentAndNoPhysicalPresets()
    {
        Assert.Equal(new[] { "HFC-227ea" }, GasAgentCatalog.Options);
        Assert.Equal("HFC-227ea", GasAgentCatalog.SupportedAgent);
        Assert.Null(new GasZoneInput().Concentration);
        Assert.Null(new GasZoneInput().Density);
        Assert.Null(new GasZoneInput().K4);
        Assert.Null(new GasZoneInput().Gotv);
    }

    [Theory]
    [InlineData("HFC-125")]
    [InlineData("FK-5-1-12")]
    [InlineData("IG-541")]
    [InlineData("Специальное вещество по проекту")]
    public void UnsupportedAgentReportsCalculationMethodLimitation(string agent)
    {
        var input = ValidInput();
        input.Gotv = agent;
        Assert.Contains("только для HFC-227ea", Assert.Single(input.Validate()));
    }
}
