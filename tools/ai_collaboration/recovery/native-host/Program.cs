using System.Buffers.Binary;
using System.Diagnostics;
using System.Text;
using System.Text.Json;

internal static class Program
{
    private const int MaxInbound = 4096;
    private const int MaxOutbound = 32768;
    private static readonly string ReleaseRoot =
        @"C:\Engineering\ChromeBridge-Recovery-Release";
    private static readonly string Entrypoint =
        Path.Combine(ReleaseRoot, "Invoke-VerifiedRecovery.ps1");
    private static readonly string PowerShellExe =
        @"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe";
    private static readonly string[] Operations = { "status", "restore" };

    private static async Task<int> Main()
    {
        try
        {
            using var input = Console.OpenStandardInput();
            using var output = Console.OpenStandardOutput();
            var lengthBytes = new byte[4];
            await input.ReadExactlyAsync(lengthBytes);
            int length = BinaryPrimitives.ReadInt32LittleEndian(lengthBytes);
            if (length < 2 || length > MaxInbound)
            {
                await Reply(output, new { ok = false, error = "INVALID_MESSAGE_LENGTH" });
                return 1;
            }
            var bytes = new byte[length];
            await input.ReadExactlyAsync(bytes);
            using var document = JsonDocument.Parse(bytes);
            var root = document.RootElement;
            // Absolutely no file paths, scripts, shell commands, environment,
            // credentials or override arguments are accepted from Chrome.
            if (root.ValueKind != JsonValueKind.Object ||
                root.EnumerateObject().Count() != 1 ||
                !root.TryGetProperty("action", out var actionJson) ||
                actionJson.ValueKind != JsonValueKind.String)
            {
                await Reply(output, new { ok = false, error = "INVALID_REQUEST_SHAPE" });
                return 1;
            }
            string? action = actionJson.GetString();
            if (action is not ("restore" or "status"))
            {
                await Reply(output, new { ok = false, error = "ACTION_NOT_ALLOWED" });
                return 1;
            }

            // Require the reviewed create-only release path; not a Git checkout.
            // The Windows installer grants native-host access only to the
            // explicitly pinned PR113 extension ID.
            if (!File.Exists(Entrypoint) || !File.Exists(PowerShellExe) ||
                !File.Exists(Path.Combine(ReleaseRoot, "files.sha256.json")))
            {
                await Reply(output, new { ok = false, error = "RECOVERY_RELEASE_NOT_INSTALLED" });
                return 1;
            }
            var psi = new ProcessStartInfo(PowerShellExe)
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                WorkingDirectory = ReleaseRoot
            };
            psi.ArgumentList.Add("-NoProfile");
            psi.ArgumentList.Add("-NonInteractive");
            psi.ArgumentList.Add("-File");
            psi.ArgumentList.Add(Entrypoint);
            psi.ArgumentList.Add("-Mode");
            psi.ArgumentList.Add(action == "restore" ? "Restore" : "Status");
            // No inherited bridge secret is needed by this host. Credential
            // recovery is done in the trusted local scripts with Windows DPAPI.
            foreach (var key in new[] {
                "CONTROL_PLANE_API_KEY", "PS_DIRECT_AGENT_TOKEN",
                "PS_DIRECT_GATEWAY_TOKEN", "CHROME_BRIDGE_BROWSER_TOKEN"
            }) psi.Environment.Remove(key);

            using var child = Process.Start(psi);
            if (child is null)
            {
                await Reply(output, new { ok = false, error = "START_FAILED" });
                return 1;
            }
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(110));
            var outTask = child.StandardOutput.ReadToEndAsync();
            var errTask = child.StandardError.ReadToEndAsync();
            try { await child.WaitForExitAsync(timeout.Token); }
            catch (OperationCanceledException)
            {
                try { child.Kill(entireProcessTree: true); } catch { }
                await Reply(output, new { ok = false, error = "RECOVERY_TIMEOUT" });
                return 1;
            }
            string stdout = await outTask;
            _ = await errTask;
            if (child.ExitCode != 0)
            {
                await Reply(output, new { ok = false, error = "RECOVERY_EXIT_NONZERO" });
                return 1;
            }

            // Parse strict, bounded recovery status as JSON instead of
            // returning arbitrary script/stdout text to an extension.
            if (stdout.Length > MaxOutbound)
            {
                await Reply(output, new { ok = false, error = "RESULT_TOO_LARGE" });
                return 1;
            }
            try
            {
                using var report = JsonDocument.Parse(stdout);
                var r = report.RootElement;
                if (r.ValueKind != JsonValueKind.Object ||
                    !r.TryGetProperty("Servers", out var servers) ||
                    !r.TryGetProperty("Connections", out var connections) ||
                    servers.ValueKind != JsonValueKind.Array ||
                    connections.ValueKind != JsonValueKind.Array)
                    throw new JsonException();
                static object[] Filter(JsonElement arr) =>
                    arr.EnumerateArray().Take(20).Select(x => (object)new {
                        id = x.TryGetProperty("Service", out var v) ? Short(v) : "",
                        state = x.TryGetProperty("Outcome", out var o) ? Short(o) :
                                x.TryGetProperty("ProcessState", out var p) ? Short(p) :
                                x.TryGetProperty("State", out var s) ? Short(s) : "STATUS_ONLY"
                    }).ToArray();
                await Reply(output, new { ok = true, action,
                    servers = Filter(servers), connections = Filter(connections) });
                return 0;
            }
            catch
            {
                await Reply(output, new { ok = false, error = "INVALID_RECOVERY_RESULT" });
                return 1;
            }
        }
        catch
        {
            // Errors are fixed codes only. No exception paths, secrets or
            // environment are disclosed through the native messaging pipe.
            try { await Reply(Console.OpenStandardOutput(),
                    new { ok = false, error = "NATIVE_HOST_FAILURE" }); }
            catch { }
            return 1;
        }
    }
    private static string Short(JsonElement element)
    {
        if (element.ValueKind != JsonValueKind.String) return "";
        var raw = element.GetString() ?? "";
        return raw.Length <= 80 && raw.All(c =>
            char.IsAsciiLetterOrDigit(c) || c is '-' or '_') ? raw : "REDACTED";
    }
    private static async Task Reply(Stream stream, object value)
    {
        byte[] payload = JsonSerializer.SerializeToUtf8Bytes(value);
        if (payload.Length > MaxOutbound) payload =
            Encoding.UTF8.GetBytes("{\"ok\":false,\"error\":\"OUTPUT_TOO_LARGE\"}");
        var length = new byte[4];
        BinaryPrimitives.WriteInt32LittleEndian(length, payload.Length);
        await stream.WriteAsync(length);
        await stream.WriteAsync(payload);
        await stream.FlushAsync();
    }
}
