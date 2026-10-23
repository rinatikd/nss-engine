using System;
using System.Collections.Generic;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.Geometry;
namespace NssEngine.Export;

// Both interactive commands and the native regression suite use these transactions.
public static class PreviewServiceV042
{
    public const string Prefix="NSS_PREVIEW_V031_",OwnerKey="NSS_ENGINE_PREVIEW_V042";
    public static bool Owned(Polyline p,Transaction tr)
    {
        if(p.ExtensionDictionary.IsNull)return false;
        var dict=(DBDictionary)tr.GetObject(p.ExtensionDictionary,OpenMode.ForRead);
        if(!dict.Contains(OwnerKey)||tr.GetObject(dict.GetAt(OwnerKey),OpenMode.ForRead) is not Xrecord record)return false;
        using var data=record.Data;var items=data?.AsArray();
        return items?.Length==1&&items[0].Value is string text&&text==OwnerKey;
    }
    public static int Apply(Database db,IReadOnlyList<PreviewRouteV042> routes,bool confirmed,Action<int>? faultAfterAppend=null)
    {
        if(!confirmed)return 0;
        if(!db.UndoRecording)throw new InvalidOperationException("Preview requires database Undo recording; no changes made");
        using var tr=db.TransactionManager.StartTransaction();
        var layers=(LayerTable)tr.GetObject(db.LayerTableId,OpenMode.ForRead);
        var table=(BlockTable)tr.GetObject(db.BlockTableId,OpenMode.ForRead);
        var model=(BlockTableRecord)tr.GetObject(table[BlockTableRecord.ModelSpace],OpenMode.ForWrite);
        int count=0;
        foreach(var route in routes)
        {
            string name=Prefix+route.Name;
            if(!layers.Has(name))
            {
                if(!layers.IsWriteEnabled)layers.UpgradeOpen();
                var layer=new LayerTableRecord{Name=name,IsPlottable=false};layers.Add(layer);tr.AddNewlyCreatedDBObject(layer,true);
            }
            else if(((LayerTableRecord)tr.GetObject(layers[name],OpenMode.ForRead)).IsPlottable)
                throw new InvalidOperationException("Existing preview layer is plottable; no user layer modified");
            // LayerId explicitly belongs to db. Never resolve a layer through WorkingDatabase.
            var poly=new Polyline(route.Points.Count){LayerId=layers[name]};
            for(int i=0;i<route.Points.Count;i++)poly.AddVertexAt(i,new Point2d(route.Points[i].X,route.Points[i].Y),0,0,0);
            model.AppendEntity(poly);tr.AddNewlyCreatedDBObject(poly,true);poly.CreateExtensionDictionary();
            var owner=(DBDictionary)tr.GetObject(poly.ExtensionDictionary,OpenMode.ForWrite);
            var record=new Xrecord{Data=new ResultBuffer(new TypedValue((int)DxfCode.Text,OwnerKey))};
            owner.SetAt(OwnerKey,record);tr.AddNewlyCreatedDBObject(record,true);
            count++;faultAfterAppend?.Invoke(count);
        }
        tr.Commit();return count;
    }
    public static int Clear(Database db,bool confirmed)
    {
        if(!confirmed)return 0;
        if(!db.UndoRecording)throw new InvalidOperationException("Preview requires database Undo recording; no changes made");
        using var tr=db.TransactionManager.StartTransaction();
        var table=(BlockTable)tr.GetObject(db.BlockTableId,OpenMode.ForRead);
        var model=(BlockTableRecord)tr.GetObject(table[BlockTableRecord.ModelSpace],OpenMode.ForRead);
        int count=0;
        foreach(ObjectId id in model)
            if(tr.GetObject(id,OpenMode.ForRead) is Polyline poly&&poly.Layer.StartsWith(Prefix,StringComparison.OrdinalIgnoreCase)&&Owned(poly,tr))
            {poly.UpgradeOpen();poly.Erase();count++;}
        tr.Commit();return count;
    }
}
