using System;
using AGPT.Shared;
using Xunit;

public class TaggingPolicyTests
{
    [Theory]
    [InlineData("AGPT")]
    [InlineData("APPT")]
    public void GeneratedAlbumCannotBecomeSourceGeometry(string system)
    {
        Assert.Throws<InvalidOperationException>(() => TaggingPolicy.RequireTaggable(
            system, "0", new[] { ("AGPT_ALBUM_OUTPUT", "SYSTEM", system) }, "ZONE"));
    }

    [Theory]
    [InlineData("AGPT", "KIND", "ZONE")]
    [InlineData("AGPT", "ZONE_NAME", "Room")]
    [InlineData("APPT", "KIND", "CABLE")]
    [InlineData("APPT", "CABLE_MARK", "Cable mark")]
    [InlineData("APPT", "SEG_TYPE", "branch")]
    [InlineData("ThirdParty", "KIND", "ZONE")]
    public void PowderZoneCannotRepurposeClassifiedObjects(string owner, string key, string value)
    {
        Assert.Throws<InvalidOperationException>(() => TaggingPolicy.RequireTaggable(
            "APPT", "0", new[] { (owner, key, value) }, "ZONE"));
    }

    [Theory]
    [InlineData("AGPT-ZONE")]
    [InlineData("agpt-zone")]
    [InlineData("APPT-CABLE")]
    [InlineData("APPT-PIPE")]
    [InlineData("AGPT-PIPE")]
    [InlineData("APPT-EQ")]
    public void PowderZoneCannotRepurposeLayerOnlyLegacyObjects(string layer)
    {
        Assert.Throws<InvalidOperationException>(() => TaggingPolicy.RequireTaggable(
            "APPT", layer, Array.Empty<(string, string, string)>(), "ZONE"));
    }

    [Fact]
    public void PowderZoneCanTagAnUnusedContourOrUpdateItsExistingZone()
    {
        TaggingPolicy.RequireTaggable("APPT", "Room boundary", Array.Empty<(string, string, string)>(), "ZONE");
        TaggingPolicy.RequireTaggable("APPT", "appt-zone", new[] {
            ("APPT", "KIND", "ZONE"), ("APPT", "ZONE_NAME", "Room"),
            ("OtherApp", "COMMENT", "Unrelated data remains allowed") }, "ZONE");
        TaggingPolicy.RequireTaggable("APPT", "APPT-ZONE", Array.Empty<(string, string, string)>(), "ZONE");
    }

    [Fact]
    public void EveryApplicationIsCheckedEvenWhenOwnZoneTagsArePresent()
    {
        Assert.Throws<InvalidOperationException>(() => TaggingPolicy.RequireTaggable("APPT", "APPT-ZONE", new[] {
            ("APPT", "KIND", "ZONE"), ("AGPT", "KIND", "ZONE") }, "ZONE"));
    }

    [Theory]
    [InlineData("AGPT", "AGPT-ZONE", "ZONE")]
    [InlineData("AGPT", "AGPT-CABLE", "CABLE")]
    [InlineData("APPT", "APPT-CABLE", "CABLE")]
    [InlineData("APPT", "APPT-EQ", "MODULE")]
    [InlineData("APPT", "APPT-EQ", "EQUIPMENT")]
    public void ExistingInputCommandsRetainCompatibleUpdates(string app, string layer, string kind)
    {
        TaggingPolicy.RequireTaggable(app, layer, new[] { (app, "KIND", kind) }, kind);
    }

    [Fact]
    public void LegacyCableAndZoneTagsRetainTheirCompatibilityWithoutKind()
    {
        TaggingPolicy.RequireTaggable("AGPT", "AGPT-CABLE", new[] { ("AGPT", "CABLE_MARK", "Cable") }, "CABLE");
        TaggingPolicy.RequireTaggable("AGPT", "AGPT-ZONE", new[] { ("AGPT", "ZONE_NAME", "Room") }, "ZONE");
    }

    [Fact]
    public void DeviceUpdateAllowsEitherExistingDeviceKindButRejectsPipes()
    {
        TaggingPolicy.RequireTaggable("APPT", "APPT-EQ", new[] { ("APPT", "KIND", "MODULE") }, "MODULE", "EQUIPMENT");
        Assert.Throws<InvalidOperationException>(() => TaggingPolicy.RequireTaggable("APPT", "APPT-PIPE",
            Array.Empty<(string, string, string)>(), "MODULE", "EQUIPMENT"));
    }
}
