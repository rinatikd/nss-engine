// Compile-only API substitutes. Not a test of AutoCAD runtime behavior.
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
        public void WriteMessage(string format, params object[] args) {}
        public PromptResult GetKeywords(PromptKeywordOptions p) => new();
        public PromptResult GetInteger(PromptIntegerOptions p) => new();
        public PromptResult GetFileNameForOpen(PromptOpenFileOptions p) => new();
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
        public Document? MdiActiveDocument { get; set; }
    }
    public sealed class Document
    {
        public Autodesk.AutoCAD.EditorInput.Editor Editor { get; } = new();
    }
}
