using AGPT.Shared;
using Xunit;

public class RoomGasPolicyTests
{
    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData(" \t\r\n")]
    public void MissingGasUsesUsersSupportedAgentDefault(string value)
    {
        Assert.Equal(GasAgentCatalog.SupportedAgent, RoomGasPolicy.DefaultAgent);
        Assert.Equal(GasAgentCatalog.SupportedAgent, RoomGasPolicy.Resolve(value, false));
    }

    [Theory]
    [InlineData("HFC-227ea")]
    [InlineData("HFC227ea")]
    [InlineData(" hfc-227EA ")]
    [InlineData(" hfc227EA ")]
    public void ExplicitSupportedAliasesResolveToCanonicalAgent(string value)
    {
        Assert.Equal(GasAgentCatalog.SupportedAgent, RoomGasPolicy.Resolve(value, false));
    }

    [Theory]
    [InlineData(" CO2 ", "CO2")]
    [InlineData("FK-5-1-12", "FK-5-1-12")]
    [InlineData("unknown", "unknown")]
    public void ExplicitOtherGasIsPreservedForValidation(string value, string expected)
    {
        Assert.Equal(expected, RoomGasPolicy.Resolve(value, false));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("HFC-227ea")]
    [InlineData("CO2")]
    public void UnresolvedOrContradictorySourceCannotAcquireADefault(string value)
    {
        Assert.Null(RoomGasPolicy.Resolve(value, true));
    }

    [Fact]
    public void DefaultSourceIdentifiesUserConfiguredGas()
    {
        Assert.Equal("UserConfiguredDefaultHFC227ea", RoomGasPolicy.DefaultSource);
    }
}
