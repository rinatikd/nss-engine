using System;
using System.Linq;
using System.Collections.Generic;
using System.Text.Json;
using Autodesk.AutoCAD.DatabaseServices;

// The stamp and annotations participate in the same native transaction/Undo record.
// Rechecking actual entity state prevents a stamp from hiding manual annotation edits.
internal static class AppliedState
{
    const string Owner="NSS_TKK_EDITOR_NOTE",Stamp="NSS_TKK_EDITOR_APPLIED",Settings="NSS_TKK_EDITOR_SETTINGS";
    internal static string Plan(JsonElement result,Dictionary<string,int> pinned)=>AnalysisWorker.Hash(new
    {
        version=(typeof(AppliedState).Assembly.GetName().Version?.ToString()??"")+"|plain-black-callouts-v3",
        leaders=result.GetProperty("leaders"),captions=result.GetProperty("captions"),well_rotations=result.GetProperty("well_rotations"),pinned
    });
    static object Text(MText text,bool ignoreBackground=false)=>new
    {
        text.Contents,location=text.Location.ToArray(),normal=text.Normal.ToArray(),text.Rotation,text.TextHeight,text.Width,
        style=text.TextStyleId.Handle.ToString(),text.Attachment,BackgroundFill=ignoreBackground?false:text.BackgroundFill,UseBackgroundColor=ignoreBackground?false:text.UseBackgroundColor,BackgroundScaleFactor=ignoreBackground?1.0:text.BackgroundScaleFactor,
        text.LineSpacingStyle,text.LineSpacingFactor,text.ColorIndex
    };
    internal static object Capture(Database db,Transaction tr)
    {
        var bt=(BlockTable)tr.GetObject(db.BlockTableId,OpenMode.ForRead);
        var model=(BlockTableRecord)tr.GetObject(bt[BlockTableRecord.ModelSpace],OpenMode.ForRead);
        var entries=new List<object>();
        foreach(ObjectId id in model.Cast<ObjectId>().OrderBy(id=>id.Handle.Value))
        {
            if(tr.GetObject(id,OpenMode.ForRead) is not Entity entity)continue;
            using var data=entity.GetXDataForApplication(Owner);if(data==null)continue;
            var tag=data.AsArray().Select(v=>new{v.TypeCode,v.Value}).ToArray();
            object state;
            if(entity is MText text)state=Text(text,text.Layer=="NSS_TKK_SPAN_LABELS_PROJECT");
            else if(entity is MLeader leader)
            {
                using var content=leader.MText;
                state=new
                {
                    leader.ContentType,leader.TextHeight,style=leader.TextStyleId.Handle.ToString(),leader.ArrowSize,
                    leader.EnableDogleg,leader.DoglegLength,leader.LandingGap,normal=leader.Normal.ToArray(),
                    text=content==null?null:Text(content,true),
                    leaders=leader.GetLeaderIndexes().Cast<int>().Select(index=>new
                    {
                        dogleg=leader.GetDogleg(index).ToArray(),length=leader.GetDoglegLength(index),
                        lines=leader.GetLeaderLineIndexes(index).Cast<int>().Select(line=>new
                        {
                            vertices=Enumerable.Range(0,leader.VerticesCount(line)).Select(i=>leader.GetVertex(line,i).ToArray()).ToArray(),
                            arrow=leader.GetArrowSize(line),symbol=leader.GetArrowSymbolId(line).Handle.ToString(),
                            type=leader.GetLeaderLineType(line),weight=leader.GetLeaderLineWeight(line)
                        }).ToArray()
                    }).ToArray()
                };
            }
            else state=new{type=entity.GetType().FullName};
            entries.Add(new{handle=id.Handle.ToString(),tag,entity.Layer,entity.ColorIndex,entity.Visible,entity.LinetypeScale,entity.LineWeight,state});
        }
        var nod=(DBDictionary)tr.GetObject(db.NamedObjectsDictionaryId,OpenMode.ForRead);
        string? settings=null;
        if(nod.Contains(Settings)){using var data=((Xrecord)tr.GetObject(nod.GetAt(Settings),OpenMode.ForRead)).Data;settings=string.Concat(data.AsArray().Select(v=>(string)v.Value));}
        var styles=(TextStyleTable)tr.GetObject(db.TextStyleTableId,OpenMode.ForRead);
        var style=(TextStyleTableRecord)tr.GetObject(styles["ФЭС"],OpenMode.ForRead);
        return new{entries,settings,font=new{style.FileName,style.BigFontFileName,style.TextSize,style.XScale,style.ObliquingAngle}};
    }
    internal static string Hash(Database db,Transaction tr)=>AnalysisWorker.Hash(Capture(db,tr));
    internal static bool Matches(Database db,string plan)
    {
        using var tr=db.TransactionManager.StartOpenCloseTransaction();
        var nod=(DBDictionary)tr.GetObject(db.NamedObjectsDictionaryId,OpenMode.ForRead);
        if(!nod.Contains(Stamp))return false;
        using var data=((Xrecord)tr.GetObject(nod.GetAt(Stamp),OpenMode.ForRead)).Data;
        var values=data?.AsArray();
        return values?.Length==2&&values[0].Value as string==plan&&values[1].Value as string==Hash(db,tr);
    }
    internal static void Store(Database db,Transaction tr,string plan)
    {
        string hash=Hash(db,tr);
        var nod=(DBDictionary)tr.GetObject(db.NamedObjectsDictionaryId,OpenMode.ForWrite);
        Xrecord record;
        if(nod.Contains(Stamp))record=(Xrecord)tr.GetObject(nod.GetAt(Stamp),OpenMode.ForWrite);
        else{record=new Xrecord();nod.SetAt(Stamp,record);tr.AddNewlyCreatedDBObject(record,true);}
        using var data=new ResultBuffer(new TypedValue((int)DxfCode.Text,plan),new TypedValue((int)DxfCode.Text,hash));record.Data=data;
    }
}
