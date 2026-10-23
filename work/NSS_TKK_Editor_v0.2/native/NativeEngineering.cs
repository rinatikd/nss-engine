using System;
using System.IO;
using System.Linq;
using System.Collections.Generic;
using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.Geometry;
using Autodesk.AutoCAD.Runtime;
using AcApp = Autodesk.AutoCAD.ApplicationServices.Core.Application;

// Explicit, hash-bound draft edits on the disposable copy created by run_native.py.
// No heuristic connection, tolerance change, well insertion, or flattening of Z.
public sealed class NativeEngineering
{
    sealed class TrackSourceWrites : IDisposable
    {
        readonly Database db;
        readonly HashSet<string> originals;
        internal readonly HashSet<string> Changed=new();
        internal TrackSourceWrites(Database database)
        {
            db=database;
            using var tr=db.TransactionManager.StartOpenCloseTransaction();
            var bt=(BlockTable)tr.GetObject(db.BlockTableId,OpenMode.ForRead);
            var model=(BlockTableRecord)tr.GetObject(bt[BlockTableRecord.ModelSpace],OpenMode.ForRead);
            originals=model.Cast<ObjectId>().Select(id=>id.Handle.ToString()).ToHashSet();
            db.ObjectModified+=Modified;
        }
        void Modified(object sender,ObjectEventArgs args)
        {
            if(args.DBObject is Entity entity&&originals.Contains(entity.Handle.ToString()))Changed.Add(entity.Handle.ToString());
        }
        public void Dispose()=>db.ObjectModified-=Modified;
    }
    static Dictionary<string,string> Tables(Database db)
    {
        using var tr=db.TransactionManager.StartOpenCloseTransaction();
        var bt=(BlockTable)tr.GetObject(db.BlockTableId,OpenMode.ForRead);
        var model=(BlockTableRecord)tr.GetObject(bt[BlockTableRecord.ModelSpace],OpenMode.ForRead);
        return model.Cast<ObjectId>().Select(id=>tr.GetObject(id,OpenMode.ForRead)).OfType<Table>().ToDictionary(t=>t.Handle.ToString(),t=>JsonSerializer.Serialize(new{
            position=t.Position.ToArray(),normal=t.Normal.ToArray(),direction=t.Direction.ToArray(),style=t.TableStyle.Handle.ToString(),
            rows=Enumerable.Range(0,t.Rows.Count).Select(r=>t.Rows[r].Height).ToArray(),columns=Enumerable.Range(0,t.Columns.Count).Select(c=>t.Columns[c].Width).ToArray(),
            cells=Enumerable.Range(0,t.Rows.Count).Select(r=>Enumerable.Range(0,t.Columns.Count).Select(c=>t.Cells[r,c].TextString).ToArray()).ToArray()}));
    }
    static Point3d P(JsonElement p)=>new(p[0].GetDouble(),p[1].GetDouble(),p[2].GetDouble());
    static Entity Get(Database db,Transaction tr,string handle,OpenMode mode)=>(Entity)tr.GetObject(db.GetObjectId(false,new Handle(Convert.ToInt64(handle,16)),0),mode);
    static string Hash(string path)
    {
        using var stream=new FileStream(path,FileMode.Open,FileAccess.Read,FileShare.ReadWrite);
        return Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
    }
    static (Point3d center,double radius) WellCircle(BlockReference block,Transaction tr)
    {
        var definition=(BlockTableRecord)tr.GetObject(block.BlockTableRecord,OpenMode.ForRead);
        var circles=definition.Cast<ObjectId>().Select(id=>tr.GetObject(id,OpenMode.ForRead)).OfType<Circle>().ToArray();
        if(circles.Length!=1)throw new InvalidDataException("Expected exactly one circular project-well symbol");
        using var world=(Circle)circles[0].GetTransformedCopy(block.BlockTransform);
        if(world.Normal.GetNormal().GetAngleTo(Vector3d.ZAxis)>1e-8)throw new InvalidDataException("Well symbol is not horizontal");
        return (world.Center,world.Radius);
    }

