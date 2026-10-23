using System;
using System.IO;
using System.Linq;
using System.Collections.Generic;
using System.Text.Json;
using System.Security.Cryptography;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.Geometry;
using AcApp=Autodesk.AutoCAD.ApplicationServices.Core.Application;

// Applies the existing engineering edit plan to the disposable native DWG copy.
// Source geometry is never reconstructed through DXF.
internal static class NativePrepare
{
    static Point3d P(JsonElement p)=>new(p[0].GetDouble(),p[1].GetDouble(),p.GetArrayLength()>2?p[2].GetDouble():0);
    static Entity Get(Database db,Transaction tr,string handle,OpenMode mode)=>(Entity)tr.GetObject(db.GetObjectId(false,new Handle(Convert.ToInt64(handle,16)),0),mode);
    internal static string Geometry(Entity e)=>JsonSerializer.Serialize(e switch
    {
        Line l=>(object)new{type="LINE",a=l.StartPoint.ToArray(),b=l.EndPoint.ToArray()},
        Arc a=>new{type="ARC",center=a.Center.ToArray(),a.Radius,a.StartAngle,a.EndAngle,normal=a.Normal.ToArray()},
        Polyline p=>new{type="LWPOLYLINE",p.Closed,p.Elevation,normal=p.Normal.ToArray(),vertices=Enumerable.Range(0,p.NumberOfVertices).Select(i=>new{xyz=p.GetPoint3dAt(i).ToArray(),bulge=p.GetBulgeAt(i),startWidth=p.GetStartWidthAt(i),endWidth=p.GetEndWidthAt(i)}).ToArray()},
        BlockReference b=>new{type="INSERT",position=b.Position.ToArray(),b.Rotation,scale=new[]{b.ScaleFactors.X,b.ScaleFactors.Y,b.ScaleFactors.Z},normal=b.Normal.ToArray(),definition=b.BlockTableRecord.Handle.ToString()},
        MText t=>new{type="MTEXT",t.Contents,location=t.Location.ToArray(),t.TextHeight,t.Width,t.Rotation,normal=t.Normal.ToArray()},
        _=>throw new InvalidDataException("Unsupported planned move: "+e.GetType().Name)
    });
    internal static void Run(string planPath,string evidence)
    {
        using var document=JsonDocument.Parse(File.ReadAllText(planPath));var plan=document.RootElement;
        if(!plan.GetProperty("units_confirmed").GetBoolean()||!plan.GetProperty("numbering_confirmed").GetBoolean())throw new InvalidDataException("Plan is not ready");
        var doc=AcApp.DocumentManager.MdiActiveDocument;var db=doc.Database;
        string input=Environment.GetEnvironmentVariable("NSS_TKK_NATIVE_INPUT")!;
        using(var stream=new FileStream(input,FileMode.Open,FileAccess.Read,FileShare.ReadWrite))
            if(Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant()!=plan.GetProperty("source_sha256").GetString())throw new InvalidDataException("Native source copy does not match plan SHA256");
        var before=new Dictionary<string,string>();var moves=plan.GetProperty("moves");var created=new List<object>();
        using(var tr=db.TransactionManager.StartTransaction())
        {
            var layers=(LayerTable)tr.GetObject(db.LayerTableId,OpenMode.ForWrite);
            foreach(var definition in plan.GetProperty("layers").EnumerateArray())
            {
                string name=definition.GetProperty("name").GetString()!;
                if(layers.Has(name))throw new InvalidDataException("Expected a fresh copy; target layer exists: "+name);
                var layer=new LayerTableRecord{Name=name,IsPlottable=definition.GetProperty("plot").GetBoolean(),Color=Autodesk.AutoCAD.Colors.Color.FromColorIndex(Autodesk.AutoCAD.Colors.ColorMethod.ByAci,(short)definition.GetProperty("color").GetInt32())};
                if(definition.TryGetProperty("off",out var off))layer.IsOff=off.GetBoolean();
                if(name=="NSS_REVIEW_ISSUES")layer.IsOff=true;
                layers.Add(layer);tr.AddNewlyCreatedDBObject(layer,true);
            }
            foreach(var action in moves.EnumerateArray())
            {
                string handle=action.GetProperty("handle").GetString()!;var entity=Get(db,tr,handle,OpenMode.ForWrite);
                before.Add(handle,Geometry(entity));entity.Layer=action.GetProperty("target_layer").GetString()!;
            }
            var bt=(BlockTable)tr.GetObject(db.BlockTableId,OpenMode.ForWrite);var model=(BlockTableRecord)tr.GetObject(bt[BlockTableRecord.ModelSpace],OpenMode.ForWrite);
            var definitionWell=new BlockTableRecord{Name="NSS_TKK_ADDED_WELL_NATIVE"};bt.Add(definitionWell);tr.AddNewlyCreatedDBObject(definitionWell,true);
            var template=plan.GetProperty("template_well");var reference=(BlockReference)Get(db,tr,template.GetProperty("handle").GetString()!,OpenMode.ForRead);
            var objects=new DBObjectCollection();reference.Explode(objects);var center=P(template.GetProperty("xyz"));
            foreach(DBObject obj in objects)
            {
                if(obj is not Entity entity){obj.Dispose();continue;}
                entity.TransformBy(Matrix3d.Displacement(Point3d.Origin-center));entity.LayerId=db.LayerZero;
                definitionWell.AppendEntity(entity);tr.AddNewlyCreatedDBObject(entity,true);
            }
            foreach(var well in plan.GetProperty("new_wells").EnumerateArray())
            {
                var block=new BlockReference(P(well.GetProperty("xy")),definitionWell.ObjectId){LayerId=layers[plan.GetProperty("added_well_layer").GetString()!]};
                model.AppendEntity(block);tr.AddNewlyCreatedDBObject(block,true);created.Add(new{handle=block.Handle.ToString(),xyz=block.Position.ToArray()});
            }
            const string owner="NSS_TKK_EDITOR_NOTE";var regs=(RegAppTable)tr.GetObject(db.RegAppTableId,OpenMode.ForWrite);
            if(!regs.Has(owner)){var reg=new RegAppTableRecord{Name=owner};regs.Add(reg);tr.AddNewlyCreatedDBObject(reg,true);}
            var styles=(TextStyleTable)tr.GetObject(db.TextStyleTableId,OpenMode.ForRead);
            foreach(var update in plan.GetProperty("leader_updates").EnumerateArray())
            {
                var leader=(MLeader)Get(db,tr,update.GetProperty("handle").GetString()!,OpenMode.ForWrite);
                using var text=leader.MText;text.Contents=update.GetProperty("text").GetString()!;text.TextStyleId=styles["ФЭС"];text.TextHeight=1.25;
                leader.MText=text;string key="well:"+(update.GetProperty("well_handle").ValueKind==JsonValueKind.String?update.GetProperty("well_handle").GetString():"REF_EXISTING");
                using var tag=new ResultBuffer(new TypedValue(1001,owner),new TypedValue(1000,key),new TypedValue(1000,"reference"));leader.XData=tag;
            }
            tr.Commit();
        }
        db.Insunits=UnitsValue.Meters;
        using(var tr=db.TransactionManager.StartOpenCloseTransaction())
            foreach(var action in moves.EnumerateArray())
            {
                string handle=action.GetProperty("handle").GetString()!;var entity=Get(db,tr,handle,OpenMode.ForRead);
                if(before[handle]!=Geometry(entity)||entity.Layer!=action.GetProperty("target_layer").GetString())throw new InvalidDataException("Source geometry changed: "+handle);
            }
        File.WriteAllText(Path.Combine(evidence,"native_preparation.json"),JsonSerializer.Serialize(new{moved=before.Count,added_wells=created.Count,created,geometry=before,geometry_preserved=true,source_sha256=plan.GetProperty("source_sha256").GetString()},new JsonSerializerOptions{WriteIndented=true}));
    }
}
