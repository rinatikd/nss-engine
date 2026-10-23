using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Diagnostics;
using System.Collections.Generic;
using System.Text.Json;
using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.Runtime;
using AcApp=Autodesk.AutoCAD.ApplicationServices.Core.Application;

// Separate commands exercise actual editing/Undo boundaries; only real Idle drives the editor.
public sealed class NativeGuiScenario
{
    static System.Windows.Forms.Timer? timer;
    static Document? target;
    static DateTime started;
    static string stage="",lastJob="";
    static bool finishing,owned,awaitingCommand,acknowledged;
    static int idleCount,ticks;
    static readonly List<object> checks=new();
    static string Folder=>Environment.GetEnvironmentVariable("NSS_TKK_NATIVE_OUT")!;
    static string Root=>Environment.GetEnvironmentVariable("NSS_TKK_PACKAGE")!;
    static Type EditorType=>AppDomain.CurrentDomain.GetAssemblies().Select(a=>a.GetType("TkkEditor")).First(t=>t!=null)!;
    static void Call(string name)=>EditorType.GetMethod(name,BindingFlags.Instance|BindingFlags.Public)!.Invoke(Activator.CreateInstance(EditorType),null);
    static void Require(bool value,string message){if(!value)throw new InvalidDataException(message);}

    [CommandMethod("NSS_TKK_NATIVE_GUI_SCENARIO_START",CommandFlags.Session)]
    public void Start()
    {
        try
        {
            int expected=int.Parse(File.ReadAllText(Path.Combine(Folder,"expected_pid.txt")));
            Require(Process.GetCurrentProcess().Id==expected,"Refusing to automate another AutoCAD process");
            target=AcApp.DocumentManager.MdiActiveDocument;
            string input=Path.GetFullPath(Environment.GetEnvironmentVariable("NSS_TKK_NATIVE_INPUT")!);
            Require(target!=null&&string.Equals(Path.GetFullPath(target.Name),input,StringComparison.OrdinalIgnoreCase),"The disposable drawing is not active");
            foreach(Document document in AcApp.DocumentManager)Require(document==target,"Another drawing is open; stopping before automation");
            owned=true;finishing=false;awaitingCommand=false;acknowledged=false;checks.Clear();idleCount=0;ticks=0;
            started=DateTime.UtcNow;stage="initial_update";
            AcApp.Idle+=Observe;
            timer=new System.Windows.Forms.Timer{Interval=100};timer.Tick+=TimerTick;timer.Start();
            Call("On");Write(false,null);
        }
        catch(System.Exception error){Finish(false,error.ToString());}
    }
    [CommandMethod("NSS_TKK_NATIVE_GUI_ACK",CommandFlags.NoUndoMarker)]
    public void Acknowledge()=>acknowledged=true;
    static void TimerTick(object? sender,EventArgs args)
    {
        ticks++;
        if(DateTime.UtcNow-started>TimeSpan.FromSeconds(120))Finish(false,"Timed out in "+stage);
    }
    static void Queue(string commands,string next)
    {
        stage=next;awaitingCommand=true;acknowledged=false;
        // These commands must start at the normal command prompt. An anonymous
        // ExecuteInCommandContextAsync wrapper adds its own Undo boundary and
        // would change the meaning of the UNDO operation we are testing.
        target!.SendStringToExecute(commands.Replace(' ','\n')+"NSS_TKK_NATIVE_GUI_ACK\n",true,false,false);
        Write(false,null);
    }
    static void CheckCommands()
    {
        string path=Path.Combine(Folder,"native_scenario_summary.json");
        if(!File.Exists(path))return;
        using var summary=JsonDocument.Parse(File.ReadAllText(path));
        Require(summary.RootElement.GetProperty("success").GetBoolean(),"Native command assertion failed: "+summary.RootElement.GetRawText());
    }
    static void Record(JsonElement status,string name,int wells,int spans)
    {
        string job=status.GetProperty("job").GetString()!;
        using var result=JsonDocument.Parse(File.ReadAllText(Path.Combine(job,"result.json")));
        Require(result.RootElement.GetProperty("leaders").GetArrayLength()==wells,name+": unexpected wells");
        Require(result.RootElement.GetProperty("spans").GetArrayLength()==spans,name+": unexpected spans");
        var state=EditorType.Assembly.GetType("AppliedState")!;
        string plan=(string)state.GetMethod("Plan",BindingFlags.Static|BindingFlags.NonPublic)!.Invoke(null,new[]{(object)result.RootElement,EditorType.GetField("pinned",BindingFlags.Static|BindingFlags.NonPublic)!.GetValue(null)!})!;
        var db=target!.Database;using var tr=db.TransactionManager.StartOpenCloseTransaction();
        string hash=(string)state.GetMethod("Hash",BindingFlags.Static|BindingFlags.NonPublic)!.Invoke(null,new object[]{db,tr})!;
        var nod=(DBDictionary)tr.GetObject(db.NamedObjectsDictionaryId,OpenMode.ForRead);string[]? stamp=null;
        if(nod.Contains("NSS_TKK_EDITOR_APPLIED")){using var data=((Xrecord)tr.GetObject(nod.GetAt("NSS_TKK_EDITOR_APPLIED"),OpenMode.ForRead)).Data;stamp=data.AsArray().Select(v=>(string)v.Value).ToArray();}
        object captured=state.GetMethod("Capture",BindingFlags.Static|BindingFlags.NonPublic)!.Invoke(null,new object[]{db,tr})!;
        File.WriteAllText(Path.Combine(Folder,name+"_annotations.json"),JsonSerializer.Serialize(captured));
        checks.Add(new{name,success=true,wells,spans,job,fingerprint=result.RootElement.GetProperty("fingerprint").GetString(),plan,hash,stamp,seconds=(DateTime.UtcNow-started).TotalSeconds});
        lastJob=job;
    }
    static void Observe(object? sender,EventArgs args)
    {
        if(finishing)return;idleCount++;
        if(target==null||AcApp.DocumentManager.MdiActiveDocument!=target||!string.IsNullOrEmpty(target.CommandInProgress))return;
        try
        {
            if(awaitingCommand)
            {
                if(!acknowledged)return;
                awaitingCommand=false;CheckCommands();
                if(stage=="saved"){Finish(true,null);return;}
            }
            using var parsed=JsonDocument.Parse(File.ReadAllText(Path.Combine(Root,"EDITOR_STATUS.json")));
            var status=parsed.RootElement;string phase=status.GetProperty("phase").GetString()!;
            Require(phase!="FAILED","Editor failed: "+status.GetRawText());
            if(phase!="UPDATED"||status.GetProperty("job").GetString()==lastJob)return;
            switch(stage)
            {
                case "initial_update":
                    Record(status,"real_idle_initial_update",112,109);
                    Queue("NSS_TKK_NATIVE_BEGIN NSS_TKK_NATIVE_ADD ","added");break;
                case "added":
                    Record(status,"automatic_add",113,110);
                    Queue("NSS_TKK_NATIVE_ASSERT_ADD NSS_TKK_NATIVE_MOVE ","moved");break;
                case "moved":
                    Record(status,"automatic_move",113,110);
                    Queue("NSS_TKK_NATIVE_ASSERT_MOVE NSS_TKK_NATIVE_DELETE ","deleted");break;
                case "deleted":
                    Record(status,"automatic_delete",112,109);
                    Queue("_.UNDO 1 NSS_TKK_NATIVE_ASSERT_UNDO ","undone");break;
                case "undone":
                    Record(status,"automatic_undo_delete",113,110);
                    Queue("_.REDO NSS_TKK_NATIVE_ASSERT_REDO ","redone");break;
                case "redone":
                    Record(status,"automatic_redo_delete",112,109);
                    Queue("NSS_TKK_NATIVE_FINISH ","saved");break;
            }
        }
        catch(System.Exception error){Finish(false,error.ToString());}
    }
    static void Write(bool complete,string? error)
    {
        File.WriteAllText(Path.Combine(Folder,"native_gui_scenario.json"),JsonSerializer.Serialize(new{success=complete&&error==null,complete,error,stage,idleCount,ticks,seconds=(DateTime.UtcNow-started).TotalSeconds,pid=Process.GetCurrentProcess().Id,drawing=target?.Name,checks},new JsonSerializerOptions{WriteIndented=true}));
    }
    static void Finish(bool success,string? error)
    {
        if(finishing)return;finishing=true;
        timer?.Stop();timer?.Dispose();timer=null;AcApp.Idle-=Observe;
        Write(success,error);
        if(!owned)return;
        try{Call("Off");NativeGuiCommands.QuitOwnedProcess();}catch{}
    }
}
