using System;
using System.IO;
using System.Security.Cryptography;
namespace NssEngine.Export;

internal static class SharedFileHashV042
{
    // AutoCAD retains a writable handle even when this code only reads the drawing.
    // Sharing grants access to the existing handle; this stream never writes.
    internal static string Compute(string path)
    {
        using var stream=new FileStream(path,FileMode.Open,FileAccess.Read,FileShare.ReadWrite|FileShare.Delete);
        return Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
    }
}
