using System;
using System.Collections.Generic;
using AGPT.Shared;
using Xunit;

public class GasZoneInputTests
{
    private static GasZoneInput ValidInput() => new GasZoneInput
    {
        Name = "Серверная", Gotv = "HFC-227ea", Height = 3,
        OpeningsArea = 0, MinimumTemperature = 20, Concentration = 7.2,
        Density = 7.28
    };

    public static IEnumerable<object[]> NumericFields()
    {
        yield return new object[] { nameof(GasZoneInput.Height), "Высота H" };
        yield return new object[] { nameof(GasZoneInput.OpeningsArea), "Площадь проёмов FH" };
        yield return new object[] { nameof(GasZoneInput.MinimumTemperature), "Минимальная температура Tм" };
        yield return new object[] { nameof(GasZoneInput.Concentration), "Концентрация Cн" };
        yield return new object[] { nameof(GasZoneInput.Density), "Плотность ρ₀" };
    }

    [Fact]
    public void EmptyInputReportsEachRequiredField()
    {
        Assert.Equal(7, new GasZoneInput().Validate().Count);
    }

    [Fact]
    public void ZoneCreationHasNoManualK4OrPipeVolumeInputs()
    {
        Assert.Null(typeof(GasZoneInput).GetProperty("K4"));
        Assert.Null(typeof(GasZoneInput).GetProperty("PipeVolume"));
        Assert.Empty(ValidInput().Validate());
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
            bool referenceField = property == nameof(GasZoneInput.Concentration) || property == nameof(GasZoneInput.Density);
            Assert.Contains(value.HasValue ? "конечное число" : referenceField ? "примените профиль" : "укажите числовое значение", error);
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
    public void OutOfDomainInputReportsOneField(string property, double value)
    {
        var input = ValidInput();
        typeof(GasZoneInput).GetProperty(property).SetValue(input, value);
        Assert.DoesNotContain("проектного профиля", Assert.Single(input.Validate()));
    }

    [Fact]
    public void InclusiveAndExclusiveBoundariesAllowExplicitValidValues()
    {
        var input = ValidInput();
        input.Height = double.Epsilon;
        input.OpeningsArea = 0;
        input.MinimumTemperature = -73.15;
        Assert.Empty(input.Validate());
    }

    [Fact]
    public void LargeFiniteValuesHaveNoInventedUpperBound()
    {
        var input = ValidInput();
        input.Height = input.OpeningsArea = input.MinimumTemperature = double.MaxValue;
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
    public void CatalogContainsOnlyImplementedAgentAndDoesNotDefaultZoneInputs()
    {
        Assert.Equal(new[] { "HFC-227ea" }, GasAgentCatalog.Options);
        Assert.Equal("HFC-227ea", GasAgentCatalog.SupportedAgent);
        Assert.Null(new GasZoneInput().Concentration);
        Assert.Null(new GasZoneInput().Density);
        Assert.Null(new GasZoneInput().Gotv);
    }

    [Fact]
    public void ReferenceProfilePreservesExactProjectDataAndProvenance()
    {
        var profile = GasAgentCatalog.GetReferenceProfile("HFC-227ea");
        Assert.Equal("HFC-227ea", profile.Agent);
        Assert.Equal(7.2, profile.Concentration);
        Assert.Equal(7.28, profile.VaporDensity);
        Assert.Equal(20, profile.ReferenceTemperatureC);
        Assert.Equal(101.3, profile.ReferencePressureKPa);
        Assert.Equal("Предоставленный проектный эталон: лист расчёта ГОТВ", profile.SourceLabel);
        Assert.Equal("ProjectReference", profile.SourceKind);
        Assert.Same(profile, GasAgentCatalog.GetReferenceProfile(" HFC-227ea "));
    }

    [Fact]
    public void ReferenceProfileIsSealedAndHasOnlyReadOnlyProperties()
    {
        var profile = GasAgentCatalog.GetReferenceProfile("HFC-227ea");
        Assert.True(profile.GetType().IsSealed);
        Assert.Empty(profile.GetType().GetConstructors());
        Assert.All(profile.GetType().GetProperties(), property => Assert.False(property.CanWrite));
        Assert.Throws<NotSupportedException>(() => ((IList<string>)GasAgentCatalog.Options)[0] = "HFC-125");
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("HFC-125")]
    [InlineData("hfc-227ea")]
    public void ReferenceProfileRejectsUnsupportedAgent(string agent)
    {
        Assert.Throws<ArgumentException>(() => GasAgentCatalog.GetReferenceProfile(agent));
    }

    [Theory]
    [InlineData(nameof(GasZoneInput.Concentration), 7)]
    [InlineData(nameof(GasZoneInput.Concentration), double.Epsilon)]
    [InlineData(nameof(GasZoneInput.Concentration), 99.99999999999999)]
    [InlineData(nameof(GasZoneInput.Density), 7.2)]
    [InlineData(nameof(GasZoneInput.Density), double.Epsilon)]
    [InlineData(nameof(GasZoneInput.Density), double.MaxValue)]
    public void FiniteInDomainManualValuesMustMatchReferenceProfile(string property, double value)
    {
        var input = ValidInput();
        typeof(GasZoneInput).GetProperty(property).SetValue(input, value);
        var error = Assert.Single(input.Validate());
        Assert.Contains("используйте значение из проектного профиля HFC-227ea", error);
    }

    [Fact]
    public void ProfileMatchingDoesNotSilentlyRoundNearbyValues()
    {
        var profile = GasAgentCatalog.GetReferenceProfile("HFC-227ea");
        foreach (var value in new[] { Math.BitDecrement(profile.Concentration), Math.BitIncrement(profile.Concentration) })
        {
            var input = ValidInput();
            input.Concentration = value;
            Assert.Contains("проектного профиля", Assert.Single(input.Validate()));
        }
        foreach (var value in new[] { Math.BitDecrement(profile.VaporDensity), Math.BitIncrement(profile.VaporDensity) })
        {
            var input = ValidInput();
            input.Density = value;
            Assert.Contains("проектного профиля", Assert.Single(input.Validate()));
        }
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

public class PipeVolumeCalculatorTests
{
    [Fact]
    public void InternalDiameterInMillimetresAndLengthInMetresProduceCubicMetres()
    {
        Assert.Equal(0.003141592653589793, PipeVolumeCalculator.Compute(10, 20), 15);
        Assert.Equal(Math.PI / 4, PipeVolumeCalculator.Compute(1, 1000), 15);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-1)]
    [InlineData(double.NaN)]
    [InlineData(double.PositiveInfinity)]
    [InlineData(double.NegativeInfinity)]
    public void SegmentDimensionsMustBeFiniteAndPositive(double value)
    {
        Assert.Throws<ArgumentOutOfRangeException>(() => PipeVolumeCalculator.Compute(value, 20));
        Assert.Throws<ArgumentOutOfRangeException>(() => PipeVolumeCalculator.Compute(10, value));
    }

    [Fact]
    public void SegmentOverflowIsRejected()
    {
        Assert.Throws<OverflowException>(() => PipeVolumeCalculator.Compute(double.MaxValue, double.MaxValue));
        Assert.Throws<OverflowException>(() => PipeVolumeCalculator.Compute(1, double.Epsilon));
    }

    [Fact]
    public void SumUsesEachSegmentsActualInternalDiameter()
    {
        Assert.Equal(0.00471238898038469,
            PipeVolumeCalculator.Sum(new[] { (10.0, 20.0), (5.0, 20.0) }), 15);
        Assert.Equal(0, PipeVolumeCalculator.Sum(Array.Empty<(double, double)>()));
    }

    [Fact]
    public void SumRejectsMissingSegmentsInvalidDimensionsAndTotalOverflow()
    {
        Assert.Throws<ArgumentNullException>(() => PipeVolumeCalculator.Sum(null));
        Assert.Throws<ArgumentOutOfRangeException>(() => PipeVolumeCalculator.Sum(new[] { (1.0, 20.0), (-1.0, 20.0) }));
        Assert.Throws<OverflowException>(() => PipeVolumeCalculator.Sum(new[]
        {
            (1e308, 1000.0), (1e308, 1000.0), (1e308, 1000.0)
        }));
    }
}
