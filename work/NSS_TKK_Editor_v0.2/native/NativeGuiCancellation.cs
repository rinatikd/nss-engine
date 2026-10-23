using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Diagnostics;
using System.Collections.Generic;
using System.Security.Cryptography;
using System.Text.Json;
using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.Runtime;
using AcApp=Autodesk.AutoCAD.ApplicationServices.Core.Application;

// Inject a delayed AnalysisWorker through its existing test constructor. Neither
// the production DLL nor engine file is patched; only this private test job waits.
public sealed class NativeGuiCancellation
{
    static System.Windows.Forms.Timer? timer;
    static Document? target,first,secondary;
    static DateTime started,stageStarted;
    static string stage="",lastJob="",annotationState="",secondaryState="";
    static bool finishing,owned,awaitingCommand,acknowledged;
    static Process? staleProcess,offProcess,closeProcess;
    static string staleJob="",offJob="",closeJob="";
    static readonly List<object> checks=new();
    static string Folder=>Environment.GetEnvironmentVariable("NSS_TKK_NATIVE_OUT")!;
    static string Root=>Environment.GetEnvironmentVariable("NSS_TKK_PACKAGE")!;
    static Type EditorType=>AppDomain.CurrentDomain.GetAssemblies().Select(a=>a.GetType("TkkEditor")).First(t=>t!=null)!;
    const BindingFlags PrivateStatic=BindingFlags.NonPublic|BindingFlags.Static;
    static object? Field(string name)=>EditorType.GetField(name,PrivateStatic)!.GetValue(null);
    static void Call(string name)=>EditorType.GetMethod(name,BindingFlags.Instance|BindingFlags.Public)!.Invoke(Activator.CreateInstance(EditorType),null);
    static void Require(bool value,string message){if(!value)throw new InvalidDataException(message);}
    static void SetStage(string value){stage=value;stageStarted=DateTime.UtcNow;Write(false,null);}
    static void Delay(double seconds)
    {
        Require(File.Exists(Path.Combine(Folder,"test_latency_manifest.json")),"Missing private latency manifest");
        File.WriteAllText(Path.Combine(Folder,"_worker_delay_seconds.txt"),seconds.ToString(System.Globalization.CultureInfo.InvariantCulture));
    }
    static string Hash(Document document)
    {
        using var locked=document.LockDocument();using var tr=document.Database.TransactionManager.StartOpenCloseTransaction();
        return (string)EditorType.Assembly.GetType("AppliedState")!.GetMethod("Hash",PrivateStatic)!.Invoke(null,new object[]{document.Database,tr})!;
    }
    static Process Track(JsonElement status,out string job)
    {
        object original=Field("worker")??throw new InvalidDataException("No live worker");
        Require(Field("readyToApply")==null,"Worker already completed before injection");
        object snapshot=EditorType.GetMethod("Capture",PrivateStatic)!.Invoke(null,null)!;
        object worker=original.GetType().GetConstructors(BindingFlags.NonPublic|BindingFlags.Instance).Single().Invoke(new object?[]{Root,snapshot,(long)Field("generation")!,null,Path.Combine(Folder,"delay_worker.py")});
        ((IDisposable)original).Dispose();
        EditorType.GetField("worker",PrivateStatic)!.SetValue(null,worker);
        EditorType.GetMethod("WriteStatus",PrivateStatic)!.Invoke(null,new object[]{"RUNNING",new{controlled_latency=true}});
        int pid=(int)worker.GetType().GetProperty("ProcessId",BindingFlags.NonPublic|BindingFlags.Instance)!.GetValue(worker)!;
        var process=Process.GetProcessById(pid);_ = process.Handle;
        Require(!process.HasExited,"Worker finished before the cancellation trigger");
        job=(string)worker.GetType().GetProperty("Folder",BindingFlags.NonPublic|BindingFlags.Instance)!.GetValue(worker)!;
        checks.Add(new{name="live_worker_observed",success=true,stage,pid,started_utc=process.StartTime.ToUniversalTime(),job});return process;
    }
    static void Record(string name,object? details=null){checks.Add(new{name,success=true,seconds=(DateTime.UtcNow-started).TotalSeconds,details});Write(false,null);}
    static void Updated(JsonElement status,int wells,int spans,string name,bool verifyCurrentGeometry=false)
    {
        string job=status.GetProperty("job").GetString()!;
        using var result=JsonDocument.Parse(File.ReadAllText(Path.Combine(job,"result.json")));
        Require(result.RootElement.GetProperty("leaders").GetArrayLength()==wells&&result.RootElement.GetProperty("spans").GetArrayLength()==spans,"Unexpected counts in "+name);
        if(verifyCurrentGeometry)
        {
            object snapshot=EditorType.GetMethod("Capture",PrivateStatic)!.Invoke(null,null)!;
            using var current=JsonDocument.Parse(JsonSerializer.Serialize(snapshot));
            using var input=JsonDocument.Parse(File.ReadAllText(Path.Combine(job,"snapshot.json")));
            foreach(string key in new[]{"routes","protected"})Require(JsonSerializer.Serialize(current.RootElement.GetProperty(key))==JsonSerializer.Serialize(input.RootElement.GetProperty(key)),"Source "+key+" changed during apply");
            var originals=input.RootElement.GetProperty("wells").EnumerateArray().ToDictionary(w=>w.GetProperty("id").GetString()!);
            Require(current.RootElement.GetProperty("wells").GetArrayLength()==originals.Count,"Source well set changed during apply");
            foreach(var well in current.RootElement.GetProperty("wells").EnumerateArray())
            {
                Require(originals.TryGetValue(well.GetProperty("id").GetString()!,out var original),"Unexpected source well");
                foreach(string key in new[]{"xyz","reference","description"})Require(JsonSerializer.Serialize(well.GetProperty(key))==JsonSerializer.Serialize(original.GetProperty(key)),"Source well "+key+" changed during apply");
                // previous_number is read from our reference MLeader and changes when
                // numbering is regenerated; it is not source geometry.
            }
        }
        lastJob=job;Record(name,new{job,wells,spans,source_geometry_compared=verifyCurrentGeometry});
    }
    static void Queue(string commands,string next)
    {
        awaitingCommand=true;acknowledged=false;SetStage(next);
        NativeGuiCommands.Run(target!,commands,()=>acknowledged=true,error=>Finish(false,error.ToString()));
    }
    [CommandMethod("NSS_TKK_NATIVE_CANCEL_ACK",CommandFlags.NoUndoMarker)]public void Acknowledge()=>acknowledged=true;
    [CommandMethod("NSS_TKK_NATIVE_GUI_CANCEL_START",CommandFlags.Session)]
    public void Start()
    {
        try
        {
            int expected=int.Parse(File.ReadAllText(Path.Combine(Folder,"expected_pid.txt")));
            Require(Process.GetCurrentProcess().Id==expected,"Refusing to automate another AutoCAD process");
            target=first=AcApp.DocumentManager.MdiActiveDocument;
            string input=Path.GetFullPath(Environment.GetEnvironmentVariable("NSS_TKK_NATIVE_INPUT")!);
            Require(target!=null&&string.Equals(Path.GetFullPath(target.Name),input,StringComparison.OrdinalIgnoreCase),"The disposable drawing is not active");
            foreach(Document document in AcApp.DocumentManager)Require(document==target,"Another drawing is open");
            string engine=Path.Combine(Root,"engine","tkk_editor_core.py");
            string Digest(string path){using var stream=File.OpenRead(path);return Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();}
            File.WriteAllText(Path.Combine(Folder,"test_latency_manifest.json"),JsonSerializer.Serialize(new{fault_injection=true,method="AnalysisWorker scriptPath test constructor",plugin_sha256=Digest(EditorType.Assembly.Location),original_engine_sha256=Digest(engine),production_files_unchanged=true},new JsonSerializerOptions{WriteIndented=true}));
            string wrapper="from pathlib import Path\nimport runpy, sys, time\nengine = "+JsonSerializer.Serialize(engine)+"\nsys.path.insert(0, str(Path(engine).parent))\ntime.sleep(float(Path(__file__).with_name('_worker_delay_seconds.txt').read_text('ascii')))\nrunpy.run_path(engine, run_name='__main__')\n";
            File.WriteAllText(Path.Combine(Folder,"delay_worker.py"),wrapper);
            owned=true;finishing=false;checks.Clear();started=DateTime.UtcNow;
            AcApp.Idle+=Observe;timer=new System.Windows.Forms.Timer{Interval=100};timer.Tick+=TimerTick;timer.Start();
            Delay(0);Call("On");SetStage("initial");
        }
        catch(System.Exception error){Finish(false,error.ToString());}
    }
    static void TimerTick(object? sender,EventArgs args)
    {
        if(DateTime.UtcNow-started>TimeSpan.FromSeconds(120))Finish(false,"Timed out in "+stage);
    }
    static void Observe(object? sender,EventArgs args)
    {
        if(finishing||target==null||AcApp.DocumentManager.MdiActiveDocument!=target||!string.IsNullOrEmpty(target.CommandInProgress))return;
        try
        {
            if(awaitingCommand)
            {
                if(!acknowledged)return;awaitingCommand=false;
                string path=Path.Combine(Folder,"native_scenario_summary.json");
                if(File.Exists(path)){using var summary=JsonDocument.Parse(File.ReadAllText(path));Require(summary.RootElement.GetProperty("success").GetBoolean(),"Native edit command failed: "+summary.RootElement.GetRawText());}
            }
            using var parsed=JsonDocument.Parse(File.ReadAllText(Path.Combine(Root,"EDITOR_STATUS.json")));
            var status=parsed.RootElement;string phase=status.GetProperty("phase").GetString()!;
            Require(phase!="FAILED","Editor failed: "+status.GetRawText());
            string? job=status.GetProperty("job").GetString();
            switch(stage)
            {
                case "initial":
                    if(phase!="UPDATED")break;Updated(status,112,109,"initial_auto_update");
                    Delay(3);Queue("NSS_TKK_NATIVE_BEGIN NSS_TKK_NATIVE_ADD ","stale_wait");break;
                case "stale_wait":
                    if(phase!="RUNNING"||job==lastJob)break;
                    staleProcess=Track(status,out staleJob);annotationState=Hash(target);
                    Queue("NSS_TKK_NATIVE_MOVE ","stale_replaced");break;
                case "stale_replaced":
                    Require(!(phase=="UPDATED"&&job==staleJob),"Stale result reached UPDATED");
                    if(phase!="UPDATED"||job==lastJob){Require(Hash(target)==annotationState,"Annotations changed before the replacement result");break;}
                    Require(staleProcess!.HasExited,"Stale worker survived replacement");
                    Updated(status,113,110,"stale_worker_cancelled_and_current_geometry_applied",true);
                    Delay(3);Queue("NSS_TKK_NATIVE_ASSERT_ADD NSS_TKK_NATIVE_MOVE ","off_wait");break;
                case "off_wait":
                    if(phase!="RUNNING"||job==lastJob)break;
                    offProcess=Track(status,out offJob);annotationState=Hash(target);
                    Queue("NSS_TKK_AUTO_OFF ","disabled");break;
                case "disabled":
                    Require(phase=="DISABLED"&&Field("worker")==null,"AUTO_OFF did not stop the worker");
                    Require(offProcess!.HasExited,"Worker survived AUTO_OFF");Require(Hash(target)==annotationState,"Annotations changed after AUTO_OFF");
                    if(DateTime.UtcNow-stageStarted<TimeSpan.FromSeconds(5))break;
                    Record("auto_off_cancelled_worker_and_kept_annotations",new{job=offJob,observed_seconds=5});
                    Delay(0);Queue("NSS_TKK_NATIVE_DELETE NSS_TKK_REBUILD NSS_TKK_NATIVE_FINISH ","cleaned");break;
                case "cleaned":
                    Require(phase=="UPDATED","Cleanup REBUILD did not finish");Updated(status,112,109,"temporary_geometry_removed_and_saved");
                    File.Copy(Environment.GetEnvironmentVariable("NSS_TKK_NATIVE_INPUT")!,Path.Combine(Folder,"secondary.dwg"),false);
                    Delay(8);Call("On");Queue("NSS_TKK_NATIVE_ADD ","close_wait");break;
                case "close_wait":
                    if(phase!="RUNNING"||job==lastJob)break;
                    closeProcess=Track(status,out closeJob);SetStage("switch_queued");
                    new NativeGuiCancellation().Switch();break;
                case "switched":
                    Require(Hash(target)==secondaryState,"Inactive document analysis changed the secondary drawing");
                    Require((Document?)Field("doc")==first,"Switching unexpectedly retargeted the editor");
                    if(DateTime.UtcNow-stageStarted<TimeSpan.FromSeconds(2))break;
                    Require(!closeProcess!.HasExited,"Close test needs a live worker");
                    Record("inactive_drawing_result_not_applied_to_other_document");SetStage("close_queued");
                    new NativeGuiCancellation().Close();break;
                case "closed":
                    Require(Field("doc")==null&&Field("worker")==null&&!(bool)Field("auto")!,"Closing did not detach the editor");
                    Require(closeProcess!.HasExited,"Worker survived closing its drawing");Require(Hash(target)==secondaryState,"Closing another document changed secondary annotations");
                    Record("document_close_detached_editor_and_cancelled_worker",new{job=closeJob});
                    Delay(0);Call("On");SetStage("secondary_update");break;
                case "secondary_update":
                    if(phase!="UPDATED"||job==lastJob)break;
                    Updated(status,112,109,"second_document_auto_update");VerifySecondary();Finish(true,null);break;
            }
        }
        catch(System.Exception error){Finish(false,error.ToString());}
    }
    [CommandMethod("NSS_TKK_NATIVE_CANCEL_SWITCH",CommandFlags.Session)]public void Switch()
    {
        try
        {
            Require(owned&&stage=="switch_queued"&&target==first,"Unexpected switch command");
            secondary=AcApp.DocumentManager.Open(Path.Combine(Folder,"secondary.dwg"),false);
            AcApp.DocumentManager.MdiActiveDocument=secondary;target=secondary;
            secondaryState=Hash(secondary);SetStage("switched");
        }
        catch(System.Exception error){Finish(false,error.ToString());}
    }
    [CommandMethod("NSS_TKK_NATIVE_CANCEL_CLOSE",CommandFlags.Session)]public void Close()
    {
        try
        {
            Require(owned&&stage=="close_queued"&&target==secondary&&first!=null,"Unexpected close command");
            first.CloseAndDiscard();first=null;SetStage("closed");
        }
        catch(System.Exception error){Finish(false,error.ToString());}
    }
    static void VerifySecondary()
    {
        using var locked=target!.LockDocument();var db=target.Database;using var tr=db.TransactionManager.StartOpenCloseTransaction();
        var nod=(DBDictionary)tr.GetObject(db.NamedObjectsDictionaryId,OpenMode.ForRead);
        using var data=((Xrecord)tr.GetObject(nod.GetAt("NSS_TKK_EDITOR_SETTINGS"),OpenMode.ForRead)).Data;
        var pinned=JsonSerializer.Deserialize<Dictionary<string,int>>(string.Concat(data.AsArray().Select(v=>(string)v.Value)))!;
        var expected=JsonSerializer.Deserialize<Dictionary<string,int>>(File.ReadAllText(Path.Combine(Root,"protected_numbers.json")))!;
        Require(pinned.Count==24&&expected.All(p=>pinned.TryGetValue(p.Key,out int n)&&n==p.Value),"Protected numbers changed");
        int geometryCount=0;string? geometry=Environment.GetEnvironmentVariable("NSS_TKK_GEOMETRY_REPORT");
        if(!string.IsNullOrEmpty(geometry))
        {
            using var report=JsonDocument.Parse(File.ReadAllText(geometry));
            foreach(var item in report.RootElement.GetProperty("geometry").EnumerateObject())
            {
                var entity=(Entity)tr.GetObject(db.GetObjectId(false,new Handle(Convert.ToInt64(item.Name,16)),0),OpenMode.ForRead);
                Require(NativePrepare.Geometry(entity)==item.Value.GetString(),"Source geometry changed: "+item.Name);geometryCount++;
            }
        }
        Record("secondary_protected_numbers_and_source_geometry",new{protected_numbers=pinned.Count,source_objects=geometryCount});
    }
    static void Write(bool complete,string? error)=>File.WriteAllText(Path.Combine(Folder,"native_gui_cancellation.json"),JsonSerializer.Serialize(new{success=complete&&error==null,complete,error,stage,controlled_latency=true,seconds=(DateTime.UtcNow-started).TotalSeconds,pid=Process.GetCurrentProcess().Id,checks},new JsonSerializerOptions{WriteIndented=true}));
    static void Finish(bool success,string? error)
    {
        if(finishing)return;finishing=true;timer?.Stop();timer?.Dispose();timer=null;AcApp.Idle-=Observe;
        Write(success,error);staleProcess?.Dispose();offProcess?.Dispose();closeProcess?.Dispose();
        if(!owned)return;
        try{Call("Off");NativeGuiCommands.QuitOwnedProcess();}catch{}
    }
}
