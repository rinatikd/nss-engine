using System;
using System.IO;
using System.Text.Json;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.Runtime;
namespace NssEngine.Export;

public sealed class AutoDebugBootstrapV042
{
    // Used only by a generated in-host bootstrap. No profile/registry environment changes.
    [LispFunction(DebugRegistration.EntryName)]
    public ResultBuffer? Run(ResultBuffer input)
    {
        var args=input?.AsArray();
        if(args?.Length!=1||args[0].Value is not string file)throw new ArgumentException("Expected one authorization path");
        file=Path.GetFullPath(file);
        if(!string.Equals(Path.GetFileName(file),"authorization.json",StringComparison.OrdinalIgnoreCase))throw new InvalidDataException("Wrong authorization filename");
        using var auth=JsonDocument.Parse(File.ReadAllText(file));
        string folder=Path.GetDirectoryName(file)!,run=auth.RootElement.GetProperty("run_id").GetString()!;
        string? previousFolder=Environment.GetEnvironmentVariable("NSS_REPORT_DIR"),previousRun=Environment.GetEnvironmentVariable("NSS_TEST_RUN_ID");
        try
        {
            Environment.SetEnvironmentVariable("NSS_REPORT_DIR",folder,EnvironmentVariableTarget.Process);
            Environment.SetEnvironmentVariable("NSS_TEST_RUN_ID",run,EnvironmentVariableTarget.Process);
            string completed=Path.Combine(folder,"native_results.json");
            if(File.Exists(completed))
            {
                using var previous=JsonDocument.Parse(File.ReadAllText(completed));
                if(previous.RootElement.GetProperty("run_id").GetString()!=run)throw new InvalidDataException("Stale native result");
                return null; // Re-loading the same one-run loader collects, never repeats mutations.
            }
            // Full path/hash/scope checks are in the same native command, before any tests.
            new AutoDebugV042().Run();
        }
        finally
        {
            Environment.SetEnvironmentVariable("NSS_REPORT_DIR",previousFolder,EnvironmentVariableTarget.Process);
            Environment.SetEnvironmentVariable("NSS_TEST_RUN_ID",previousRun,EnvironmentVariableTarget.Process);
        }
        return null;
    }
}
