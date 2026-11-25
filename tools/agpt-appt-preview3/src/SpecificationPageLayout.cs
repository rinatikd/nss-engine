using System;
using System.Collections.Generic;
using System.Linq;

namespace AGPT.Shared
{
    public sealed class SpecificationFragment
    {
        public int SourceIndex { get; internal set; }
        public bool IsContinuation { get; internal set; }
        public string[][] Cells { get; internal set; }
        public double Height { get; internal set; }
    }

    /// <summary>Pure layout plan consumed by the CAD renderer; source text is never elided.</summary>
    public static class SpecificationPageLayout
    {
        public static List<List<SpecificationFragment>> Plan(IEnumerable<string[]> rows, double[] widths,
            double bodyHeight = 170, int rowsPerPage = 20, double fontSize = 2.2, double linePitch = 3.1)
        {
            if (rows == null || widths == null) throw new ArgumentNullException();
            if (widths.Length == 0 || widths.Any(w => !double.IsFinite(w) || w <= 3)
                || !double.IsFinite(bodyHeight) || bodyHeight < 8
                || !double.IsFinite(fontSize) || fontSize <= 0
                || !double.IsFinite(linePitch) || linePitch < fontSize
                || rowsPerPage <= 0 || 2 + linePitch > bodyHeight)
                throw new ArgumentOutOfRangeException("Invalid specification layout geometry.");
            int linesPerFragment = Math.Min(3, (int)Math.Min(3, Math.Floor((bodyHeight - 2) / linePitch)));
            var pages = new List<List<SpecificationFragment>> { new List<SpecificationFragment>() };
            double used = 0;
            int sourceIndex = 0;
            foreach (var row in rows)
            {
                if (row == null || row.Length != widths.Length)
                    throw new ArgumentException("Every specification row must match the column count.");
                var lines = row.Select((v, i) => Wrap(v, widths[i] - 3, fontSize)).ToArray();
                int lineCount = lines.Max(l => l.Length);
                for (int start = 0; start < lineCount; start += linesPerFragment)
                {
                    int count = Math.Min(linesPerFragment, lineCount - start);
                    var fragment = new SpecificationFragment { SourceIndex = sourceIndex,
                        IsContinuation = start > 0, Height = Math.Max(8, 2 + count * linePitch),
                        Cells = lines.Select(l => l.Skip(start).Take(count).ToArray()).ToArray() };
                    var current = pages[pages.Count - 1];
                    if (current.Count >= rowsPerPage || used + fragment.Height > bodyHeight)
                    {
                        current = new List<SpecificationFragment>();
                        pages.Add(current);
                        used = 0;
                    }
                    current.Add(fragment);
                    used += fragment.Height;
                }
                sourceIndex++;
            }
            return pages;
        }

        public static string[] Wrap(string text, double width, double fontSize)
        {
            if (!double.IsFinite(width) || width <= 0 || !double.IsFinite(fontSize) || fontSize <= 0)
                throw new ArgumentOutOfRangeException("Invalid text geometry.");
            int capacity = (int)Math.Min(int.MaxValue, Math.Max(1, Math.Floor(width / fontSize)));
            text = text ?? "";
            var result = new List<string>();
            int start = 0;
            while (start < text.Length)
            {
                int count = Math.Min(capacity, text.Length - start);
                int newline = text.IndexOf('\n', start, count);
                if (newline >= 0) count = newline - start + 1;
                else if (start + count < text.Length)
                {
                    int space = text.LastIndexOf(' ', start + count - 1, count);
                    if (space > start) count = space - start + 1;
                }
                result.Add(text.Substring(start, count));
                start += count;
            }
            if (result.Count == 0) result.Add("");
            return result.ToArray();
        }
    }
}