    [CommandMethod("NSS_TKK_NATIVE_ENGINEERING",CommandFlags.Modal)]
    public void Run()
    {
        string evidence=Environment.GetEnvironmentVariable("NSS_TKK_NATIVE_OUT")!;
        var changes=new List<object>();
        try
        {
            string planPath=Environment.GetEnvironmentVariable("NSS_TKK_ENGINEERING_PLAN")!;
            using var document=JsonDocument.Parse(File.ReadAllText(planPath));var plan=document.RootElement;
            if(plan.GetProperty("kind").GetString()!="NSS_ENGINEERING_REVIEW_DRAFT"||plan.GetProperty("schema_version").GetInt32()!=1)throw new InvalidDataException("Unsupported engineering plan");
            string input=Environment.GetEnvironmentVariable("NSS_TKK_NATIVE_INPUT")!;
            var doc=AcApp.DocumentManager.MdiActiveDocument;var db=doc.Database;
            if(!Path.GetFullPath(input).Equals(Path.GetFullPath(db.Filename),StringComparison.OrdinalIgnoreCase)||!Path.GetDirectoryName(input)!.Equals(evidence,StringComparison.OrdinalIgnoreCase))throw new InvalidDataException("Only the runner's disposable input is allowed");
            if(Hash(input)!=plan.GetProperty("baseline_sha256").GetString())throw new InvalidDataException("Baseline DWG SHA256 differs from plan");
            var edits=plan.GetProperty("edits").EnumerateArray().ToArray();
            if(edits.Length!=6||edits.Select(e=>e.GetProperty("handle").GetString()).Distinct().Count()!=6)throw new InvalidDataException("Expected six distinct, explicit edits");
            string root=Environment.GetEnvironmentVariable("NSS_TKK_PACKAGE")!;
            var type=Assembly.LoadFrom(Directory.GetFiles(Path.Combine(root,"plugin"),"NssTkkEditor.V*.dll").Single()).GetType("TkkEditor")!;
            var flags=BindingFlags.Static|BindingFlags.NonPublic;
            type.GetField("doc",flags)!.SetValue(null,doc);
            type.GetField("pinned",flags)!.SetValue(null,JsonSerializer.Deserialize<Dictionary<string,int>>(File.ReadAllText(Path.Combine(root,"protected_numbers.json")))!);
            File.WriteAllText(Path.Combine(evidence,"engineering_snapshot_before.json"),JsonSerializer.Serialize(type.GetMethod("Capture",flags)!.Invoke(null,null)));
            db.DxfOut(Path.Combine(evidence,"engineering_before.dxf"),16,DwgVersion.AC1032);
            var tablesBefore=Tables(db);
            using var originalReport=JsonDocument.Parse(File.ReadAllText(plan.GetProperty("original_geometry_report").GetString()!));
            var expected=originalReport.RootElement.GetProperty("geometry").EnumerateObject().ToDictionary(p=>p.Name,p=>p.Value.GetString()!);
            using var sourceWrites=new TrackSourceWrites(db);
            using(var tr=db.TransactionManager.StartTransaction())
            {
                foreach(var item in expected)
                    if(NativePrepare.Geometry(Get(db,tr,item.Key,OpenMode.ForRead))!=item.Value)throw new InvalidDataException("Unexpected original geometry: "+item.Key);
                foreach(var edit in edits)
                {
                    string handle=edit.GetProperty("handle").GetString()!;
                    var entity=Get(db,tr,handle,OpenMode.ForWrite);
                    if(entity.Layer!="NSS_TKK_ROUTE_PROJECT")throw new InvalidDataException("Only a project-route entity can be trimmed");
                    var before=P(edit.GetProperty("before_xyz"));var after=P(edit.GetProperty("after_xyz"));
                    var well=(BlockReference)Get(db,tr,edit.GetProperty("well_handle").GetString()!,OpenMode.ForRead);
                    if(well.Layer!="NSS_TKK_WELLS_PROJECT"&&well.Layer!="NSS_TKK_WELLS_ADDED_PROJECT")throw new InvalidDataException("Only a circular project well can anchor this edit");
                    var circle=WellCircle(well,tr);
                    if(circle.center.DistanceTo(P(edit.GetProperty("well_xyz")))>1e-7||Math.Abs(circle.radius-edit.GetProperty("measured_radius_m").GetDouble())>1e-7)throw new InvalidDataException("Native well geometry differs from measured plan");
                    double removed=before.DistanceTo(after);
                    if(removed<=.005||removed>=.2||removed>=circle.radius||Math.Abs(removed-edit.GetProperty("removed_m").GetDouble())>1e-8)throw new InvalidDataException("Trim length is outside the explicit small-residual limit");
                    if(before.DistanceTo(circle.center)>=circle.radius||after.DistanceTo(circle.center)>=circle.radius||Math.Abs(before.Z-circle.center.Z)>1e-6||Math.Abs(after.Z-circle.center.Z)>1e-6)throw new InvalidDataException("Residual is not contained in the same horizontal well symbol");
                    bool start=edit.GetProperty("endpoint").GetString()=="start";
                    Point3d nativeBefore,neighbor;
                    if(entity is Line line){nativeBefore=start?line.StartPoint:line.EndPoint;neighbor=start?line.EndPoint:line.StartPoint;}
                    else if(entity is Polyline poly)
                    {
                        if(poly.Closed||poly.NumberOfVertices<2||poly.Normal.GetNormal().GetAngleTo(Vector3d.ZAxis)>1e-8)throw new InvalidDataException("Expected an open horizontal polyline");
                        int index=start?0:poly.NumberOfVertices-1,segment=start?0:poly.NumberOfVertices-2;
                        if(Math.Abs(poly.GetBulgeAt(segment))>1e-12)throw new InvalidDataException("A curved endpoint segment cannot be trimmed by this plan");
                        nativeBefore=poly.GetPoint3dAt(index);neighbor=poly.GetPoint3dAt(start?1:poly.NumberOfVertices-2);
                    }
                    else throw new InvalidDataException("Unsupported engineering-edit type");
                    if(nativeBefore.DistanceTo(before)>1e-8)throw new InvalidDataException("Original endpoint changed: "+handle);
                    using(var segment=new Line(nativeBefore,neighbor))
                        if(segment.GetClosestPointTo(after,false).DistanceTo(after)>1e-8||segment.GetClosestPointTo(circle.center,false).DistanceTo(after)>1e-7)throw new InvalidDataException("Target is not the center projection on the original endpoint segment");
                    string previous=NativePrepare.Geometry(entity);
                    if(entity is Line target){if(start)target.StartPoint=after;else target.EndPoint=after;}
                    else
                    {
                        var targetPoly=(Polyline)entity;targetPoly.SetPointAt(start?0:targetPoly.NumberOfVertices-1,new Point2d(after.X,after.Y));
                    }
                    string current=NativePrepare.Geometry(entity);expected[handle]=current;
                    changes.Add(new{handle,issue=edit.GetProperty("issue_number").GetInt32(),before=previous,after=current,removed_m=removed});
                }
                var layers=(LayerTable)tr.GetObject(db.LayerTableId,OpenMode.ForWrite);
                const string layerName="NSS_TKK_ENGINEERING_REVIEW";
                if(layers.Has(layerName))throw new InvalidDataException("Expected a fresh review copy");
                var reviewLayer=new LayerTableRecord{Name=layerName,IsPlottable=false};layers.Add(reviewLayer);tr.AddNewlyCreatedDBObject(reviewLayer,true);
                var bt=(BlockTable)tr.GetObject(db.BlockTableId,OpenMode.ForRead);
                var model=(BlockTableRecord)tr.GetObject(bt[BlockTableRecord.ModelSpace],OpenMode.ForWrite);
                var styles=(TextStyleTable)tr.GetObject(db.TextStyleTableId,OpenMode.ForRead);
                var views=(ViewTable)tr.GetObject(db.ViewTableId,OpenMode.ForWrite);
                int count=0;
                foreach(var item in plan.GetProperty("review").EnumerateArray())
                {
                    var xy=item.GetProperty("xy");var center=new Point3d(xy[0].GetDouble(),xy[1].GetDouble(),0);
                    short color=item.GetProperty("status").GetString() switch{"FIXED_ON_COPY"=>3,"EXPLAINED_REFERENCE"=>4,_=>30};
                    var ring=new Circle(center,Vector3d.ZAxis,2){LayerId=reviewLayer.ObjectId,ColorIndex=color};model.AppendEntity(ring);tr.AddNewlyCreatedDBObject(ring,true);
                    var text=new MText{Location=center+new Vector3d(3,4,0),Contents=item.GetProperty("label").GetString()!,TextHeight=1.4,Width=25,LayerId=reviewLayer.ObjectId,ColorIndex=color};
                    if(styles.Has("ФЭС"))text.TextStyleId=styles["ФЭС"];
                    model.AppendEntity(text);tr.AddNewlyCreatedDBObject(text,true);
                    var bounds=item.GetProperty("bounds");double x1=bounds[0].GetDouble(),y1=bounds[1].GetDouble(),x2=bounds[2].GetDouble(),y2=bounds[3].GetDouble();
                    double height=Math.Max(36,Math.Max(y2-y1+16,(x2-x1+16)/1.6));
                    var view=new ViewTableRecord{Name=item.GetProperty("view").GetString()!,CenterPoint=new Point2d((x1+x2)/2,(y1+y2)/2),Height=height,Width=height*1.6,ViewDirection=Vector3d.ZAxis,Target=Point3d.Origin,ViewTwist=0};
                    if(views.Has(view.Name))throw new InvalidDataException("Review view already exists");
                    views.Add(view);tr.AddNewlyCreatedDBObject(view,true);count++;
                }
                if(count!=29)throw new InvalidDataException("Expected all 29 original review views");
                reviewLayer.IsLocked=true;
                tr.Commit();
            }
            sourceWrites.Dispose();
            if(!sourceWrites.Changed.SetEquals(edits.Select(e=>e.GetProperty("handle").GetString()!)))throw new InvalidDataException("Unplanned source-entity writes during the transaction: "+string.Join(",",sourceWrites.Changed));
            if(JsonSerializer.Serialize(tablesBefore)!=JsonSerializer.Serialize(Tables(db)))throw new InvalidDataException("Original table content or placement changed");
            using(var tr=db.TransactionManager.StartOpenCloseTransaction())
                foreach(var item in expected)
                    if(NativePrepare.Geometry(Get(db,tr,item.Key,OpenMode.ForRead))!=item.Value)throw new InvalidDataException("Unplanned geometry after engineering transaction: "+item.Key);
            db.DxfOut(Path.Combine(evidence,"engineering_after.dxf"),16,DwgVersion.AC1032);
            File.WriteAllText(Path.Combine(evidence,"engineering_expected_geometry.json"),JsonSerializer.Serialize(new{geometry=expected,tables=tablesBefore},new JsonSerializerOptions{WriteIndented=true}));
            File.WriteAllText(Path.Combine(evidence,"engineering_summary.json"),JsonSerializer.Serialize(new{success=true,plan_sha256=Hash(planPath),input_sha256=Hash(input),changes,source_entities_checked=expected.Count,source_entities_modified=sourceWrites.Changed.OrderBy(s=>s).ToArray(),native_tables_unchanged=tablesBefore.Count,named_views=29,nonplot_review_markers=58,project_wells_added=0,global_tolerances_changed=false,heights_flattened=false},new JsonSerializerOptions{WriteIndented=true}));
        }
        catch(System.Exception error)
        {
            File.WriteAllText(Path.Combine(evidence,"engineering_summary.json"),JsonSerializer.Serialize(new{success=false,changes,error=error.ToString()},new JsonSerializerOptions{WriteIndented=true}));
        }
    }

