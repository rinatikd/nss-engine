// Compile-only API substitutes. Not a test of AutoCAD runtime behavior.
// Test harness: responses are programmed via FakeAutoCad.Queue* / FakeAutoCad.Reset().
using System.Collections.Generic;

namespace Autodesk.AutoCAD.Runtime
{
    [System.Flags]
    public enum CommandFlags { Modal=1, NoUndoMarker=2 }
    [System.AttributeUsage(System.AttributeTargets.Method)]
    public sealed class CommandMethodAttribute : System.Attribute
    {
        public CommandMethodAttribute(string name, CommandFlags flags) {}
    }
}
namespace Autodesk.AutoCAD.EditorInput
{
    public enum PromptStatus { OK, Cancel, None }
    public sealed class PromptKeywordOptions
    {
        public PromptKeywordOptions(string message) {}
        public bool AllowNone { get; set; }
        public KeywordCollection Keywords { get; } = new();
    }
    public sealed class KeywordCollection
    {
        public string Default { get; set; } = "";
        public void Add(string value) {}
    }
    public sealed class PromptIntegerOptions
    {
        public PromptIntegerOptions(string message) {}
        public bool AllowNone { get; set; }
        public int DefaultValue { get; set; }
        public int LowerLimit { get; set; }
        public int UpperLimit { get; set; }
    }
    public sealed class PromptStringOptions
    {
        public PromptStringOptions(string message) {}
        public bool AllowSpaces { get; set; }
    }
    public sealed class PromptOpenFileOptions
    {
        public PromptOpenFileOptions(string message) {}
        public string Filter { get; set; } = "";
    }
    public sealed class PromptResult
    {
        public PromptStatus Status { get; set; }
        public string StringResult { get; set; } = "";
        public int Value { get; set; }
    }
    public sealed class Editor
    {
        public void WriteMessage(string format, params object[] args)
            => FakeAutoCad.Messages.Add(args.Length == 0 ? format : string.Format(format, args));
        public PromptResult GetKeywords(PromptKeywordOptions p) => FakeAutoCad.NextKeyword();
        public PromptResult GetInteger(PromptIntegerOptions p) => FakeAutoCad.NextInteger();
        public PromptResult GetString(PromptStringOptions p) => FakeAutoCad.NextString();
        public PromptResult GetFileNameForOpen(PromptOpenFileOptions p) => FakeAutoCad.NextFile();
    }
}
namespace Autodesk.AutoCAD.ApplicationServices.Core
{
    public static class Application
    {
        public static DocumentManager DocumentManager { get; } = new();
    }
    public sealed class DocumentManager
    {
        public Document? MdiActiveDocument { get; set; } = new Document();
    }
    public sealed class Document
    {
        public Autodesk.AutoCAD.EditorInput.Editor Editor { get; } = new();
    }
}

public static class FakeAutoCad
{
    public static readonly List<string> Messages = new();
    static readonly Queue<Autodesk.AutoCAD.EditorInput.PromptResult> _keywords = new();
    static readonly Queue<Autodesk.AutoCAD.EditorInput.PromptResult> _integers = new();
    static readonly Queue<Autodesk.AutoCAD.EditorInput.PromptResult> _strings = new();
    static readonly Queue<Autodesk.AutoCAD.EditorInput.PromptResult> _files = new();

    public static void Reset()
    {
        Messages.Clear();
        _keywords.Clear(); _integers.Clear(); _strings.Clear(); _files.Clear();
        Autodesk.AutoCAD.ApplicationServices.Core.Application.DocumentManager.MdiActiveDocument
            = new Autodesk.AutoCAD.ApplicationServices.Core.Document();
    }

    public static void QueueKeyword(string result) =>
        _keywords.Enqueue(new Autodesk.AutoCAD.EditorInput.PromptResult
            { Status = Autodesk.AutoCAD.EditorInput.PromptStatus.OK, StringResult = result });
    public static void QueueInteger(int value) =>
        _integers.Enqueue(new Autodesk.AutoCAD.EditorInput.PromptResult
            { Status = Autodesk.AutoCAD.EditorInput.PromptStatus.OK, Value = value });
    public static void QueueString(string value) =>
        _strings.Enqueue(new Autodesk.AutoCAD.EditorInput.PromptResult
            { Status = Autodesk.AutoCAD.EditorInput.PromptStatus.OK, StringResult = value });
    public static void QueueFile(string path) =>
        _files.Enqueue(new Autodesk.AutoCAD.EditorInput.PromptResult
            { Status = Autodesk.AutoCAD.EditorInput.PromptStatus.OK, StringResult = path });

    internal static Autodesk.AutoCAD.EditorInput.PromptResult NextKeyword()
        => _keywords.Count > 0 ? _keywords.Dequeue() : new Autodesk.AutoCAD.EditorInput.PromptResult();
    internal static Autodesk.AutoCAD.EditorInput.PromptResult NextInteger()
        => _integers.Count > 0 ? _integers.Dequeue() : new Autodesk.AutoCAD.EditorInput.PromptResult();
    internal static Autodesk.AutoCAD.EditorInput.PromptResult NextString()
        => _strings.Count > 0 ? _strings.Dequeue() : new Autodesk.AutoCAD.EditorInput.PromptResult();
    internal static Autodesk.AutoCAD.EditorInput.PromptResult NextFile()
        => _files.Count > 0 ? _files.Dequeue() : new Autodesk.AutoCAD.EditorInput.PromptResult();
}