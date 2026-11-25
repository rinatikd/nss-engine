using System;
using System.IO;
using AGPT.Shared;
using Xunit;

public sealed class ResourceLocatorTests : IDisposable
{
    private readonly string root = Path.Combine(Path.GetTempPath(), "AGPT блоки " + Guid.NewGuid().ToString("N"));

    private string WriteResource(string directory, string name = "Рамка.dwg")
    {
        Directory.CreateDirectory(directory);
        string path = Path.Combine(directory, name);
        File.WriteAllBytes(path, new byte[] { 1 });
        return path;
    }

    [Fact]
    public void RuntimeFindsInstallationRootBlocks()
    {
        string dllDirectory = Path.Combine(root, "Runtime", "AutoCAD2026");
        string expected = WriteResource(Path.Combine(root, "blocks"));

        Assert.Equal(expected, ResourceLocator.FindBlockFile(dllDirectory, "Рамка.dwg"));
    }

    [Fact]
    public void DllBlocksTakePriorityOverParentAndInstallationRoot()
    {
        string dllDirectory = Path.Combine(root, "Runtime", "AutoCAD2026");
        WriteResource(Path.Combine(root, "blocks"));
        WriteResource(Path.Combine(root, "Runtime", "blocks"));
        string expected = WriteResource(Path.Combine(dllDirectory, "blocks"));

        Assert.Equal(expected, ResourceLocator.FindBlockFile(dllDirectory, "Рамка.dwg"));
    }

    [Fact]
    public void ParentBlocksRemainSupported()
    {
        string expected = WriteResource(Path.Combine(root, "Runtime", "blocks"));

        Assert.Equal(expected, ResourceLocator.FindBlockFile(
            Path.Combine(root, "Runtime", "AutoCAD2026"), "Рамка.dwg"));
    }

    [Fact]
    public void BundleUsesBlocksBesideItsRuntimeDll()
    {
        string dllDirectory = Path.Combine(root, "AGPT.bundle", "Contents", "Windows", "2026");
        string expected = WriteResource(Path.Combine(dllDirectory, "blocks"));

        Assert.Equal(expected, ResourceLocator.FindBlockFile(dllDirectory, "Рамка.dwg"));
    }

    [Fact]
    public void LegacyResourceBesideDllIsSupported()
    {
        string dllDirectory = Path.Combine(root, "Runtime", "AutoCAD2026");
        string expected = WriteResource(dllDirectory);

        Assert.Equal(expected, ResourceLocator.FindBlockFile(dllDirectory, "Рамка.dwg"));
    }

    [Fact]
    public void DoesNotWalkBeyondTwoAncestorsOrSearchRecursively()
    {
        WriteResource(Path.Combine(root, "blocks"));
        string dllDirectory = Path.Combine(root, "Installation", "Runtime", "AutoCAD2026");
        WriteResource(Path.Combine(dllDirectory, "blocks", "nested"));

        Assert.Null(ResourceLocator.FindBlockFile(dllDirectory, "Рамка.dwg"));
    }

    [Fact]
    public void MissingCandidatesReturnNullAndLaterCandidateCanMatch()
    {
        string expected = WriteResource(Path.Combine(root, "blocks"));

        Assert.Null(ResourceLocator.FindBlockFile(root, "missing.dwg"));
        Assert.Equal(expected, ResourceLocator.FindBlockFile(root, "missing.dwg", "Рамка.dwg"));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData(" ")]
    [InlineData(".")]
    [InlineData("..")]
    [InlineData("../Рамка.dwg")]
    [InlineData("..\\Рамка.dwg")]
    [InlineData("nested/Рамка.dwg")]
    [InlineData("nested\\Рамка.dwg")]
    [InlineData("C:\\Рамка.dwg")]
    [InlineData("Рамка.dwg:stream")]
    public void RejectsUnsafeNamesEvenAfterAnExistingCandidate(string name)
    {
        WriteResource(Path.Combine(root, "blocks"));

        Assert.Throws<ArgumentException>(() => ResourceLocator.FindBlockFile(root, "Рамка.dwg", name));
    }

    public void Dispose()
    {
        if (Directory.Exists(root)) Directory.Delete(root, true);
    }
}