    [CommandMethod("NSS_TKK_NATIVE_ENGINEERING_VERIFY",CommandFlags.Modal|CommandFlags.NoUndoMarker)]
    public void VerifyReopened()
    {
        string evidence=Environment.GetEnvironmentVariable("NSS_TKK_NATIVE_OUT")!;
        try
        {
            var db=AcApp.DocumentManager.MdiActiveDocument.Database;
            using var report=JsonDocument.Parse(File.ReadAllText(Environment.GetEnvironmentVariable("NSS_TKK_GEOMETRY_REPORT")!));
            var expectedTables=JsonSerializer.Deserialize<Dictionary<string,string>>(report.RootElement.GetProperty("tables").GetRawText())!;
            if(JsonSerializer.Serialize(expectedTables)!=JsonSerializer.Serialize(Tables(db)))throw new InvalidDataException("Reopened table content or placement differs");
            using var tr=db.TransactionManager.StartOpenCloseTransaction();
            var views=(ViewTable)tr.GetObject(db.ViewTableId,OpenMode.ForRead);
            for(int n=1;n<=29;n++)
            {
                string name=$"NSS_R{n:00}";
                if(!views.Has(name))throw new InvalidDataException("Missing saved review view: "+name);
                var view=(ViewTableRecord)tr.GetObject(views[name],OpenMode.ForRead);
                if(view.Height<36||view.Width<view.Height||view.ViewDirection.GetNormal().GetAngleTo(Vector3d.ZAxis)>1e-8||Math.Abs(view.ViewTwist)>1e-8)throw new InvalidDataException("Invalid saved review view: "+name);
            }
            var layers=(LayerTable)tr.GetObject(db.LayerTableId,OpenMode.ForRead);
            var layer=(LayerTableRecord)tr.GetObject(layers["NSS_TKK_ENGINEERING_REVIEW"],OpenMode.ForRead);
            if(layer.IsPlottable||layer.IsOff||layer.IsFrozen||!layer.IsLocked)throw new InvalidDataException("Review layer properties differ after reopening");
            var bt=(BlockTable)tr.GetObject(db.BlockTableId,OpenMode.ForRead);
            var model=(BlockTableRecord)tr.GetObject(bt[BlockTableRecord.ModelSpace],OpenMode.ForRead);
            var markers=model.Cast<ObjectId>().Select(id=>tr.GetObject(id,OpenMode.ForRead)).OfType<Entity>().Where(e=>e.LayerId==layer.ObjectId).ToArray();
            if(markers.OfType<Circle>().Count()!=29||markers.OfType<MText>().Count()!=29||markers.Length!=58)throw new InvalidDataException("Saved review markers differ");
            File.WriteAllText(Path.Combine(evidence,"engineering_reopened.json"),JsonSerializer.Serialize(new{success=true,named_views=29,nonplot_markers=58,native_tables_unchanged=expectedTables.Count,read_only=true},new JsonSerializerOptions{WriteIndented=true}));
        }
        catch(System.Exception error)
        {
            File.WriteAllText(Path.Combine(evidence,"engineering_reopened.json"),JsonSerializer.Serialize(new{success=false,error=error.ToString()},new JsonSerializerOptions{WriteIndented=true}));
        }
    }
}
