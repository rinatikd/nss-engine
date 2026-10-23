using System;
using System.IO;
using System.Linq;
using System.Collections.Generic;
using System.Globalization;
using System.Text.Json;
using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.Geometry;

// Review changes the view/selection only. Analysis owns no geometry edits here.
internal static class IssueReview
{
    static Document? drawing;
    static string? fingerprint,folder;
    static JsonElement[] issues=Array.Empty<JsonElement>();
    static int position=-1;
    internal static void Clear(){drawing=null;fingerprint=null;folder=null;issues=Array.Empty<JsonElement>();position=-1;}
    internal static void Set(Document document,JsonElement result,string hash,string reportFolder)
    {
        string? previous=drawing==document&&position>=0&&position<issues.Length?issues[position].GetProperty("issue_id").GetString():null;
        drawing=document;fingerprint=hash;folder=reportFolder;
        issues=result.GetProperty("warnings").EnumerateArray().Select(i=>i.Clone()).ToArray();
        position=Array.FindIndex(issues,i=>i.GetProperty("issue_id").GetString()==previous);
    }
    internal static bool Matches(Document document,string hash)=>drawing==document&&fingerprint==hash;
    internal static int Count=>issues.Length;
    internal static void List(Document document)
    {
        if(drawing!=document)throw new InvalidOperationException("No current issue analysis for this drawing");
        document.Editor.WriteMessage($"\nNSS: {issues.Length} review issues. XY proximity alone does not confirm connectivity.");
        for(int i=0;i<issues.Length;i++)
        {
            var issue=issues[i];
            document.Editor.WriteMessage($"\n{i+1}. {issue.GetProperty("issue_id").GetString()} {issue.GetProperty("title").GetString()} [{string.Join(",",issue.GetProperty("source_ids").EnumerateArray().Select(v=>v.GetString()))}]");
        }
        document.Editor.WriteMessage($"\nReport: {Path.Combine(folder!,"ISSUES_RU.md")}\nNSS_TKK_ISSUE: choose a number; NSS_TKK_NEXT_ISSUE: next issue.");
    }
    internal static void Next(Document document)=>Show(document,(position+1)%Math.Max(1,issues.Length));
    internal static void Show(Document document,int index)
    {
        if(drawing!=document)throw new InvalidOperationException("Issue analysis belongs to another drawing");
        if(issues.Length==0){document.Editor.WriteMessage("\nNSS: no review issues.");return;}
        if(index<0||index>=issues.Length)throw new ArgumentOutOfRangeException(nameof(index));
        var issue=issues[index];var editor=document.Editor;
        var ids=new List<ObjectId>();
        foreach(var value in issue.GetProperty("source_ids").EnumerateArray())
        {
            if(value.GetString()=="REF_EXISTING")
            {
                using var tr=document.Database.TransactionManager.StartOpenCloseTransaction();
                var bt=(BlockTable)tr.GetObject(document.Database.BlockTableId,OpenMode.ForRead);
                var model=(BlockTableRecord)tr.GetObject(bt[BlockTableRecord.ModelSpace],OpenMode.ForRead);
                foreach(ObjectId id in model)
                {
                    if(tr.GetObject(id,OpenMode.ForRead) is not MLeader leader)continue;
                    using var tag=leader.GetXDataForApplication("NSS_TKK_EDITOR_NOTE");var data=tag?.AsArray();
                    if(data?.Length>=3&&data[1].Value as string=="well:REF_EXISTING")ids.Add(id);
                }
                continue;
            }
            if(!long.TryParse(value.GetString(),NumberStyles.HexNumber,CultureInfo.InvariantCulture,out long handle)||handle<=0)continue;
            try{ObjectId id=document.Database.GetObjectId(false,new Handle(handle),0);if(!id.IsNull&&!id.IsErased)ids.Add(id);}
            catch(Autodesk.AutoCAD.Runtime.Exception){}
        }
        var box=issue.GetProperty("bounds");
        if(box.ValueKind!=JsonValueKind.Null)
        {
            using var view=editor.GetCurrentView();
            Matrix3d worldToEye=(Matrix3d.Displacement(view.Target-Point3d.Origin)*Matrix3d.PlaneToWorld(view.ViewDirection)).Inverse();
            worldToEye=Matrix3d.Rotation(view.ViewTwist,Vector3d.ZAxis,Point3d.Origin)*worldToEye;
            double x0=box[0].GetDouble(),y0=box[1].GetDouble(),x1=box[2].GetDouble(),y1=box[3].GetDouble();
            var points=new[]{new Point3d(x0,y0,0),new Point3d(x0,y1,0),new Point3d(x1,y0,0),new Point3d(x1,y1,0)}.Select(p=>p.TransformBy(worldToEye)).ToArray();
            double left=points.Min(p=>p.X),right=points.Max(p=>p.X),bottom=points.Min(p=>p.Y),top=points.Max(p=>p.Y);
            double aspect=view.Width>0&&view.Height>0?view.Width/view.Height:1.5;
            double width=Math.Max(12,(right-left)*1.25),height=Math.Max(12,(top-bottom)*1.25);
            if(width/height<aspect)width=height*aspect;else height=width/aspect;
            view.CenterPoint=new Point2d((left+right)/2,(bottom+top)/2);view.Width=width;view.Height=height;editor.SetCurrentView(view);
        }
        editor.SetImpliedSelection(ids.ToArray());position=index;
        editor.WriteMessage($"\nNSS issue {index+1}/{issues.Length}: {issue.GetProperty("issue_id").GetString()} — {issue.GetProperty("title").GetString()}. Selected source objects: {ids.Count}.");
        if(box.ValueKind==JsonValueKind.Null)editor.WriteMessage("\nThe source object is absent; no review location is available.");
    }
}
