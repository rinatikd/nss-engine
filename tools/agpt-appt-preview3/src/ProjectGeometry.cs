using System;
using System.Collections.Generic;
using System.Linq;

namespace AGPT.Shared
{
    public readonly record struct PlanVertex(double X, double Y, double Z = 0, double Bulge = 0)
    {
        public bool IsFinite => double.IsFinite(X) && double.IsFinite(Y) && double.IsFinite(Z) && double.IsFinite(Bulge);
    }
    public readonly record struct Bounds2D(double MinX, double MinY, double MaxX, double MaxY)
    {
        public double Width => MaxX - MinX;
        public double Height => MaxY - MinY;
        public bool IsValid => double.IsFinite(MinX) && double.IsFinite(MinY) && double.IsFinite(MaxX)
            && double.IsFinite(MaxY) && double.IsFinite(Width) && double.IsFinite(Height) && Width >= 0 && Height >= 0;
        public Bounds2D Union(Bounds2D b) => new(Math.Min(MinX, b.MinX), Math.Min(MinY, b.MinY), Math.Max(MaxX, b.MaxX), Math.Max(MaxY, b.MaxY));
        public static Bounds2D FromVertices(IEnumerable<PlanVertex> vertices)
        {
            var v = vertices.ToArray();
            if (v.Length == 0 || v.Any(p => !p.IsFinite)) throw new ArgumentException("Finite geometry is required.");
            // Curved segments need native extents; endpoints alone are not an arc bounding box.
            if (v.Any(p => p.Bulge != 0)) throw new ArgumentException("Arc geometry requires native extents.");
            return new(v.Min(p => p.X), v.Min(p => p.Y), v.Max(p => p.X), v.Max(p => p.Y));
        }
    }
    public sealed class PlanZone
    {
        public string Id { get; set; } = "";
        public string Name { get; set; } = "";
        public string Floor { get; set; } = "";
        public double? Elevation { get; set; }
        public List<PlanVertex> Boundary { get; set; } = new();
        public Bounds2D? Bounds { get; set; }
    }
    public sealed class PlanDevice
    {
        public string Id { get; set; } = "";
        public string Kind { get; set; } = "";
        public string Mark { get; set; } = "";
        public string ZoneId { get; set; } = "";
        public PlanVertex Position { get; set; }
    }
    public sealed class PlanRoute
    {
        public string Id { get; set; } = "";
        public string Kind { get; set; } = "";
        public string Mark { get; set; } = "";
        public string From { get; set; } = "";
        public string To { get; set; } = "";
        public double? Dy { get; set; }
        public double? LengthMetres { get; set; }
        public List<PlanVertex> Vertices { get; set; } = new();
        public Bounds2D? Bounds { get; set; }
        public bool Closed { get; set; }
    }
    public sealed class PlanModel
    {
        public double MetresPerUnit { get; set; }
        public List<PlanZone> Zones { get; set; } = new();
        public List<PlanDevice> Devices { get; set; } = new();
        public List<PlanRoute> Routes { get; set; } = new();
        public List<string> Issues { get; set; } = new();
        public Bounds2D? GetBounds(bool showPipes = true, bool showCables = true)
        {
            Bounds2D? result = null;
            void Add(Bounds2D b) { if (!b.IsValid) throw new ArgumentException("Invalid geometry extents."); result = result.HasValue ? result.Value.Union(b) : b; }
            foreach (var z in Zones.Where(z => z.Boundary.Count >= 3))
            {
                if (z.Boundary.Any(v => !v.IsFinite)) throw new ArgumentException("Invalid zone boundary.");
                Add(z.Bounds ?? Bounds2D.FromVertices(z.Boundary));
            }
            foreach (var d in Devices) { if (!d.Position.IsFinite) throw new ArgumentException("Invalid device position."); Add(new(d.Position.X, d.Position.Y, d.Position.X, d.Position.Y)); }
            foreach (var r in Routes.Where(r => r.Vertices.Count >= 2 && (r.Kind == "PIPE" ? showPipes : r.Kind == "CABLE" && showCables)))
                {
                if (r.Vertices.Any(v => !v.IsFinite)) throw new ArgumentException("Invalid route geometry.");
                Add(r.Bounds ?? Bounds2D.FromVertices(r.Vertices));
            }
            return result;
        }
    }
    public sealed class PlanViewport
    {
        public double ScaleDenominator { get; private set; }
        public double Factor { get; private set; }
        public double OffsetX { get; private set; }
        public double OffsetY { get; private set; }
        public PlanVertex Project(PlanVertex p)
        {
            if (!p.IsFinite) throw new ArgumentException("Invalid coordinate.");
            var result = new PlanVertex(p.X * Factor + OffsetX, p.Y * Factor + OffsetY, 0, p.Bulge);
            if (!result.IsFinite) throw new ArgumentException("Projection overflow.");
            return result;
        }
        public static PlanViewport FitAtScale(Bounds2D bounds, double metresPerUnit, double denominator,
            double originX, double originY, double paperWidth, double paperHeight)
        {
            if (!bounds.IsValid || !double.IsFinite(metresPerUnit) || metresPerUnit <= 0 || !double.IsFinite(denominator) || denominator <= 0
                || !double.IsFinite(originX) || !double.IsFinite(originY) || !double.IsFinite(paperWidth) || paperWidth <= 0
                || !double.IsFinite(paperHeight) || paperHeight <= 0) throw new ArgumentException("Valid units, scale and paper rectangle are required.");
            if (!double.IsFinite(originX + paperWidth) || !double.IsFinite(originY + paperHeight))
                throw new ArgumentException("Paper rectangle overflow.");
            double factor = 1000 * metresPerUnit / denominator;
            double width = bounds.Width * factor, height = bounds.Height * factor;
            if (!double.IsFinite(factor) || factor <= 0 || !double.IsFinite(width) || !double.IsFinite(height)
                || width > paperWidth + 1e-9 || height > paperHeight + 1e-9)
                throw new ArgumentException("Geometry does not fit at the requested scale.");
            var view = new PlanViewport { Factor = factor, ScaleDenominator = denominator,
                OffsetX = originX + (paperWidth - width) / 2 - bounds.MinX * factor,
                OffsetY = originY + (paperHeight - height) / 2 - bounds.MinY * factor };
            if (!double.IsFinite(view.OffsetX) || !double.IsFinite(view.OffsetY))
                throw new ArgumentException("Projection offset overflow.");
            // A finite offset alone does not prove that multiplication and addition at the source extents remain finite.
            view.Project(new PlanVertex(bounds.MinX, bounds.MinY));
            view.Project(new PlanVertex(bounds.MaxX, bounds.MaxY));
            return view;
        }
        public static PlanViewport ChooseScaleA3(Bounds2D bounds, double metresPerUnit, double originX, double originY, double paperWidth, double paperHeight)
        {
            foreach (double scale in new double[] { 25, 50, 100, 200, 500 })
            {
                try { return FitAtScale(bounds, metresPerUnit, scale, originX, originY, paperWidth, paperHeight); }
                catch (ArgumentException) { }
            }
            throw new ArgumentException("Geometry cannot fit the content rectangle at scales 1:25 through 1:500. Split the plan or use a larger sheet.");
        }
    }
    public sealed class PlanRenderSummary
    {
        public double ScaleDenominator { get; set; }
        public int ZoneCount { get; set; }
        public int DeviceCount { get; set; }
        public int RouteCount { get; set; }
        public List<string> Issues { get; set; } = new();
    }
}
