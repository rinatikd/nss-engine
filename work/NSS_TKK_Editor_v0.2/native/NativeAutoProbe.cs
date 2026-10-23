using System;
using System.IO;
using System.Text.Json;
using Autodesk.AutoCAD.Runtime;
using AcApp=Autodesk.AutoCAD.ApplicationServices.Core.Application;

public sealed class NativeAutoProbe
{
    static int idleCount,eligibleIdleCount;static DateTime started;
    static void Observe(object? sender,EventArgs args)
    {
        idleCount++;
        if(string.IsNullOrEmpty(AcApp.DocumentManager.MdiActiveDocument?.CommandInProgress))eligibleIdleCount++;
    }
    [CommandMethod("NSS_TKK_NATIVE_AUTO_PROBE_BEGIN",CommandFlags.NoUndoMarker)]
    public void Begin(){idleCount=0;eligibleIdleCount=0;started=DateTime.UtcNow;AcApp.Idle+=Observe;}
    [CommandMethod("NSS_TKK_NATIVE_AUTO_PROBE_END",CommandFlags.NoUndoMarker)]
    public void End()
    {
        AcApp.Idle-=Observe;
        string root=Environment.GetEnvironmentVariable("NSS_TKK_PACKAGE")!,folder=Environment.GetEnvironmentVariable("NSS_TKK_NATIVE_OUT")!;
        using var status=JsonDocument.Parse(File.ReadAllText(Path.Combine(root,"EDITOR_STATUS.json")));
        string? phase=status.RootElement.GetProperty("phase").GetString();
        File.WriteAllText(Path.Combine(folder,"native_auto_probe.json"),JsonSerializer.Serialize(new{success=phase=="UPDATED"&&eligibleIdleCount>0,idleCount,eligibleIdleCount,phase,seconds=(DateTime.UtcNow-started).TotalSeconds,status=status.RootElement},new JsonSerializerOptions{WriteIndented=true}));
    }
    [CommandMethod("NSS_TKK_NATIVE_SESSION_PROBE",CommandFlags.Session)]
    public void SessionProbe()
    {
        string folder=Environment.GetEnvironmentVariable("NSS_TKK_NATIVE_OUT")!;
        File.WriteAllText(Path.Combine(folder,"native_session_probe.json"),JsonSerializer.Serialize(new{command=AcApp.DocumentManager.MdiActiveDocument?.CommandInProgress,application_context=AcApp.DocumentManager.IsApplicationContext},new JsonSerializerOptions{WriteIndented=true}));
    }
}
