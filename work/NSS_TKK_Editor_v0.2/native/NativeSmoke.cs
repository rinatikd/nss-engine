using System;
using System.IO;
using System.Linq;
using System.Collections.Generic;
using System.Diagnostics;
using System.Reflection;
using System.Text.Json;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.Runtime;
using AcApp = Autodesk.AutoCAD.ApplicationServices.Core.Application;

// Runs only against the disposable input supplied by run_native.py.
public sealed class NativeSmoke
{
    [CommandMethod("NSS_TKK_NATIVE_SMOKE", CommandFlags.Modal)]
    public void Run()
    {
        string root = Environment.GetEnvironmentVariable("NSS_TKK_PACKAGE")!;
        string evidence = Environment.GetEnvironmentVariable("NSS_TKK_NATIVE_OUT")!;
        Directory.CreateDirectory(evidence);
        var checks = new List<object>();
        try
        {
            string? plan=Environment.GetEnvironmentVariable("NSS_TKK_PLAN");
            if(!string.IsNullOrEmpty(plan)){NativePrepare.Run(plan,evidence);checks.Add(new{name="native_working_copy_prepared",success=true});}
            var assembly = Assembly.LoadFrom(Directory.GetFiles(Path.Combine(root,"plugin"),"NssTkkEditor.V*.dll").Single());
            var type = assembly.GetType("TkkEditor")!;
            var flags = BindingFlags.Static | BindingFlags.NonPublic;
            type.GetField("doc",flags)!.SetValue(null,AcApp.DocumentManager.MdiActiveDocument);
            var pinned = JsonSerializer.Deserialize<Dictionary<string,int>>(File.ReadAllText(Path.Combine(root,"protected_numbers.json")))!;
            type.GetField("pinned",flags)!.SetValue(null,pinned);
            var db=AcApp.DocumentManager.MdiActiveDocument.Database;
            using(var tr=db.TransactionManager.StartOpenCloseTransaction())
            {
                var nod=(DBDictionary)tr.GetObject(db.NamedObjectsDictionaryId,OpenMode.ForRead);
                if(nod.Contains("NSS_TKK_EDITOR_SETTINGS"))
                {
                    var record=(Xrecord)tr.GetObject(nod.GetAt("NSS_TKK_EDITOR_SETTINGS"),OpenMode.ForRead);using var data=record.Data;
                    var savedNumbers=JsonSerializer.Deserialize<Dictionary<string,int>>(string.Concat(data.AsArray().Select(v=>(string)v.Value)))!;
                    if(savedNumbers.Count!=pinned.Count||pinned.Any(p=>!savedNumbers.TryGetValue(p.Key,out int number)||number!=p.Value))throw new InvalidDataException("Saved settings differ after reopening");
                    checks.Add(new{name="saved_pinned_numbers_reopened",success=true,count=savedNumbers.Count});
                }
                string? geometry=Environment.GetEnvironmentVariable("NSS_TKK_GEOMETRY_REPORT");
                if(!string.IsNullOrEmpty(geometry))
                {
                    using var report=JsonDocument.Parse(File.ReadAllText(geometry));int count=0;
                    foreach(var item in report.RootElement.GetProperty("geometry").EnumerateObject())
                    {
                        var entity=(Entity)tr.GetObject(db.GetObjectId(false,new Handle(Convert.ToInt64(item.Name,16)),0),OpenMode.ForRead);
                        if(NativePrepare.Geometry(entity)!=item.Value.GetString())throw new InvalidDataException("Reopened source geometry differs: "+item.Name);
                        count++;
                    }
                    checks.Add(new{name="source_geometry_reopened",success=true,count});
                }
            }
            object snapshot = type.GetMethod("Capture",flags)!.Invoke(null,null)!;
            string input = Path.Combine(evidence,"snapshot.json"), output = Path.Combine(evidence,"result.json");
            File.WriteAllText(input,JsonSerializer.Serialize(snapshot));
            var start = new ProcessStartInfo(Path.Combine(root,"runtime/python.exe")) {UseShellExecute=false,CreateNoWindow=true,RedirectStandardError=true};
            foreach(string arg in new[]{"-E","-s","-X","utf8",Path.Combine(root,"engine/tkk_editor_core.py"),input,output})start.ArgumentList.Add(arg);
            using var worker=Process.Start(start)!;
            var error=worker.StandardError.ReadToEndAsync();
            if(!worker.WaitForExit(120000)){worker.Kill(true);throw new TimeoutException("Worker timeout");}
            File.WriteAllText(Path.Combine(evidence,"worker_stderr.txt"),error.GetAwaiter().GetResult());
            using var result=JsonDocument.Parse(File.ReadAllText(output));
            var value=result.RootElement;
            if(value.GetProperty("phase").GetString()!="READY")throw new InvalidDataException(value.ToString());
            checks.Add(new {name="native_capture_and_python",success=true,wells=value.GetProperty("leaders").GetArrayLength(),spans=value.GetProperty("spans").GetArrayLength()});
            type.GetMethod("Apply",flags)!.Invoke(null,new object[]{value});
            checks.Add(new {name="native_transaction_and_mleader_metrics",success=true});
            using(var tr=db.TransactionManager.StartOpenCloseTransaction())
            {
                var bt=(BlockTable)tr.GetObject(db.BlockTableId,OpenMode.ForRead);var model=(BlockTableRecord)tr.GetObject(bt[BlockTableRecord.ModelSpace],OpenMode.ForRead);
                var leaders=model.Cast<ObjectId>().Select(id=>tr.GetObject(id,OpenMode.ForRead)).OfType<MLeader>().Where(e=>e.Layer=="NSS_TKK_CALLOUTS").ToArray();
                int masked=leaders.Count(e=>e.MText.BackgroundFill);
                if(leaders.Any(e=>e.ColorIndex!=7||e.LineWeight!=LineWeight.LineWeight009)){var bad=leaders.First(e=>e.ColorIndex!=7||e.LineWeight!=LineWeight.LineWeight009);throw new InvalidDataException($"Well multileader style mismatch at {bad.Handle}: color={bad.ColorIndex}, weight={bad.LineWeight}, total={leaders.Length}");}
                var labels=model.Cast<ObjectId>().Select(id=>tr.GetObject(id,OpenMode.ForRead)).OfType<MText>().Where(e=>e.Layer=="NSS_TKK_SPAN_LABELS_PROJECT").ToArray();
                if(labels.Length==0||labels.Any(e=>e.ColorIndex!=7))throw new InvalidDataException("Span labels must be black");
                int maskedSpan=labels.Count(e=>e.BackgroundFill);
                var routes=model.Cast<ObjectId>().Select(id=>tr.GetObject(id,OpenMode.ForRead)).OfType<Entity>().Where(e=>e.Layer=="NSS_TKK_ROUTE_PROJECT").ToArray();
                if(routes.Length==0||routes.Any(e=>e.LineWeight!=LineWeight.LineWeight090))throw new InvalidDataException("Project route lineweight must be 0.90 mm");
                int rotated=0,rotationFailures=0;double maxRotationError=0;foreach(var item in value.GetProperty("well_rotations").EnumerateArray()){long handle=Convert.ToInt64(item.GetProperty("id").GetString(),16);var id=db.GetObjectId(false,new Handle(handle),0);var well=(BlockReference)tr.GetObject(id,OpenMode.ForRead);double rotationError=Math.Abs(Math.Atan2(Math.Sin(well.Rotation-item.GetProperty("rotation").GetDouble()),Math.Cos(well.Rotation-item.GetProperty("rotation").GetDouble())));maxRotationError=Math.Max(maxRotationError,rotationError);if(rotationError>1e-9)rotationFailures++;rotated++;}
                if(rotated==0)throw new InvalidDataException("No rectangular project wells were oriented");
                bool maskCheckAvailable=!Process.GetCurrentProcess().ProcessName.Contains("accoreconsole",StringComparison.OrdinalIgnoreCase);
                checks.Add(new{name="requested_annotation_styles_and_well_orientation",success=(!maskCheckAvailable||(masked==0&&maskedSpan==0))&&rotationFailures==0,mleaders=leaders.Length,span_labels=labels.Length,route_entities=routes.Length,oriented_wells=rotated,well_multileaders_with_background=masked,span_labels_with_background=maskedSpan,mask_check_available=maskCheckAvailable,rotation_failures=rotationFailures,max_rotation_error=maxRotationError});
            }
            object second=type.GetMethod("Capture",flags)!.Invoke(null,null)!;
            File.WriteAllText(Path.Combine(evidence,"snapshot_after.json"),JsonSerializer.Serialize(second));
            int modifications=0;void Modified(object sender,ObjectEventArgs args){modifications++;}
            db.ObjectModified+=Modified;db.ObjectAppended+=Modified;
            try{type.GetMethod("Apply",flags)!.Invoke(null,new object[]{value});}
            finally{db.ObjectModified-=Modified;db.ObjectAppended-=Modified;}
            if(modifications!=0)throw new InvalidDataException("Repeated apply rewrote an unchanged drawing");
            checks.Add(new {name="repeat_apply",success=true,database_writes=modifications});
            ObjectId captionId;string originalCaption;
            using(var tr=db.TransactionManager.StartTransaction())
            {
                var bt=(BlockTable)tr.GetObject(db.BlockTableId,OpenMode.ForRead);var model=(BlockTableRecord)tr.GetObject(bt[BlockTableRecord.ModelSpace],OpenMode.ForRead);
                captionId=model.Cast<ObjectId>().First(id=>tr.GetObject(id,OpenMode.ForRead) is MText text&&text.Layer=="NSS_TKK_SPAN_LABELS_PROJECT");
                var caption=(MText)tr.GetObject(captionId,OpenMode.ForWrite);originalCaption=caption.Contents;caption.Contents="NSS TEST: changed caption";tr.Commit();
            }
            type.GetMethod("Apply",flags)!.Invoke(null,new object[]{value});
            using(var tr=db.TransactionManager.StartOpenCloseTransaction())
            {
                var bt=(BlockTable)tr.GetObject(db.BlockTableId,OpenMode.ForRead);var model=(BlockTableRecord)tr.GetObject(bt[BlockTableRecord.ModelSpace],OpenMode.ForRead);
                if(model.Cast<ObjectId>().Any(id=>tr.GetObject(id,OpenMode.ForRead) is MText text&&text.Contents=="NSS TEST: changed caption"))throw new InvalidDataException("Apply stamp hid a manual caption change");
                if(!model.Cast<ObjectId>().Any(id=>tr.GetObject(id,OpenMode.ForRead) is MText text&&text.Contents==originalCaption))throw new InvalidDataException("Caption was not restored");
            }
            checks.Add(new{name="manual_annotation_change_restored",success=true});
            string saved=Path.Combine(evidence,"native_result.dwg");
            AcApp.DocumentManager.MdiActiveDocument.Database.SaveAs(saved,DwgVersion.Current);
            checks.Add(new {name="save_dwg",success=true,file=saved});
            File.WriteAllText(Path.Combine(evidence,"native_summary.json"),JsonSerializer.Serialize(new{success=true,checks},new JsonSerializerOptions{WriteIndented=true}));
            type.GetMethod("Detach",flags)!.Invoke(null,null);
        }
        catch(System.Exception ex)
        {
            while(ex is TargetInvocationException && ex.InnerException!=null)ex=ex.InnerException;
            File.WriteAllText(Path.Combine(evidence,"native_summary.json"),JsonSerializer.Serialize(new{success=false,checks,error=ex.ToString()},new JsonSerializerOptions{WriteIndented=true}));
        }
    }
}
