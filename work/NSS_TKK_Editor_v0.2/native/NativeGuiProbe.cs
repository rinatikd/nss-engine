using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Diagnostics;
using System.Text.Json;
using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.Runtime;
using AcApp=Autodesk.AutoCAD.ApplicationServices.Core.Application;

// Uses actual Application.Idle delivery in a separate full-AutoCAD process.
public sealed class NativeGuiProbe
{
    static System.Windows.Forms.Timer? timer;static int idleCount,eligibleIdleCount,ticks;
    static DateTime started;static bool finishing;static Document? target;
    static string Folder=>Environment.GetEnvironmentVariable("NSS_TKK_NATIVE_OUT")!;
    static string Root=>Environment.GetEnvironmentVariable("NSS_TKK_PACKAGE")!;
    static Type EditorType=>AppDomain.CurrentDomain.GetAssemblies().Select(a=>a.GetType("TkkEditor")).First(t=>t!=null)!;
    static void Call(string name)=>EditorType.GetMethod(name,BindingFlags.Instance|BindingFlags.Public)!.Invoke(Activator.CreateInstance(EditorType),null);
    [CommandMethod("NSS_TKK_NATIVE_GUI_PROBE_START",CommandFlags.Session)]
    public void Start()
    {
        try
        {
            int expected=int.Parse(File.ReadAllText(Path.Combine(Folder,"expected_pid.txt")));
            if(Process.GetCurrentProcess().Id!=expected)throw new InvalidOperationException("Refusing to test inside another AutoCAD process");
            string input=Path.GetFullPath(Environment.GetEnvironmentVariable("NSS_TKK_NATIVE_INPUT")!);
            target=AcApp.DocumentManager.MdiActiveDocument;
            if(target==null||!string.Equals(Path.GetFullPath(target.Name),input,StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("The test drawing is not active");
            foreach(Document document in AcApp.DocumentManager)
                if(document!=target)throw new InvalidOperationException("Another drawing is open; stopping before automation");
            finishing=false;idleCount=0;eligibleIdleCount=0;ticks=0;started=DateTime.UtcNow;
            AcApp.Idle+=Observe;
            timer=new System.Windows.Forms.Timer{Interval=100};timer.Tick+=TimerTick;timer.Start();
            Call("On");
            File.WriteAllText(Path.Combine(Folder,"gui_probe_started.json"),JsonSerializer.Serialize(new{pid=expected,drawing=target.Name,utc=started}));
        }
        catch(System.Exception error){Finish(false,error.ToString(),false);}
    }
    static void TimerTick(object? sender,EventArgs args)
    {
        // Only stimulate the normal Windows message loop; never invoke plugin Idle.
        ticks++;
        if(DateTime.UtcNow-started>TimeSpan.FromSeconds(40))Finish(false,"Timed out waiting for a real idle update",true);
    }
    static void Observe(object? sender,EventArgs args)
    {
        if(finishing)return;idleCount++;
        if(target==null||AcApp.DocumentManager.MdiActiveDocument!=target||!string.IsNullOrEmpty(target.CommandInProgress))return;
        eligibleIdleCount++;
        try
        {
            string statusFile=Path.Combine(Root,"EDITOR_STATUS.json");if(!File.Exists(statusFile))return;
            using var status=JsonDocument.Parse(File.ReadAllText(statusFile));
            if(status.RootElement.GetProperty("phase").GetString()=="UPDATED")Finish(true,null,true);
            else if(status.RootElement.GetProperty("phase").GetString()=="FAILED")Finish(false,status.RootElement.GetRawText(),true);
        }
        catch(System.Exception error){Finish(false,error.ToString(),true);}
    }
    static void Finish(bool success,string? error,bool ownedProcess)
    {
        if(finishing)return;finishing=true;
        timer?.Stop();timer?.Dispose();timer=null;AcApp.Idle-=Observe;
        string? status=File.Exists(Path.Combine(Root,"EDITOR_STATUS.json"))?File.ReadAllText(Path.Combine(Root,"EDITOR_STATUS.json")):null;
        File.WriteAllText(Path.Combine(Folder,"native_gui_probe.json"),JsonSerializer.Serialize(new{success,error,idleCount,eligibleIdleCount,ticks,seconds=(DateTime.UtcNow-started).TotalSeconds,pid=Process.GetCurrentProcess().Id,drawing=target?.Name,status},new JsonSerializerOptions{WriteIndented=true}));
        if(!ownedProcess)return;
        try{Call("Off");NativeGuiCommands.QuitOwnedProcess();}catch{}
    }
}
