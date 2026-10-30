using System;
using System.IO;
using System.Linq;
using System.Collections.Generic;
using System.Reflection;
using System.Text.Json;
using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.Geometry;
using Autodesk.AutoCAD.Runtime;
using AcApp=Autodesk.AutoCAD.ApplicationServices.Core.Application;

public sealed class TkkEditor:IExtensionApplication
{
    const string Owner="NSS_TKK_EDITOR_NOTE",Settings="NSS_TKK_EDITOR_SETTINGS";
    static readonly string Root=Directory.GetParent(Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location)!)!.FullName;
    static Document? doc;static bool auto,dirty,applying;static long generation;
    static DateTime changed;static AnalysisWorker? worker;static JsonDocument? readyToApply;static string? lastFingerprint;
    static DateTime applyQueued;
    static Dictionary<string,int> pinned=new();
    static readonly HashSet<string> RouteLayers=new(StringComparer.OrdinalIgnoreCase){"NSS_TKK_ROUTE_PROJECT","пр_телефонная_канализация"};
    static readonly HashSet<string> WellLayers=new(StringComparer.OrdinalIgnoreCase){"NSS_TKK_WELLS_PROJECT","NSS_TKK_WELLS_ADDED_PROJECT","пр_телефонная_канализация"};
    public void Initialize(){AcApp.Idle+=Idle;AcApp.DocumentManager.DocumentToBeDestroyed+=Closing;}
    public void Terminate(){Detach();AcApp.Idle-=Idle;AcApp.DocumentManager.DocumentToBeDestroyed-=Closing;}
    static void Closing(object sender,DocumentCollectionEventArgs e){if(e.Document==doc)Detach();}
    static void Detach()
    {
        CancelWorker();
        IssueReview.Clear();
        if(doc!=null){try{doc.Database.ObjectModified-=Changed;doc.Database.ObjectAppended-=Changed;doc.Database.ObjectErased-=Erased;}catch{}}
        doc=null;auto=false;dirty=false;generation++;lastFingerprint=null;
    }
    static void CancelWorker(){readyToApply?.Dispose();readyToApply=null;var previous=worker;worker=null;previous?.Dispose();}
    static (string key,string role)? Tag(Entity e)
    {
        using var data=e.GetXDataForApplication(Owner);var values=data?.AsArray();
        if(values?.Length>=3&&values[1].Value is string key&&values[2].Value is string role)return(key,role);
        return null;
    }
    static void Changed(object sender,ObjectEventArgs e)
        =>GeometryChanged(e.DBObject);
    static void GeometryChanged(DBObject changedObject)
    {
        if((!auto&&worker==null)||applying||changedObject is not Entity entity)return;
        try{var tag=Tag(entity);if(tag!=null&&tag.Value.key!="well:REF_EXISTING")return;}catch{}
        dirty=true;changed=DateTime.UtcNow;generation++;
    }
    static void Erased(object sender,ObjectErasedEventArgs e){GeometryChanged(e.DBObject);}
    static void Setup(bool automatic)
    {
        var current=AcApp.DocumentManager.MdiActiveDocument??throw new InvalidOperationException("No drawing");
        string name=Path.GetFileNameWithoutExtension(current.Name);
        Dictionary<string,int> nextPinned;
        using(var tr=current.Database.TransactionManager.StartOpenCloseTransaction())
        {
            var nod=(DBDictionary)tr.GetObject(current.Database.NamedObjectsDictionaryId,OpenMode.ForRead);
            if(!name.StartsWith("NSS_20_10_26_RESULT_MLEADER",StringComparison.OrdinalIgnoreCase)&&!nod.Contains(Settings))throw new InvalidOperationException("Open the NSS RESULT working copy first. Original drawing is not authorized for automatic edits.");
            if(nod.Contains(Settings))
            {
                var record=(Xrecord)tr.GetObject(nod.GetAt(Settings),OpenMode.ForRead);using var rb=record.Data;
                nextPinned=JsonSerializer.Deserialize<Dictionary<string,int>>(string.Concat(rb.AsArray().Select(v=>(string)v.Value)))!;
            }
            else nextPinned=JsonSerializer.Deserialize<Dictionary<string,int>>(File.ReadAllText(Path.Combine(Root,"protected_numbers.json")))!;
        }
        if(current.Name.EndsWith("source_original.dwg",StringComparison.OrdinalIgnoreCase)||name=="Сети НСС 20.10.26")throw new InvalidOperationException("Original DWG is read-only for this workflow");
        if(!current.Database.UndoRecording)throw new InvalidOperationException("Enable drawing Undo recording before editing annotations");
        if(current.Database.Insunits!=UnitsValue.Meters)throw new InvalidOperationException("This workflow requires drawing units Meters; geometry will not be rescaled automatically");
        if(!File.Exists(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Fonts),"isocpeui.ttf")))throw new FileNotFoundException("Install the source ФЭС font isocpeui.ttf before generating labels");
        if(nextPinned==null||nextPinned.Values.Any(n=>n<=0)||nextPinned.Values.Distinct().Count()!=nextPinned.Count)throw new InvalidDataException("Invalid protected well numbers");
        if(doc!=current){Detach();doc=current;doc.Database.ObjectModified+=Changed;doc.Database.ObjectAppended+=Changed;doc.Database.ObjectErased+=Erased;}
        CancelWorker();pinned=nextPinned;lastFingerprint=null;
        auto=automatic||auto;dirty=true;changed=DateTime.UtcNow.AddSeconds(-2);generation++;
        WriteStatus("QUEUED");
        current.Editor.WriteMessage(automatic?"\nNSS auto-update enabled. Geometry edits trigger an asynchronous update after commands finish.":"\nNSS update queued; completion is not confirmed yet.");
    }
    [CommandMethod("NSS_TKK_AUTO_ON",CommandFlags.Modal)]public void On(){try{Setup(true);}catch(System.Exception e){Report(e);}}
    [CommandMethod("NSS_TKK_UPDATE",CommandFlags.Modal)]public void Update(){try{Setup(false);}catch(System.Exception e){Report(e);}}
    [CommandMethod("NSS_TKK_AUTO_OFF",CommandFlags.Modal|CommandFlags.NoUndoMarker)]public void Off(){try{auto=false;dirty=false;generation++;CancelWorker();WriteStatus("DISABLED");doc?.Editor.WriteMessage("\nNSS auto-update disabled. Existing annotations kept.");}catch(System.Exception e){Report(e);}}
    [CommandMethod("NSS_TKK_CHECK",CommandFlags.Modal|CommandFlags.NoUndoMarker)]public void Check(){RunNow(false);}
    [CommandMethod("NSS_TKK_REBUILD",CommandFlags.Modal)]public void Rebuild(){RunNow(true);}
    [CommandMethod("NSS_TKK_STATUS",CommandFlags.Modal|CommandFlags.NoUndoMarker)]public void Status(){AcApp.DocumentManager.MdiActiveDocument?.Editor.WriteMessage($"\nNSS TKK v0.2.3: drawing={doc?.Name??"none"}, auto={auto}, pending={dirty}, running={worker!=null}. Status: {Path.Combine(Root,"EDITOR_STATUS.json")}");}
    [CommandMethod("NSS_TKK_ISSUES",CommandFlags.Modal|CommandFlags.NoUndoMarker)]public void Issues(){try{if(EnsureReview(true))IssueReview.List(doc!);}catch(System.Exception e){Report(e);}}
    [CommandMethod("NSS_TKK_NEXT_ISSUE",CommandFlags.Modal|CommandFlags.NoUndoMarker|CommandFlags.UsePickSet|CommandFlags.Redraw)]public void NextIssue(){try{if(EnsureReview(false))IssueReview.Next(doc!);}catch(System.Exception e){Report(e);}}
    [CommandMethod("NSS_TKK_ISSUE",CommandFlags.Modal|CommandFlags.NoUndoMarker|CommandFlags.UsePickSet|CommandFlags.Redraw)]public void ChooseIssue()
    {
        try
        {
            if(!EnsureReview(false))return;
            if(IssueReview.Count==0){IssueReview.Next(doc!);return;}
            var prompt=new Autodesk.AutoCAD.EditorInput.PromptIntegerOptions($"\nNSS issue number [1..{IssueReview.Count}]: "){LowerLimit=1,UpperLimit=IssueReview.Count,AllowNone=false};
            var choice=doc!.Editor.GetInteger(prompt);if(choice.Status==Autodesk.AutoCAD.EditorInput.PromptStatus.OK)IssueReview.Show(doc,choice.Value-1);
        }
        catch(System.Exception e){Report(e);}
    }
    static bool EnsureReview(bool force)
    {
        if(!force&&doc!=null&&doc==AcApp.DocumentManager.MdiActiveDocument)
        {
            using var locked=doc.LockDocument();if(IssueReview.Matches(doc,Fingerprint(Capture())))return true;
        }
        return RunNow(false);
    }
    [LispFunction("NSS_TKK_EDITOR_ENABLE_V002")]public ResultBuffer? Enable(ResultBuffer args){On();return null;}
    static void WriteStatus(string phase,object? details=null)=>AtomicJson.Write(Path.Combine(Root,"EDITOR_STATUS.json"),new{phase,version="0.2.3",utc=DateTime.UtcNow,drawing=doc?.Name,auto_enabled=auto,generation,job=worker?.Folder,details});
    static void Completed(JsonElement value,bool applied)
    {
        IssueReview.Set(doc!,value,worker!.Fingerprint,worker.Folder);
        WriteStatus(applied?"UPDATED":"CHECKED",new{wells=value.GetProperty("leaders").GetArrayLength(),spans=value.GetProperty("spans").GetArrayLength(),warnings=value.GetProperty("warnings")});
        doc?.Editor.WriteMessage($"\nNSS {(applied?"updated":"checked")}: wells={value.GetProperty("leaders").GetArrayLength()}, spans={value.GetProperty("spans").GetArrayLength()}, warnings={value.GetProperty("warnings").GetArrayLength()}. Reports: {worker?.Folder}");
    }
    static bool RunNow(bool apply)
    {
        try
        {
            Setup(false);dirty=false;
            using var locked=doc!.LockDocument();var snapshot=Capture();
            worker=new AnalysisWorker(Root,snapshot,generation);WriteStatus("RUNNING");
            using var result=worker.Wait();
            if(Fingerprint(Capture())!=worker.Fingerprint)throw new InvalidDataException("Drawing changed during analysis; result discarded");
            if(apply){Apply(result.RootElement);lastFingerprint=worker.Fingerprint;}
            Completed(result.RootElement,apply);dirty=!apply&&auto;
            return true;
        }
        catch(System.Exception e){dirty=false;Report(e);return false;}
        finally{CancelWorker();}
    }
    static void Report(System.Exception e)
    {
        CancelWorker();
        IssueReview.Clear();
        try{Directory.CreateDirectory(Root);File.WriteAllText(Path.Combine(Root,"EDITOR_ERROR.txt"),e.ToString());WriteStatus("FAILED",new{error=e.ToString()});}catch{}
        try{(doc??AcApp.DocumentManager.MdiActiveDocument)?.Editor.WriteMessage("\nNSS editor error: "+e.Message);}catch{}
    }
    static double[] P(Point3d p)=>new[]{p.X,p.Y,p.Z};
    static Point3d P(JsonElement a)=>new(a[0].GetDouble(),a[1].GetDouble(),a.GetArrayLength()>2?a[2].GetDouble():0);
    static List<double[]> CurvePoints(Curve curve)
    {
        var points=new List<double[]>();
        void Sample(double a,double b,Point3d start,Point3d end,int depth)
        {
            var mid=curve.GetPointAtParameter((a+b)/2);double dx=end.X-start.X,dy=end.Y-start.Y,d=dx*dx+dy*dy;
            double t=d==0?0:Math.Max(0,Math.Min(1,((mid.X-start.X)*dx+(mid.Y-start.Y)*dy)/d));
            double error=Math.Sqrt(Math.Pow(mid.X-start.X-t*dx,2)+Math.Pow(mid.Y-start.Y-t*dy,2));
            if(error>.002&&depth<14){Sample(a,(a+b)/2,start,mid,depth+1);Sample((a+b)/2,b,mid,end,depth+1);}else points.Add(P(end));
        }
        points.Add(P(curve.StartPoint));
        if(curve is Polyline poly)
        {
            int n=poly.NumberOfVertices-(poly.Closed?0:1);
            for(int i=0;i<n;i++)Sample(i,i+1,curve.GetPointAtParameter(i),curve.GetPointAtParameter(i+1),0);
        }
        else Sample(curve.StartParam,curve.EndParam,curve.StartPoint,curve.EndPoint,0);
        if(points.Count>100000)throw new InvalidDataException("Route sampling limit exceeded");return points;
    }
    static double[]? Center(BlockReference reference,Transaction tr)
    {
        var definition=(BlockTableRecord)tr.GetObject(reference.BlockTableRecord,OpenMode.ForRead);
        foreach(ObjectId id in definition)
        {
            var entity=tr.GetObject(id,OpenMode.ForRead);
            if(entity is Circle circle)return P(circle.Center.TransformBy(reference.BlockTransform));
            if(entity is Ellipse ellipse)return P(ellipse.Center.TransformBy(reference.BlockTransform));
        }
        return null;
    }
    static object Capture()
    {
        if(doc==null)throw new InvalidOperationException("Drawing closed");
        var db=doc.Database;var routes=new List<object>();var wells=new List<object>();var descriptions=new Dictionary<string,(string text,int number)>();
        using var tr=db.TransactionManager.StartOpenCloseTransaction();var bt=(BlockTable)tr.GetObject(db.BlockTableId,OpenMode.ForRead);var model=(BlockTableRecord)tr.GetObject(bt[BlockTableRecord.ModelSpace],OpenMode.ForRead);
        foreach(ObjectId id in model)
        {
            if(tr.GetObject(id,OpenMode.ForRead) is not Entity e)continue;var tag=Tag(e);
            if(tag!=null&&tag.Value.key.StartsWith("well:")&&e is MLeader leader)
            {
                using var text=leader.MText;string[] parts=text.Contents.Split(new[]{"\\P"},2,StringSplitOptions.None);int.TryParse(parts[0].Replace("КК-",""),out int number);
                descriptions[tag.Value.key[5..]]=(parts.Length>1?parts[1]:"",number);
                if(tag.Value.key=="well:REF_EXISTING")
                {
                    var indexes=leader.GetLeaderIndexes();if(indexes.Count==0||indexes[0] is not int li)throw new InvalidDataException("Existing reference leader has no arrow");
                    var lines=leader.GetLeaderLineIndexes(li);if(lines.Count==0||lines[0] is not int line)throw new InvalidDataException("Existing reference leader has no leader line");
                    var arrow=leader.GetFirstVertex(line);
                    if(!wells.Any(w=>JsonSerializer.Serialize(w).Contains("REF_EXISTING")))wells.Add(new{id="REF_EXISTING",xyz=P(arrow),reference=true,description=parts.Length>1?parts[1]:"Существующий колодец связи",previous_number=number});
                }
            }
        }
        foreach(ObjectId id in model)
        {
            if(tr.GetObject(id,OpenMode.ForRead) is not Entity e||Tag(e)!=null)continue;
            string handle=id.Handle.ToString();
            if(RouteLayers.Contains(e.Layer)&&e is Curve curve&&(e is Line||e is Arc||e is Polyline))routes.Add(new{id=handle,points=CurvePoints(curve),building_entry=handle=="260F55"});
            bool reference=e.Layer=="НСС"&&e is BlockReference br&&br.Name.Equals("ккс-2",StringComparison.OrdinalIgnoreCase);
            if((WellLayers.Contains(e.Layer)||reference)&&(e is BlockReference||e is Circle))
            {
                double[]? center=e is Circle circle?P(circle.Center):Center((BlockReference)e,tr);
                if(center==null)throw new InvalidDataException("Cannot locate well center: "+handle+"; use a block containing Circle/Ellipse or a Circle on the well layer");
                descriptions.TryGetValue(handle,out var old);wells.Add(new{id=handle,xyz=center,reference,description=reference?(string.IsNullOrEmpty(old.text)?"Ранее запроектированный ККС-2":old.text):null,previous_number=reference?(old.number==0?int.MaxValue:old.number):0});
            }
        }
        if(wells.Count==0||routes.Count==0)throw new InvalidDataException("No supported wells/routes on NSS layers");
        return new{wells,routes,@protected=pinned};
    }
    static string Fingerprint(object snapshot)=>AnalysisWorker.Hash(snapshot);
    static void Idle(object? sender,EventArgs args)
    {
        if(doc==null||applying||doc!=AcApp.DocumentManager.MdiActiveDocument||!string.IsNullOrEmpty(doc.CommandInProgress)||!doc.Editor.IsQuiescent)return;
        try
        {
            if(worker!=null)
            {
                if(generation!=worker.Generation){CancelWorker();dirty=auto||dirty;WriteStatus(dirty?"QUEUED":"DISCARDED");return;}
                if(readyToApply==null)
                {
                    if(!worker.TryComplete(out var ready))return;readyToApply=ready;
                    string current=Fingerprint(Capture());
                    if(current!=worker.Fingerprint){CancelWorker();dirty=true;generation++;WriteStatus("QUEUED");return;}
                    if(AppliedState.Matches(doc.Database,AppliedState.Plan(readyToApply!.RootElement,pinned)))
                    {
                        lastFingerprint=current;Completed(readyToApply.RootElement,true);CancelWorker();return;
                    }
                }
                // Commit in document command context, without a new Undo marker.
                // An application-context document lock creates an extra Undo step.
                // Retry if AutoCAD discarded the queued command during input or a
                // document switch. Every entry point revalidates the current job.
                if(DateTime.UtcNow-applyQueued>TimeSpan.FromSeconds(2))
                {
                    applyQueued=DateTime.UtcNow;
                    doc.SendStringToExecute("NSS_TKK_APPLY_PENDING\n",false,false,false);
                }
                return;
            }
            if(!dirty||DateTime.UtcNow-changed<TimeSpan.FromSeconds(1))return;
            // Idle runs on AutoCAD's main thread for the active, quiescent document.
            // Capture only opens objects for read; a write lock would clear Redo.
            {
                var snapshot=Capture();string fingerprint=Fingerprint(snapshot);dirty=false;if(fingerprint==lastFingerprint)return;
                worker=new AnalysisWorker(Root,snapshot,generation);WriteStatus("RUNNING");
            }
        }
        catch(System.Exception e){dirty=false;Report(e);}
    }
    [CommandMethod("NSS_TKK_APPLY_PENDING",CommandFlags.Modal|CommandFlags.NoUndoMarker|CommandFlags.NoHistory|CommandFlags.NoActionRecording)]
    public void ApplyPending()
    {
        if(doc==null||doc!=AcApp.DocumentManager.MdiActiveDocument||worker==null||readyToApply==null)return;
        try
        {
            if(generation!=worker.Generation){CancelWorker();dirty=auto||dirty;WriteStatus(dirty?"QUEUED":"DISCARDED");return;}
            using var result=readyToApply;readyToApply=null;string current=Fingerprint(Capture());
            if(current!=worker.Fingerprint){CancelWorker();dirty=true;generation++;WriteStatus("QUEUED");return;}
            Apply(result.RootElement);lastFingerprint=current;
            Completed(result.RootElement,true);CancelWorker();
        }
        catch(System.Exception e){dirty=false;Report(e);}
    }
    static void Mark(Entity entity,string key,string role)
    {
        using var rb=new ResultBuffer(new TypedValue(1001,Owner),new TypedValue(1000,key),new TypedValue(1000,role));entity.XData=rb;
    }
    static void SetAnnotationMasks(IEnumerable<string> leaders,IEnumerable<string> texts)
    {
        try
        {
            dynamic acad=Autodesk.AutoCAD.ApplicationServices.Application.AcadApplication;dynamic active=acad.ActiveDocument;
            foreach(string handle in leaders){dynamic entity=active.HandleToObject(handle);entity.TextBackgroundFill=false;}
            foreach(string handle in texts){dynamic entity=active.HandleToObject(handle);entity.BackgroundFill=false;}
        }
        catch(System.Exception){/* ActiveX mask properties are applied by desktop AutoCAD. */}
    }
    static void Apply(JsonElement result)
    {
        if(doc==null)throw new InvalidOperationException("No drawing");
            var checks=result.GetProperty("layout_checks");foreach(string code in new[]{"text_route_collisions","text_well_collisions","text_caption_collisions","text_text_collisions"})if(checks.GetProperty(code).GetInt32()!=0)throw new InvalidDataException("Text collision: "+code);
        string plan=AppliedState.Plan(result,pinned);
        if(AppliedState.Matches(doc.Database,plan))return;
        applying=true;
        try
        {
            var db=doc.Database;if(!db.UndoRecording)throw new InvalidOperationException("Undo recording required");
            using var tr=db.TransactionManager.StartTransaction();var regs=(RegAppTable)tr.GetObject(db.RegAppTableId,OpenMode.ForRead);
            if(!regs.Has(Owner)){regs.UpgradeOpen();var record=new RegAppTableRecord{Name=Owner};regs.Add(record);tr.AddNewlyCreatedDBObject(record,true);}
            var styles=(TextStyleTable)tr.GetObject(db.TextStyleTableId,OpenMode.ForRead);if(!styles.Has("ФЭС"))throw new InvalidDataException("Missing ФЭС style");ObjectId styleId=styles["ФЭС"];
            var layers=(LayerTable)tr.GetObject(db.LayerTableId,OpenMode.ForRead);
            foreach(string name in new[]{"NSS_TKK_CALLOUTS","NSS_TKK_SPAN_LABELS_PROJECT"})if(!layers.Has(name)){layers.UpgradeOpen();var layer=new LayerTableRecord{Name=name,IsPlottable=true,Color=Autodesk.AutoCAD.Colors.Color.FromColorIndex(Autodesk.AutoCAD.Colors.ColorMethod.ByAci,7)};layers.Add(layer);tr.AddNewlyCreatedDBObject(layer,true);}
            var mlStyles=(DBDictionary)tr.GetObject(db.MLeaderStyleDictionaryId,OpenMode.ForWrite);const string mlStyleName="NSS_TKK_CALLOUTS_PLAIN";MLeaderStyle mlStyle;
            if(mlStyles.Contains(mlStyleName))mlStyle=(MLeaderStyle)tr.GetObject(mlStyles.GetAt(mlStyleName),OpenMode.ForWrite);
            else{var sourceStyle=(MLeaderStyle)tr.GetObject(db.MLeaderstyle,OpenMode.ForRead);mlStyle=new MLeaderStyle();mlStyle.CopyFrom(sourceStyle);mlStyles.SetAt(mlStyleName,mlStyle);tr.AddNewlyCreatedDBObject(mlStyle,true);}
            mlStyle.LeaderLineWeight=LineWeight.LineWeight009;mlStyle.LeaderLineColor=Autodesk.AutoCAD.Colors.Color.FromColorIndex(Autodesk.AutoCAD.Colors.ColorMethod.ByAci,7);mlStyle.TextColor=Autodesk.AutoCAD.Colors.Color.FromColorIndex(Autodesk.AutoCAD.Colors.ColorMethod.ByAci,7);mlStyle.TextStyleId=styleId;mlStyle.TextHeight=1.25;mlStyle.EnableFrameText=false;
            using(var defaultText=mlStyle.DefaultMText){defaultText.BackgroundFill=false;defaultText.UseBackgroundColor=false;defaultText.BackgroundScaleFactor=1.0;defaultText.Color=Autodesk.AutoCAD.Colors.Color.FromColorIndex(Autodesk.AutoCAD.Colors.ColorMethod.ByAci,7);mlStyle.DefaultMText=defaultText;}
            var bt=(BlockTable)tr.GetObject(db.BlockTableId,OpenMode.ForRead);var model=(BlockTableRecord)tr.GetObject(bt[BlockTableRecord.ModelSpace],OpenMode.ForWrite);var current=new Dictionary<string,Entity>();var duplicates=new List<Entity>();
            var legacyCaptions=new List<MText>();
            foreach(ObjectId id in model){var entity=(Entity)tr.GetObject(id,OpenMode.ForRead);var tag=Tag(entity);if(tag!=null&&!current.TryAdd(tag.Value.key,entity))duplicates.Add(entity);else if(tag==null&&entity.Layer=="NSS_TKK_SPAN_LABELS_PROJECT"&&entity is MText oldCaption)legacyCaptions.Add(oldCaption);}
            var kept=new HashSet<string>();var mleaderHandles=new List<string>();var spanTextHandles=new List<string>();
            var calloutLayer=(LayerTableRecord)tr.GetObject(layers["NSS_TKK_CALLOUTS"],OpenMode.ForWrite);calloutLayer.Color=Autodesk.AutoCAD.Colors.Color.FromColorIndex(Autodesk.AutoCAD.Colors.ColorMethod.ByAci,7);
            var spanLayer=(LayerTableRecord)tr.GetObject(layers["NSS_TKK_SPAN_LABELS_PROJECT"],OpenMode.ForWrite);spanLayer.Color=Autodesk.AutoCAD.Colors.Color.FromColorIndex(Autodesk.AutoCAD.Colors.ColorMethod.ByAci,7);
            foreach(ObjectId id in model){if(tr.GetObject(id,OpenMode.ForRead) is Entity route&&RouteLayers.Contains(route.Layer)&&route.LineWeight!=LineWeight.LineWeight090){route.UpgradeOpen();route.LineWeight=LineWeight.LineWeight090;}}
            MText Text(string content,Point3d location,bool centered,double rotation)=>new(){Contents=content,TextStyleId=styleId,TextHeight=1.25,Width=0,Location=location,Rotation=rotation,Attachment=centered?AttachmentPoint.MiddleCenter:AttachmentPoint.TopLeft,BackgroundFill=false,UseBackgroundColor=false,BackgroundScaleFactor=1.0,Color=Autodesk.AutoCAD.Colors.Color.FromColorIndex(Autodesk.AutoCAD.Colors.ColorMethod.ByAci,7)};
            foreach(var item in result.GetProperty("leaders").EnumerateArray())
            {
                string key=item.GetProperty("key").GetString()!;kept.Add(key);MLeader leader;
                if(current.TryGetValue(key,out var old)&&old is MLeader existing){leader=existing;leader.UpgradeOpen();foreach(int index in leader.GetLeaderIndexes().Cast<int>().ToArray())leader.RemoveLeader(index);}
                else{leader=new MLeader();leader.SetDatabaseDefaults(db);leader.LayerId=layers["NSS_TKK_CALLOUTS"];model.AppendEntity(leader);tr.AddNewlyCreatedDBObject(leader,true);}
                leader.MLeaderStyle=mlStyle.ObjectId;leader.ContentType=ContentType.MTextContent;leader.TextStyleId=styleId;leader.TextHeight=1.25;leader.ArrowSize=.35;leader.EnableDogleg=true;leader.DoglegLength=1.2;leader.LandingGap=.35;leader.Color=Autodesk.AutoCAD.Colors.Color.FromColorIndex(Autodesk.AutoCAD.Colors.ColorMethod.ByAci,7);leader.LineWeight=LineWeight.LineWeight009;
                using var text=Text(item.GetProperty("text").GetString()!,P(item.GetProperty("insert")),false,0);leader.MText=text;
                int group=leader.AddLeader(),line=leader.AddLeaderLine(group);leader.AddFirstVertex(line,P(item.GetProperty("target")));
                var insert=P(item.GetProperty("insert"));bool left=item.GetProperty("side").GetString()=="left";
                leader.AddLastVertex(line,insert+new Vector3d(left?-1.55:text.ActualWidth+1.55,-text.ActualHeight/2,0));leader.TextLocation=insert;
                leader.MLeaderStyle=mlStyle.ObjectId;
                using(var content=leader.MText){content.BackgroundFill=false;content.UseBackgroundColor=false;content.BackgroundScaleFactor=1.0;content.Color=Autodesk.AutoCAD.Colors.Color.FromColorIndex(Autodesk.AutoCAD.Colors.ColorMethod.ByAci,7);leader.MText=content;}
                mleaderHandles.Add(leader.Handle.ToString());
                Mark(leader,key,item.GetProperty("reference").GetBoolean()?"reference":"well");
                using var actual=leader.MText;var bounds=item.GetProperty("box");
                double actualLeft=left?actual.Location.X:actual.Location.X-actual.ActualWidth,actualRight=left?actual.Location.X+actual.ActualWidth:actual.Location.X;
                if(actualLeft-.2<bounds[0].GetDouble()||actual.Location.Y-actual.ActualHeight-.2<bounds[1].GetDouble()||actualRight+.2>bounds[2].GetDouble()||actual.Location.Y+.2>bounds[3].GetDouble())throw new InvalidDataException($"Native text metrics exceed collision-free box {key}: actual=({actual.Location.X:F3},{actual.Location.Y:F3},{actual.ActualWidth:F3},{actual.ActualHeight:F3}), side={item.GetProperty("side").GetString()}, box=({bounds[0].GetDouble():F3},{bounds[1].GetDouble():F3},{bounds[2].GetDouble():F3},{bounds[3].GetDouble():F3})");
            }
            foreach(var item in result.GetProperty("captions").EnumerateArray())
            {
                string key=item.GetProperty("key").GetString()!;kept.Add(key);
                if(current.TryGetValue(key,out var old)){old.UpgradeOpen();old.Erase();}
                var text=Text(item.GetProperty("text").GetString()!,P(item.GetProperty("xyz")),true,item.GetProperty("rotation").GetDouble());text.LayerId=layers["NSS_TKK_SPAN_LABELS_PROJECT"];model.AppendEntity(text);tr.AddNewlyCreatedDBObject(text,true);Mark(text,key,"caption");spanTextHandles.Add(text.Handle.ToString());
            }
            foreach(var legacyCaption in legacyCaptions){legacyCaption.UpgradeOpen();legacyCaption.Erase();}
            foreach(var pair in current)if(!kept.Contains(pair.Key)){pair.Value.UpgradeOpen();pair.Value.Erase();}
            foreach(var duplicate in duplicates){duplicate.UpgradeOpen();duplicate.Erase();}
            var nod=(DBDictionary)tr.GetObject(db.NamedObjectsDictionaryId,OpenMode.ForWrite);Xrecord settings;
            if(nod.Contains(Settings))settings=(Xrecord)tr.GetObject(nod.GetAt(Settings),OpenMode.ForWrite);else{settings=new Xrecord();nod.SetAt(Settings,settings);tr.AddNewlyCreatedDBObject(settings,true);}
            string json=JsonSerializer.Serialize(pinned);using var data=new ResultBuffer(Enumerable.Range(0,(json.Length+199)/200).Select(i=>new TypedValue((int)DxfCode.Text,json.Substring(i*200,Math.Min(200,json.Length-i*200)))).ToArray());settings.Data=data;
            AppliedState.Store(db,tr,plan);tr.Commit();
            if(!System.Diagnostics.Process.GetCurrentProcess().ProcessName.Contains("accoreconsole",StringComparison.OrdinalIgnoreCase))SetAnnotationMasks(mleaderHandles,spanTextHandles);
        }
        finally{applying=false;}
    }
}
