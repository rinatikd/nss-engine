using System;
using AGPT.Shared;
using Xunit;

public class RoomUnitInferenceTests
{
    [Theory]
    [InlineData("<> мм", 9800, 1, .001)]
    [InlineData("<> см", 9800, 1, .01)]
    [InlineData("<> м", 9800, 1, 1)]
    [InlineData("<> mm", 9800, 1000, 1)]
    [InlineData("  <> CM  ", double.NaN, .1, .001)]
    [InlineData("9800 мм", 9800, double.NaN, .001)]
    [InlineData("980 cm", 9800, -1, .001)]
    [InlineData("9,8 м", 9800, 1, .001)]
    [InlineData("9.8 M", 9.8, 1, 1)]
    [InlineData("+6m", 600, 1, .01)]
    public void ExplicitDimensionUnitsProduceTestableScaleEvidence(string label, double measurement, double factor, double expected)
    {
        Assert.True(RoomUnitInference.TryScaleFromDimensionLabel(label, measurement, factor, out double scale));
        Assert.Equal(expected, scale);
    }

    [Theory]
    [InlineData(null, 9800, 1)]
    [InlineData("", 9800, 1)]
    [InlineData("9800", 9800, 1)]
    [InlineData("<>", 9800, 1)]
    [InlineData("9800 ft", 9800, 1)]
    [InlineData("<> feet", 9800, 1)]
    [InlineData("ширина 9800 мм", 9800, 1)]
    [InlineData("9800 мм ± 5", 9800, 1)]
    [InlineData("9800 мм / 980 см", 9800, 1)]
    [InlineData("-9800 мм", 9800, 1)]
    [InlineData("0 мм", 9800, 1)]
    [InlineData("9800 мм", 0, 1)]
    [InlineData("9800 мм", -1, 1)]
    [InlineData("9800 мм", double.NaN, 1)]
    [InlineData("9800 мм", double.PositiveInfinity, 1)]
    [InlineData("9800 мм", 1e-320, 1)]
    [InlineData("<> мм", 9800, 0)]
    [InlineData("<> мм", 9800, -1)]
    [InlineData("<> мм", 9800, double.NaN)]
    [InlineData("<> мм", 9800, double.PositiveInfinity)]
    [InlineData("<> м", 9800, double.MaxValue)]
    [InlineData("1 м", 2, 1)]
    [InlineData("<> м", 9800, .0254)]
    public void UnqualifiedConflictingOrInvalidLabelsAreNotEvidence(string label, double measurement, double factor)
    {
        Assert.False(RoomUnitInference.TryScaleFromDimensionLabel(label, measurement, factor, out double scale));
        Assert.Equal(0, scale);
    }

    [Fact]
    public void OversizedNumericLabelsAreRejectedWithoutParsingOverflow()
    {
        Assert.False(RoomUnitInference.TryScaleFromDimensionLabel(new string('9', 400) + " мм", 1, 1, out _));
    }

    [Theory]
    [InlineData(9800, 6000, .001, "мм")]
    [InlineData(980, 600, .01, "см")]
    [InlineData(9.8, 6, 1, "м")]
    public void TypicalRoomSuggestsUnitsWithoutClaimingProof(double width, double height, double scale, string name)
    {
        var result = RoomUnitInference.Suggest(width, height, null);
        Assert.Equal(scale, result.MetresPerUnit);
        Assert.Equal(name, result.UnitName);
        Assert.Equal(RoomUnitConfidence.Heuristic, result.Confidence);
        Assert.False(result.IsVerified);
        Assert.NotEmpty(result.Reason);
    }

    [Theory]
    [InlineData(.001)]
    [InlineData(.01)]
    [InlineData(1)]
    public void DeclarationAllowsDifferentPhysicalInterpretationsOfIdenticalGeometry(double scale)
    {
        var result = RoomUnitInference.Suggest(9800, 6000, scale);
        Assert.Equal(scale, result.MetresPerUnit);
        Assert.Equal(RoomUnitConfidence.Declared, result.Confidence);
        Assert.True(result.IsVerified);
    }

    [Fact]
    public void ConsistentDimensionsVerifyScaleEvenWhenRoomHeuristicWouldChooseAnother()
    {
        var result = RoomUnitInference.Suggest(9800, 6000, null, new[] { .01, .01 });
        Assert.Equal(.01, result.MetresPerUnit);
        Assert.Equal(RoomUnitConfidence.DimensionEvidence, result.Confidence);
        Assert.True(result.IsVerified);
    }

    [Theory]
    [InlineData(null, .001, .01)]
    [InlineData(.001, .01, .01)]
    [InlineData(.001, .001, 1)]
    public void ConflictingEvidenceNeverProducesVerifiedScale(double? declared, double a, double b)
    {
        var result = RoomUnitInference.Suggest(9800, 6000, declared, new[] { a, b });
        Assert.Equal(RoomUnitConfidence.Ambiguous, result.Confidence);
        Assert.False(result.IsVerified);
        Assert.Contains("противоречат", result.Reason);
    }

    [Fact]
    public void MatchingDeclarationAndDimensionsAreVerified()
    {
        var result = RoomUnitInference.Suggest(9800, 6000, .001, new[] { .001, .001 });
        Assert.Equal(RoomUnitConfidence.Declared, result.Confidence);
        Assert.True(result.IsVerified);
    }

    [Theory]
    [InlineData(2000, 2000)]
    [InlineData(1000000, 1000000)]
    [InlineData(1e308, 1e308)]
    [InlineData(1e-300, 1e-300)]
    public void AmbiguousOrExtremeBoundsStillOfferOnlyAnUnverifiedProposal(double width, double height)
    {
        var result = RoomUnitInference.Suggest(width, height, null);
        Assert.Equal(RoomUnitConfidence.Ambiguous, result.Confidence);
        Assert.False(result.IsVerified);
        Assert.Contains(result.MetresPerUnit, new[] { .001, .01, 1 });
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-1)]
    [InlineData(double.NaN)]
    [InlineData(double.PositiveInfinity)]
    [InlineData(double.NegativeInfinity)]
    public void InvalidExtentsAreRejected(double value)
    {
        Assert.Throws<ArgumentException>(() => RoomUnitInference.Suggest(value, 6000, null));
        Assert.Throws<ArgumentException>(() => RoomUnitInference.Suggest(9800, value, null));
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-1)]
    [InlineData(.0254)]
    [InlineData(double.NaN)]
    [InlineData(double.PositiveInfinity)]
    public void InvalidOrUnsupportedEvidenceCannotBeSilentlyIgnored(double scale)
    {
        Assert.Throws<ArgumentException>(() => RoomUnitInference.Suggest(9800, 6000, scale));
        Assert.Throws<ArgumentException>(() => RoomUnitInference.Suggest(9800, 6000, null, new[] { scale }));
        Assert.Throws<ArgumentException>(() => RoomUnitInference.Suggest(9800, 6000, .001, new[] { .001, scale }));
    }
}
