using AGPT.Shared;
using Xunit;

public class RoomTextFactsTests
{
    [Fact]
    public void ReadsOnlyExplicitRoomFactsWithoutInventingCalculationInputs()
    {
        var result = RoomTextFacts.Parse("Помещение: Серверная 101\nВысота помещения: 3,2 м\nМинимальная температура: -10 °С\nПлощадь проёмов: 0,25 м²\nГОТВ: Хладон 227ea");
        Assert.Equal("Серверная 101", result.Values["ZONE_NAME"]);
        Assert.Equal("3.2", result.Values["H"]);
        Assert.Equal("-10", result.Values["TM"]);
        Assert.Equal("0.25", result.Values["FH"]);
        Assert.Equal(GasAgentCatalog.SupportedAgent, result.Values["GOTV"]);
        Assert.Equal(5, result.Values.Count);
        Assert.Empty(result.InvalidFields);
        Assert.Empty(result.Issues);
    }

    [Theory]
    [InlineData("H=3200 мм", "3.2")]
    [InlineData("H: 320 cm", "3.2")]
    [InlineData("Высота помещения 320 см", "3.2")]
    [InlineData("HEIGHT_M=3,2", "3.2")]
    public void ConvertsExplicitHeightUnits(string text, string expected)
    {
        Assert.Equal(expected, RoomTextFacts.Parse(text).Values["H"]);
    }

    [Fact]
    public void MTextParagraphsAndUnitBearingLabelsAreAccepted()
    {
        var result = RoomTextFacts.Parse(@"ROOM_NAME: Архив\PHEIGHT_M: 3\PTM_C: -73,15\POPENINGS_M2: 0\PГОТВ: Хладон227ea");
        Assert.Equal("Архив", result.Values["ZONE_NAME"]);
        Assert.Equal("3", result.Values["H"]);
        Assert.Equal("-73.15", result.Values["TM"]);
        Assert.Equal("0", result.Values["FH"]);
        Assert.Equal(GasAgentCatalog.SupportedAgent, result.Values["GOTV"]);
    }

    [Theory]
    [InlineData("H: 0 м", "H")]
    [InlineData("H: -3 м", "H")]
    [InlineData("H: 3", "H")]
    [InlineData("HEIGHT_M: NaN", "H")]
    [InlineData("HEIGHT_M: 1e999", "H")]
    [InlineData("FH: -1 м2", "FH")]
    [InlineData("FH: 1", "FH")]
    [InlineData("Tmin: -74 °C", "TM")]
    [InlineData("Tmin: 20", "TM")]
    [InlineData("Помещение:", "ZONE_NAME")]
    [InlineData("ГОТВ:", "GOTV")]
    public void InvalidExplicitFactsAreFlaggedWithoutValues(string text, string field)
    {
        var result = RoomTextFacts.Parse(text);
        Assert.Empty(result.Values);
        Assert.Contains(field, result.InvalidFields);
        Assert.NotEmpty(result.Issues);
    }

    [Fact]
    public void EquivalentDuplicatesAreAcceptedButConflictingOrMalformedDuplicatesStayInvalid()
    {
        var result = RoomTextFacts.Parse("H: 3000 mm\nHEIGHT_M: 3\nFH: 1 м2\nOPENINGS_M2: 2\nOPENINGS_M2: 1\nTM_C: bad\nTM_C: 20");
        Assert.Equal("3", result.Values["H"]);
        Assert.False(result.Values.ContainsKey("FH"));
        Assert.False(result.Values.ContainsKey("TM"));
        Assert.Contains("FH", result.InvalidFields);
        Assert.Contains("TM", result.InvalidFields);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("Серверная\n3,2\n20\n0")]
    [InlineData("Пример: H: 3 м\nТекст содержит Tmin: 20 °C")]
    [InlineData("Cn: 7,2 %\nρ: 7,28\nK4: 1\nVTR: 0,4 м3")]
    public void IrrelevantTextProvidesNoFallbackFacts(string text)
    {
        var result = RoomTextFacts.Parse(text);
        Assert.Empty(result.Values);
        Assert.Empty(result.InvalidFields);
    }

    [Fact]
    public void TrailingProseIsNeverPartOfNumericEvidenceAndUnknownAgentIsPreserved()
    {
        var result = RoomTextFacts.Parse("H: 3 м например\nГОТВ: IG-541");
        Assert.False(result.Values.ContainsKey("H"));
        Assert.Contains("H", result.InvalidFields);
        Assert.Equal("IG-541", result.Values["GOTV"]);
        Assert.False(result.Values.ContainsKey("CN"));
    }
    [Theory]
    [InlineData("ГОТВ: Хладон 227еа")]
    [InlineData("ГОТВ: Хладон227eа")]
    public void CyrillicAgentDesignationMapsToCanonicalAgent(string text)
    {
        Assert.Equal(GasAgentCatalog.SupportedAgent, RoomTextFacts.Parse(text).Values["GOTV"]);
    }
}
