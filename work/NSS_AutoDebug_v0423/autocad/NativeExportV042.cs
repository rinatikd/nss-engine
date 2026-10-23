using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;
using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.Geometry;
using Autodesk.AutoCAD.Runtime;

namespace NssEngine.Export;

public sealed class NativeExportV042
{
    private static double[] XYZ(Point3d p)=>new[]{p.X,p.Y,p.Z};
    private static double[] Normal(Vector3d n)=>new[]{n.X,n.Y,n.Z};
#if !NSS_DEBUG_ISOLATED
    [CommandMethod("NSS_EXPORT_V042",CommandFlags.Modal)]
#endif
    public void Export()=>ObservabilityV036.Run("NSS_EXPORT_V042",()=>
    {
        var doc=Application.DocumentManager.MdiActiveDocument??throw new InvalidOperationException("No active drawing");
        var db=doc.Database;
        int dbmodBefore=Convert.ToInt32(Application.GetSystemVariable("DBMOD"));
        var entities=new List<EntityV042>();var warnings=new List<object>();
        int visited=0,skipped=0;bool truncated=false;
        var timer=System.Diagnostics.Stopwatch.StartNew();
        using(var tr=db.TransactionManager.StartOpenCloseTransaction())
        {
            var bt=(BlockTable)tr.GetObject(db.BlockTableId,OpenMode.ForRead);
            var ms=(BlockTableRecord)tr.GetObject(bt[BlockTableRecord.ModelSpace],OpenMode.ForRead);
            foreach(ObjectId id in ms)
            {
                if(visited>=SnapshotContractV042.MaxEntities||timer.Elapsed.TotalSeconds>=25){truncated=true;warnings.Add(new{handle="",code="EXPORT_LIMIT",message="Entity or cooperative 25 second time limit reached"});break;}
                if((visited&255)==0&&HostApplicationServices.Current.UserBreak())throw new OperationCanceledException("Export cancelled");
                visited++;string handle=id.ToString();
                try
                {
                    handle=id.Handle.ToString();
                    if(tr.GetObject(id,OpenMode.ForRead) is not Entity e)throw new NotSupportedException("not an Entity");
                    EntityV042 record;
                    if(e is Line l)record=new(handle,e.Layer,"LINE",new[]{XYZ(l.StartPoint),XYZ(l.EndPoint)},Array.Empty<double>(),false,"",new(),new[]{0d,0d,1d},false);
                    else if(e is Polyline p)
                    {
                        if(p.NumberOfVertices>SnapshotContractV042.MaxVertices)throw new NotSupportedException("vertex limit");
                        var vertices=new double[p.NumberOfVertices][];var bulges=new double[p.NumberOfVertices];
                        for(int i=0;i<p.NumberOfVertices;i++){vertices[i]=XYZ(p.GetPoint3dAt(i));bulges[i]=p.GetBulgeAt(i);}
                        record=new(handle,e.Layer,"LWPOLYLINE",vertices,bulges,p.Closed,"",new(),Normal(p.Normal),false);
                    }
                    else if(e is BlockReference b)
                    {
                        if(b is MInsertBlock)throw new NotSupportedException("MINSERT array not expanded");
                        var definition=(BlockTableRecord)tr.GetObject(b.BlockTableRecord,OpenMode.ForRead);
                        var attrs=new Dictionary<string,string>(StringComparer.OrdinalIgnoreCase);
                        foreach(ObjectId aid in b.AttributeCollection)
                        {
                            try
                            {
                                if(tr.GetObject(aid,OpenMode.ForRead) is AttributeReference a)
                                {
                                    if(!attrs.TryAdd(a.Tag,a.TextString))throw new InvalidDataException("duplicate attribute tag");
                                }
                            }
                            catch(System.Exception error){throw new InvalidDataException("attribute "+aid.Handle+": "+error.Message,error);}
                        }
                        record=new(handle,e.Layer,"INSERT",new[]{XYZ(b.Position)},Array.Empty<double>(),false,definition.Name,attrs,Normal(b.Normal),definition.IsFromExternalReference||definition.IsFromOverlayReference);
                    }
                    else throw new NotSupportedException(e.GetType().Name);
                    SnapshotContractV042.Validate(record);entities.Add(record);
                    if(record.type=="INSERT")warnings.Add(new{handle,code=record.is_xref?"XREF_UNRESOLVED":"BLOCK_GEOMETRY_NOT_EXPANDED",message="Only insertion point and attributes exported; no nested geometry or connectivity inferred"});
                }
                catch(System.Exception error)
                {
                    skipped++;warnings.Add(new{handle,code=error is NotSupportedException?"UNSUPPORTED_ENTITY":"OBJECT_EXPORT_FAILED",message=error.GetType().Name+": "+error.Message});
                }
            }
        }
        var snapshot=new {
            schema_version="0.42",kind="snapshot3d",producer="AutoCAD",timestamp_utc=DateTimeOffset.UtcNow.ToString("O"),
            drawing=new{id=db.FingerprintGuid.ToString(),name=Path.GetFileName(doc.Name),insunits_code=(int)db.Insunits,coordinate_system="unverified"},
            host=new{dbmod_before=dbmodBefore,dbmod_after=Convert.ToInt32(Application.GetSystemVariable("DBMOD")),assembly_version=typeof(NativeExportV042).Assembly.GetName().Version?.ToString()},
            coverage=new{visited,exported=entities.Count,skipped,truncated,complete=skipped==0&&!truncated},entities,warnings
        };
        string folder=Environment.GetEnvironmentVariable("NSS_REPORT_DIR")??Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments),"NSS_Engine");
        Directory.CreateDirectory(folder);
        string output=Path.Combine(folder,"snapshot_v042_"+DateTime.UtcNow.ToString("yyyyMMdd_HHmmss_fff")+"_"+Guid.NewGuid().ToString("N")+".json");
        string tmp=output+".tmp";
        try{File.WriteAllText(tmp,JsonSerializer.Serialize(snapshot));File.Move(tmp,output);}
        finally{if(File.Exists(tmp))File.Delete(tmp);}
        doc.Editor.WriteMessage($"\nNSS v0.42: exported={entities.Count}, skipped={skipped}, truncated={truncated}; {output}");
    });
}
