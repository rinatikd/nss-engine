using System;
using System.IO;
using System.Linq;
using System.Collections.Generic;
using System.Reflection;
using System.Text.Json;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.Geometry;
using Autodesk.AutoCAD.Runtime;
using AcApp=Autodesk.AutoCAD.ApplicationServices.Core.Application;

// Every edit is a distinct AutoCAD command so native Undo/Redo boundaries are real.
public sealed class NativeScenario
{
    static readonly List<object> checks=new();
    static string Folder=>Environment.GetEnvironmentVariable("NSS_TKK_NATIVE_OUT")!;
    static string Root=>Environment.GetEnvironmentVariable("NSS_TKK_PACKAGE")!;
    static Database Db=>AcApp.DocumentManager.MdiActiveDocument.Database;
    static int baselineWells,baselineSpans;static string? added;static Vector3d direction;static double[]? beforeMove;
    static string? beforeReview;
    static ViewTableRecord? beforeReviewView;
    static Type EditorType=>AppDomain.CurrentDomain.GetAssemblies().Select(a=>a.GetType("TkkEditor")).First(t=>t!=null)!;
    static JsonDocument Snapshot()=>JsonDocument.Parse(JsonSerializer.Serialize(EditorType.GetMethod("Capture",BindingFlags.NonPublic|BindingFlags.Static)!.Invoke(null,null)));
    static void Require(bool value,string message){if(!value)throw new InvalidDataException(message);}
    static void Step(string name,Action action)
    {
        try{action();checks.Add(new{name,success=true});}
        catch(System.Exception error){checks.Add(new{name,success=false,error=error.ToString()});}
        File.WriteAllText(Path.Combine(Folder,"native_scenario_summary.json"),JsonSerializer.Serialize(new{success=checks.All(c=>JsonSerializer.Serialize(c).Contains("\"success\":true")),complete=name=="final_save",checks},new JsonSerializerOptions{WriteIndented=true}));
    }
    static JsonDocument Result(int wells,int spans)
    {
        using var status=JsonDocument.Parse(File.ReadAllText(Path.Combine(Root,"EDITOR_STATUS.json")));
        Require(status.RootElement.GetProperty("phase").GetString()=="UPDATED","Editor did not finish UPDATE");
        string job=status.RootElement.GetProperty("job").GetString()!;
        var result=JsonDocument.Parse(File.ReadAllText(Path.Combine(job,"result.json")));
        Require(result.RootElement.GetProperty("leaders").GetArrayLength()==wells,"Unexpected well count");
        Require(result.RootElement.GetProperty("spans").GetArrayLength()==spans,"Unexpected span count");
        return result;
    }
    static Circle Added(Transaction tr,bool erased=false)=>(Circle)tr.GetObject(Db.GetObjectId(false,new Handle(Convert.ToInt64(added,16)),0),OpenMode.ForRead,erased);
    static double[] Adjacent(JsonElement result)=>result.GetProperty("spans").EnumerateArray().Where(s=>s.GetProperty("start").GetString()==added||s.GetProperty("end").GetString()==added).Select(s=>s.GetProperty("length_m").GetDouble()).OrderBy(n=>n).ToArray();
    [CommandMethod("NSS_TKK_NATIVE_BEGIN")]public void Begin()=>Step("public_check_and_rebuild",()=>
    {
        using var input=Snapshot();baselineWells=input.RootElement.GetProperty("wells").GetArrayLength();
        using var status=JsonDocument.Parse(File.ReadAllText(Path.Combine(Root,"EDITOR_STATUS.json")));
        Require(status.RootElement.GetProperty("phase").GetString()=="UPDATED","Public REBUILD failed");
        using var result=JsonDocument.Parse(File.ReadAllText(Path.Combine(status.RootElement.GetProperty("job").GetString()!,"result.json")));
        baselineSpans=result.RootElement.GetProperty("spans").GetArrayLength();
        File.WriteAllText(Path.Combine(Folder,"baseline_snapshot.json"),input.RootElement.GetRawText());
        File.WriteAllText(Path.Combine(Folder,"baseline_result.json"),result.RootElement.GetRawText());
    });
    [CommandMethod("NSS_TKK_NATIVE_ADD")]public void Add()=>Step("native_add_well",()=>
    {
        using var snapshot=Snapshot();var wells=snapshot.RootElement.GetProperty("wells").EnumerateArray().Select(w=>new Point3d(w.GetProperty("xyz")[0].GetDouble(),w.GetProperty("xyz")[1].GetDouble(),0)).ToArray();
        using var tr=Db.TransactionManager.StartTransaction();var bt=(BlockTable)tr.GetObject(Db.BlockTableId,OpenMode.ForRead);var model=(BlockTableRecord)tr.GetObject(bt[BlockTableRecord.ModelSpace],OpenMode.ForWrite);
        Point3d? candidate=null;double best=0;
        foreach(ObjectId id in model)
        {
            if(tr.GetObject(id,OpenMode.ForRead) is not Line line||line.Layer!="NSS_TKK_ROUTE_PROJECT")continue;
            var a=new Point3d(line.StartPoint.X,line.StartPoint.Y,0);var b=new Point3d(line.EndPoint.X,line.EndPoint.Y,0);var delta=b-a;
            if(delta.Length<20)continue;var axis=delta.GetNormal();
            var cuts=wells.Where(w=>new LineSegment3d(a,b).GetClosestPointTo(w).Point.DistanceTo(w)<=1.1).Select(w=>(w-a).DotProduct(axis)).Where(t=>t>=0&&t<=delta.Length).Distinct().OrderBy(t=>t).ToArray();
            for(int i=1;i<cuts.Length;i++)if(cuts[i]-cuts[i-1]>best){best=cuts[i]-cuts[i-1];candidate=a+axis*((cuts[i]+cuts[i-1])/2);direction=axis;}
        }
        Require(candidate!=null&&best>20,"No suitable test interval");
        var circle=new Circle(candidate!.Value,Vector3d.ZAxis,.315){Layer="NSS_TKK_WELLS_ADDED_PROJECT"};model.AppendEntity(circle);tr.AddNewlyCreatedDBObject(circle,true);added=circle.Handle.ToString();tr.Commit();
    });
    [CommandMethod("NSS_TKK_NATIVE_ASSERT_ADD")]public void AssertAdd()=>Step("public_rebuild_after_add",()=>
    {
        using var result=Result(baselineWells+1,baselineSpans+1);beforeMove=Adjacent(result.RootElement);Require(beforeMove.Length==2,"Inserted well did not split exactly one span");
    });
    [CommandMethod("NSS_TKK_NATIVE_MOVE")]public void Move()=>Step("native_move_well",()=>
    {
        using var tr=Db.TransactionManager.StartTransaction();var circle=Added(tr);circle.UpgradeOpen();circle.Center+=direction*5;tr.Commit();
    });
    [CommandMethod("NSS_TKK_NATIVE_ASSERT_MOVE")]public void AssertMove()=>Step("public_rebuild_after_move",()=>
    {
        using var result=Result(baselineWells+1,baselineSpans+1);var after=Adjacent(result.RootElement);
        Require(beforeMove!=null&&after.Length==2&&Math.Abs(after.Sum()-beforeMove.Sum())<1e-6,"Moving well changed total chain length");
        Require(Math.Abs(after[0]-beforeMove![0])>1,"Span lengths did not change after moving well");
    });
    [CommandMethod("NSS_TKK_NATIVE_DELETE")]public void Delete()=>Step("native_delete_well",()=>{using var tr=Db.TransactionManager.StartTransaction();var circle=Added(tr);circle.UpgradeOpen();circle.Erase();tr.Commit();});
    [CommandMethod("NSS_TKK_NATIVE_ASSERT_UNDO",CommandFlags.NoUndoMarker)]public void AssertUndo()=>Step("native_undo_delete",()=>{using var tr=Db.TransactionManager.StartOpenCloseTransaction();Require(!Added(tr,true).IsErased,"UNDO did not restore the well");});
    [CommandMethod("NSS_TKK_NATIVE_REVIEW_BEGIN",CommandFlags.NoUndoMarker)]public void ReviewBegin(){using var snapshot=Snapshot();beforeReview=snapshot.RootElement.GetRawText();beforeReviewView?.Dispose();beforeReviewView=AcApp.DocumentManager.MdiActiveDocument.Editor.GetCurrentView();}
    [CommandMethod("NSS_TKK_NATIVE_ASSERT_REVIEW",CommandFlags.NoUndoMarker|CommandFlags.UsePickSet|CommandFlags.Redraw)]public void AssertReview()=>Step("issue_navigation_and_read_only_geometry",()=>
    {
        using var status=JsonDocument.Parse(File.ReadAllText(Path.Combine(Root,"EDITOR_STATUS.json")));
        Require(status.RootElement.GetProperty("phase").GetString()=="CHECKED","Issue list did not complete analysis");
        string job=status.RootElement.GetProperty("job").GetString()!;
        using var result=JsonDocument.Parse(File.ReadAllText(Path.Combine(job,"result.json")));
        using var report=JsonDocument.Parse(File.ReadAllText(Path.Combine(job,"issues.json")));
        Require(report.RootElement.GetProperty("fingerprint").GetString()==result.RootElement.GetProperty("fingerprint").GetString(),"Review report fingerprint");
        var issues=result.RootElement.GetProperty("warnings").EnumerateArray().ToArray();
        var review=EditorType.Assembly.GetType("IssueReview")!;var show=review.GetMethod("Show",BindingFlags.NonPublic|BindingFlags.Static)!;
        var document=AcApp.DocumentManager.MdiActiveDocument;using var original=beforeReviewView??document.Editor.GetCurrentView();beforeReviewView=null;
        var selected=document.Editor.SelectImplied();var prior=selected.Status==Autodesk.AutoCAD.EditorInput.PromptStatus.OK?selected.Value.GetObjectIds():Array.Empty<ObjectId>();
        int visited=0;
        try
        {
            for(int i=0;i<issues.Length;i++)
            {
                using(var twist=document.Editor.GetCurrentView()){twist.ViewDirection=Vector3d.ZAxis;twist.ViewTwist=i%2==0?0:.37;document.Editor.SetCurrentView(twist);}
                show.Invoke(null,new object[]{document,i});
                using var view=document.Editor.GetCurrentView();var bounds=issues[i].GetProperty("bounds");
                if(bounds.ValueKind!=JsonValueKind.Null)
                {
                    double x0=bounds[0].GetDouble(),y0=bounds[1].GetDouble(),x1=bounds[2].GetDouble(),y1=bounds[3].GetDouble();
                    foreach(var point in new[]{new Point3d(x0,y0,0),new Point3d(x0,y1,0),new Point3d(x1,y0,0),new Point3d(x1,y1,0)})
                    {
                        double dx=point.X-view.Target.X,dy=point.Y-view.Target.Y;
                        double x=Math.Cos(view.ViewTwist)*dx-Math.Sin(view.ViewTwist)*dy,y=Math.Sin(view.ViewTwist)*dx+Math.Cos(view.ViewTwist)*dy;
                        Require(Math.Abs(x-view.CenterPoint.X)<=view.Width/2+1e-6&&Math.Abs(y-view.CenterPoint.Y)<=view.Height/2+1e-6,"Issue is outside the review viewport");
                    }
                }
                var selection=document.Editor.SelectImplied();
                Require(selection.Status==Autodesk.AutoCAD.EditorInput.PromptStatus.OK,"Issue source selection is empty");
                var expected=issues[i].GetProperty("source_ids").EnumerateArray().Select(v=>v.GetString()).ToHashSet();
                using var tr=Db.TransactionManager.StartOpenCloseTransaction();
                Require(selection.Value.GetObjectIds().All(id=>
                {
                    if(expected.Contains(id.Handle.ToString()))return true;
                    if(!expected.Contains("REF_EXISTING"))return false;
                    var entity=(Entity)tr.GetObject(id,OpenMode.ForRead);using var tag=entity.GetXDataForApplication("NSS_TKK_EDITOR_NOTE");
                    return tag?.AsArray().ElementAtOrDefault(1).Value as string=="well:REF_EXISTING";
                }),"Selected unrelated issue source");visited++;
            }
        }
        finally{document.Editor.SetCurrentView(original);document.Editor.SetImpliedSelection(prior);}
        using var after=Snapshot();Require(after.RootElement.GetRawText()==beforeReview,"Issue navigation changed source geometry");
        File.WriteAllText(Path.Combine(Folder,"native_issue_review.json"),JsonSerializer.Serialize(new{success=true,issues=visited,all_viewports_contain_issue=true,source_geometry_unchanged=true,twisted_views_checked=true},new JsonSerializerOptions{WriteIndented=true}));
    });
    [CommandMethod("NSS_TKK_NATIVE_ASSERT_REDO",CommandFlags.NoUndoMarker)]public void AssertRedo()=>Step("native_redo_delete",()=>{using var tr=Db.TransactionManager.StartOpenCloseTransaction();Require(Added(tr,true).IsErased,"REDO did not erase the well");});
    [CommandMethod("NSS_TKK_NATIVE_FINISH")]public void Finish()=>Step("final_save",()=>
    {
        using var result=Result(baselineWells,baselineSpans);
        using var snapshot=Snapshot();using var baseline=JsonDocument.Parse(File.ReadAllText(Path.Combine(Folder,"baseline_snapshot.json")));
        Require(snapshot.RootElement.GetRawText()==baseline.RootElement.GetRawText(),"Final captured geometry differs from baseline");
        string saved=Path.Combine(Folder,"native_scenario_final.dwg");Db.SaveAs(saved,DwgVersion.Current);
        File.WriteAllText(Path.Combine(Folder,"final_result.json"),result.RootElement.GetRawText());
    });
}
