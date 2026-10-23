using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text.Json;
using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.Geometry;
using Autodesk.AutoCAD.Runtime;
namespace NssEngine.Export;

public sealed class AutoDebugV042
{
    private static string Hash(string path)=>SharedFileHashV042.Compute(path);
    private static void Require(bool value,string message){if(!value)throw new InvalidOperationException(message);}
    private static string ModelState(Database db,bool includeLayers=false)
    {
        using var tr=db.TransactionManager.StartOpenCloseTransaction();
        var table=(BlockTable)tr.GetObject(db.BlockTableId,OpenMode.ForRead);
        var model=(BlockTableRecord)tr.GetObject(table[BlockTableRecord.ModelSpace],OpenMode.ForRead);
        var rows=new List<object>();
        foreach(ObjectId id in model)
        {
            var e=(Entity)tr.GetObject(id,OpenMode.ForRead);
            object geometry=e is Line l ? new{a=l.StartPoint.ToString(),b=l.EndPoint.ToString()} :
                e is Polyline p ? Enumerable.Range(0,p.NumberOfVertices).Select(i=>new{point=p.GetPoint3dAt(i).ToString(),bulge=p.GetBulgeAt(i)}).ToArray() : e.GetType().Name;
            rows.Add(new{handle=id.Handle.ToString(),layer=e.Layer,geometry});
        }
        if(includeLayers)
        {
            var layers=(LayerTable)tr.GetObject(db.LayerTableId,OpenMode.ForRead);
            foreach(ObjectId id in layers){var l=(LayerTableRecord)tr.GetObject(id,OpenMode.ForRead);rows.Add(new{layer=l.Name,l.IsPlottable});}
        }
        return DatabaseStateV042.Canonicalize(rows);
    }
    private static List<PreviewRouteV042> Routes(string id)=>new(){new(id,new(){new(0,0),new(10,0)})};
    private static void AddForeign(Database db,string id,bool plottable)
    {
        using var tr=db.TransactionManager.StartTransaction();
        var layers=(LayerTable)tr.GetObject(db.LayerTableId,OpenMode.ForWrite);
        var layer=new LayerTableRecord{Name=PreviewServiceV042.Prefix+id,IsPlottable=plottable};layers.Add(layer);tr.AddNewlyCreatedDBObject(layer,true);
        var table=(BlockTable)tr.GetObject(db.BlockTableId,OpenMode.ForRead);
        var model=(BlockTableRecord)tr.GetObject(table[BlockTableRecord.ModelSpace],OpenMode.ForWrite);
        var foreign=new Polyline(2){LayerId=layer.ObjectId};foreign.AddVertexAt(0,new Point2d(100,100),0,0,0);foreign.AddVertexAt(1,new Point2d(105,100),0,0,0);
        model.AppendEntity(foreign);tr.AddNewlyCreatedDBObject(foreign,true);tr.Commit();
    }
    [CommandMethod(DebugRegistration.CommandName,CommandFlags.Modal)]
    public void Run()=>ObservabilityV036.Run("NSS_AUTOTEST_V042",()=>
    {
        var doc=Application.DocumentManager.MdiActiveDocument??throw new InvalidOperationException("No active drawing");
        string folder=Environment.GetEnvironmentVariable("NSS_REPORT_DIR")??throw new InvalidOperationException("Use Start-AutoDebug.cmd; no authorized test folder");
        string run=Environment.GetEnvironmentVariable("NSS_TEST_RUN_ID")??throw new InvalidOperationException("Missing run id");
        using var auth=JsonDocument.Parse(File.ReadAllText(Path.Combine(folder,"authorization.json")));
        var permission=auth.RootElement;
        Require(permission.GetProperty("run_id").GetString()==run,"Run id mismatch");
        Require(permission.GetProperty("allowed_scope").GetString()=="synthetic_fixture_and_private_database","No test authorization");
        string source=Path.GetFullPath(doc.Name);
        Require(string.Equals(source,Path.GetFullPath(permission.GetProperty("drawing").GetString()!),StringComparison.OrdinalIgnoreCase),"Refusing autotest on a user drawing");
        string sourceHash=Hash(source),dllHash=Hash(typeof(AutoDebugV042).Assembly.Location);
        Require(sourceHash==permission.GetProperty("drawing_sha256").GetString(),"Fixture hash mismatch");
        Require(dllHash==permission.GetProperty("dll_sha256").GetString(),"Wrong loaded DLL");
        Require(typeof(AutoDebugV042).Assembly.GetName().Version?.ToString()=="0.42.3.0","Wrong DLL version");
        var cases=new List<object>();int failures=0;string? job=null;
        void Test(string name,Action action)
        {
            var timer=Stopwatch.StartNew();
            try{action();cases.Add(new{name,passed=true,seconds=timer.Elapsed.TotalSeconds,error=(string?)null});}
            catch(System.Exception error){failures++;cases.Add(new{name,passed=false,seconds=timer.Elapsed.TotalSeconds,error=error.ToString()});}
            File.WriteAllText(Path.Combine(folder,"native_progress.json"),JsonSerializer.Serialize(new{run_id=run,failures,cases}));
        }
        string activeBefore=ModelState(doc.Database),dbmodBefore=Application.GetSystemVariable("DBMOD").ToString()!;
        Test("native_inventory",()=>
        {
            new RuntimeValidationV041().Validate();
            using var report=JsonDocument.Parse(File.ReadAllText(Path.Combine(folder,"runtime_validation_v041.json")));
            var c=report.RootElement.GetProperty("counts");
            Require(c.GetProperty("lines").GetInt32()==5&&c.GetProperty("polylines").GetInt32()==2&&c.GetProperty("blocks").GetInt32()==1&&c.GetProperty("other").GetInt32()==1&&c.GetProperty("failed").GetInt32()==0,"Inventory mismatch");
        });
        string? snapshot=null;
        Test("native_XYZ_bulge_attributes_export",()=>
        {
            new NativeExportV042().Export();snapshot=Directory.GetFiles(folder,"snapshot_v042_*.json").Single();
            string json=File.ReadAllText(snapshot);SnapshotContractV042.ValidateSnapshotJson(json);
            using var report=JsonDocument.Parse(json);var records=report.RootElement.GetProperty("entities");
            Require(records.GetArrayLength()==8,"Expected 8 supported records");
            Require(report.RootElement.GetProperty("coverage").GetProperty("skipped").GetInt32()==1,"Circle must be explicit skip");
            Require(records.EnumerateArray().Any(e=>e.GetProperty("type").GetString()=="LINE"&&e.GetProperty("vertices")[0][2].GetDouble()==2&&e.GetProperty("vertices")[1][2].GetDouble()==7),"Z lost");
            Require(records.EnumerateArray().Any(e=>e.GetProperty("type").GetString()=="INSERT"&&e.GetProperty("attributes").GetProperty("CODE").GetString()=="\u041a\u041a\u0421-1"),"Attribute lost");
        });
        Test("read_only_active_drawing",()=>Require(ModelState(doc.Database)==activeBefore&&Application.GetSystemVariable("DBMOD").ToString()==dbmodBefore,"Export modified active drawing"));
        // Preview mutations below use a private in-memory database, NEVER the active DWG.
        using(var db=new Database(true,true))
        {
            db.DisableUndoRecording(false);
            AddForeign(db,"same_layer",false);AddForeign(db,"plottable",true);
            string baseline=ModelState(db,true);
            Test("preview_decline_no_changes",()=>Require(PreviewServiceV042.Apply(db,Routes("declined"),false)==0&&ModelState(db,true)==baseline,"No changed database"));
            Test("preview_invalid_payload_no_changes",()=>
            {
                bool rejected=false;
                try{PreviewContractV042.Parse("{}","fixture.dxf");}catch(System.Exception){rejected=true;}
                Require(rejected&&ModelState(db,true)==baseline,"Invalid preview accepted");
            });
            Test("preview_create_owned_nonplot",()=>
            {
                Require(PreviewServiceV042.Apply(db,Routes("same_layer"),true)==1,"Wrong create count");
                using var tr=db.TransactionManager.StartOpenCloseTransaction();var layers=(LayerTable)tr.GetObject(db.LayerTableId,OpenMode.ForRead);
                Require(!((LayerTableRecord)tr.GetObject(layers[PreviewServiceV042.Prefix+"same_layer"],OpenMode.ForRead)).IsPlottable,"Preview plots");
            });
            Test("preview_clear_decline_no_changes",()=>{string before=ModelState(db,true);Require(PreviewServiceV042.Clear(db,false)==0&&ModelState(db,true)==before,"Declined clear changed database");});
            Test("preview_clear_preserves_foreign_same_layer",()=>{Require(PreviewServiceV042.Clear(db,true)==1,"Wrong clear count");Require(ModelState(db,true)==baseline,"Foreign geometry changed");});
            Test("preview_repeated_cleanup_idempotent",()=>Require(PreviewServiceV042.Clear(db,true)==0&&ModelState(db,true)==baseline,"Repeated clear changed database"));
            Test("preview_fault_injection_rolls_back_entities_and_layers",()=>
            {
                using var isolated=new Database(true,true);
                isolated.DisableUndoRecording(false);
                string before=ModelState(isolated,true);
                bool rejected=false;
                try{PreviewServiceV042.Apply(isolated,Routes("rollback"),true,_=>throw new InvalidOperationException("Injected test fault before Commit"));}catch(InvalidOperationException){rejected=true;}
                string after=ModelState(isolated,true);
                File.WriteAllText(Path.Combine(folder,"rollback_state.json"),JsonSerializer.Serialize(new{rejected,before,after}));
                Require(rejected&&after==before,"Transaction rollback failed; inspect rollback_state.json");
            });
            Test("preview_plottable_foreign_layer_refused",()=>
            {
                using var isolated=new Database(true,true);isolated.DisableUndoRecording(false);AddForeign(isolated,"plottable",true);
                string before=ModelState(isolated,true);
                bool rejected=false;
                try{PreviewServiceV042.Apply(isolated,Routes("plottable"),true);}catch(InvalidOperationException){rejected=true;}
                string after=ModelState(isolated,true);
                File.WriteAllText(Path.Combine(folder,"foreign_layer_state.json"),JsonSerializer.Serialize(new{rejected,before,after}));
                Require(rejected&&after==before,"Foreign layer changed; inspect foreign_layer_state.json");
            });
        }
        Test("preview_undo_disabled_refused_without_changes",()=>
        {
            using var isolated=new Database(true,true);isolated.DisableUndoRecording(true);
            string before=ModelState(isolated,true);int rejected=0,appended=0;
            try{PreviewServiceV042.Apply(isolated,Routes("no_undo"),true,_=>appended++);}
            catch(InvalidOperationException error) when(error.Message.Contains("Undo recording")){rejected++;}
            try{PreviewServiceV042.Clear(isolated,true);}
            catch(InvalidOperationException error) when(error.Message.Contains("Undo recording")){rejected++;}
            Require(PreviewServiceV042.Apply(isolated,Routes("no_undo"),false)==0&&PreviewServiceV042.Clear(isolated,false)==0,"Declined operation must remain a no-op");
            string after=ModelState(isolated,true);
            File.WriteAllText(Path.Combine(folder,"undo_disabled_state.json"),JsonSerializer.Serialize(new{rejected,appended,before,after}));
            Require(rejected==2&&appended==0&&before==after,"Undo-disabled database modified");
        });
        Test("active_drawing_unchanged_after_side_database_tests",()=>Require(ModelState(doc.Database)==activeBefore&&Application.GetSystemVariable("DBMOD").ToString()==dbmodBefore,"Active drawing changed"));
        Test("fixture_file_unchanged",()=>Require(Hash(source)==sourceHash,"Fixture file changed"));
        Test("production_python_bridge_dispatched",()=>{Require(snapshot!=null,"Export prerequisite failed");job=PythonJobV042.Start(doc,snapshot!,folder);});
        string target=Path.Combine(folder,"native_results.json"),temp=target+".tmp";
        File.WriteAllText(temp,JsonSerializer.Serialize(new{schema_version="0.42.3",run_id=run,phase=failures==0?"NATIVE_CHECKS_PASSED_WAITING_FOR_PYTHON":"FAILED",assembly_version="0.42.3.0",dll_sha256=dllHash,source_sha256=sourceHash,failures,cases,python_job=job,preview_test_scope="private_disposable_database_only"},new JsonSerializerOptions{WriteIndented=true}));
        File.Move(temp,target,true);doc.Editor.WriteMessage($"\nNSS autotest: native failed={failures}; result={target}; Python completion collected by launcher.");
    });
}
