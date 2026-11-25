using System;
using System.IO;
using System.Text;
using AGPT.Shared;
using Xunit;

public class ProjectMetadataTests
{
    [Fact]
    public void UnicodeAndLineBreaksRoundTripWithoutSampleDefaults()
    {
        var source = new ProjectMetadata { Cipher = "П-2026/01", ObjectName = "Объект\nВторая строка 🏢",
            Company = "Организация", CityYear = "Город, 2026", Gip = "Назначенный специалист" };
        var restored = ProjectMetadata.Deserialize(source.Serialize());
        Assert.Equal(source.Cipher, restored.Cipher);
        Assert.Equal(source.ObjectName, restored.ObjectName);
        Assert.Equal(source.Company, restored.Company);
        Assert.Equal(source.CityYear, restored.CityYear);
        Assert.Equal(source.Gip, restored.Gip);
        Assert.Empty(restored.Drawn);
    }

    [Fact]
    public void EmptyDrawingIsAllowedButClaimedProjectRequiresRequisites()
    {
        var metadata = ProjectMetadata.Deserialize(new ProjectMetadata().Serialize());
        Assert.Empty(metadata.Validate());
        Assert.Equal(3, metadata.Validate(requireProjectFields: true).Count);
        metadata.Cipher = "  ";
        metadata.ObjectName = "Объект";
        metadata.Company = "Организация";
        Assert.Single(metadata.Validate(true));
    }

    [Fact]
    public void FieldAndTotalUtf8LimitsAreBothEnforced()
    {
        var metadata = new ProjectMetadata { Cipher = new string('а', ProjectMetadata.MaxFieldCharacters) };
        Assert.Equal(metadata.Cipher, ProjectMetadata.Deserialize(metadata.Serialize()).Cipher);
        metadata.Cipher += "а";
        Assert.Throws<InvalidDataException>(() => metadata.Serialize());
        string full = new string('界', ProjectMetadata.MaxFieldCharacters);
        metadata = new ProjectMetadata { Cipher = full, ObjectName = full, ObjectShort = full,
            Company = full, CompanyGsl = full, GenDesigner = full };
        Assert.Empty(metadata.Validate());
        Assert.Throws<InvalidDataException>(() => metadata.Serialize());
        Assert.Throws<InvalidDataException>(() => ProjectMetadata.Deserialize(new byte[ProjectMetadata.MaxPayloadBytes + 1]));
    }

    [Theory]
    [InlineData("not json")]
    [InlineData("[]")]
    [InlineData("{\"Cipher\":null}")]
    [InlineData("{\"Cipher\":7}")]
    [InlineData("{\"Unknown\":\"value\"}")]
    [InlineData("{\"Cipher\":\"a\",\"Cipher\":\"b\"}")]
    [InlineData("{\"Cipher\":\"a\\u0000b\"}")]
    public void DamagedRecordsAreRejected(string json)
    { Assert.Throws<InvalidDataException>(() => ProjectMetadata.Deserialize(Encoding.UTF8.GetBytes(json))); }

    [Fact]
    public void InvalidUtf8ControlCharactersAndUnpairedSurrogatesAreRejected()
    {
        Assert.Throws<InvalidDataException>(() => ProjectMetadata.Deserialize(new byte[] { 0xff }));
        Assert.Throws<InvalidDataException>(() => ProjectMetadata.Deserialize(Array.Empty<byte>()));
        Assert.Throws<InvalidDataException>(() => ProjectMetadata.Deserialize(null));
        Assert.Throws<InvalidDataException>(() => new ProjectMetadata { Company = "a\tb" }.Serialize());
        Assert.Throws<InvalidDataException>(() => new ProjectMetadata { Cipher = "\ud800" }.Serialize());
    }
}
