using System;
using System.Linq;
using AGPT.Shared;
using Xunit;

public class AxonometricProjectionTests
{
    [Fact]
    public void VerticalPipePreservesItsTrueHeightInsteadOfCollapsingToPlan()
    {
        var a = new PlanVertex(12, 34, 5);
        var b = new PlanVertex(12, 34, 15);
        var projection = AxonometricProjection.Fit(new[] { a, b }, 20, 30, 100, 80);
        var first = projection.Project(a);
        var last = projection.Project(b);
        Assert.Equal(first.X, last.X, 10);
        Assert.Equal(80, last.Y - first.Y, 10);
        Assert.False(AxonometricProjection.IsPlanar(new[] { a, b }));
    }

    [Fact]
    public void ActualXyzAxesHaveDistinctDirectionsAndOneCommonScale()
    {
        var points = new[] { new PlanVertex(0, 0, 0), new PlanVertex(10, 0, 0),
            new PlanVertex(0, 10, 0), new PlanVertex(0, 0, 10) };
        var view = AxonometricProjection.Fit(points, 0, 0, 200, 100);
        var o = view.Project(points[0]);
        var x = view.Project(points[1]);
        var y = view.Project(points[2]);
        var z = view.Project(points[3]);
        Assert.Equal(10 * Math.Sqrt(3) / 2 * view.Factor, x.X - o.X, 9);
        Assert.Equal(-(x.X - o.X), y.X - o.X, 9);
        Assert.Equal(5 * view.Factor, x.Y - o.Y, 9);
        Assert.Equal(x.Y - o.Y, y.Y - o.Y, 9);
        Assert.Equal(10 * view.Factor, z.Y - o.Y, 9);
        Assert.Equal(o.X, z.X, 9);
    }

    [Fact]
    public void SourceTranslationAndUniformUnitsDoNotChangeFittedGeometry()
    {
        var source = new[] { new PlanVertex(-20, 15, 2), new PlanVertex(80, 15, 2), new PlanVertex(80, 30, 12) };
        var translated = source.Select(p => new PlanVertex(p.X * 1000 + 1e9,
            p.Y * 1000 - 2e9, p.Z * 1000 + 3e9)).ToArray();
        var first = AxonometricProjection.Fit(source, 12, 24, 170, 90);
        var second = AxonometricProjection.Fit(translated, 12, 24, 170, 90);
        for (int i = 0; i < source.Length; i++)
        {
            Assert.Equal(first.Project(source[i]).X, second.Project(translated[i]).X, 8);
            Assert.Equal(first.Project(source[i]).Y, second.Project(translated[i]).Y, 8);
        }
    }

    [Fact]
    public void SemicircularBulgeKeepsItsElevationAndContributesItsActualExtent()
    {
        var route = new PlanRoute { Vertices = new() { new(0, 0, 7, 1), new(10, 0, 7) } };
        var samples = AxonometricProjection.Sample(route);
        Assert.True(samples.Count > 100);
        Assert.Equal(route.Vertices[0], samples[0]);
        Assert.Equal(route.Vertices[1], samples[^1]);
        Assert.All(samples, p => Assert.Equal(7, p.Z));
        Assert.Equal(-5, samples.Min(p => p.Y), 9);
        Assert.True(AxonometricProjection.IsPlanar(samples));
        var view = AxonometricProjection.Fit(samples, 10, 20, 100, 80);
        Assert.All(samples.Select(view.Project), p =>
        {
            Assert.InRange(p.X, 10 - 1e-9, 110 + 1e-9);
            Assert.InRange(p.Y, 20 - 1e-9, 100 + 1e-9);
        });
    }

    [Fact]
    public void ClosedSourceIncludesItsClosingSegmentAndDoesNotInventARiser()
    {
        var route = new PlanRoute { Closed = true, Vertices = new() { new(0, 0, 8), new(10, 0, 8), new(10, 10, 8) } };
        var samples = AxonometricProjection.Sample(route);
        Assert.Equal(4, samples.Count);
        Assert.Equal(samples[0], samples[^1]);
        Assert.True(AxonometricProjection.IsPlanar(samples));
        Assert.True(AxonometricProjection.IsPlanar(samples.Select(p => p with { Z = 1e9 })));
        Assert.False(AxonometricProjection.IsPlanar(new[] { new PlanVertex(0, 0, 1e9), new PlanVertex(0, 0, 1e9 + .01) }));
    }

    [Fact]
    public void MidpointUsesActualThreeDimensionalSegmentLengths()
    {
        var points = new System.Collections.Generic.List<PlanVertex> { new(0, 0, 0), new(0, 0, 6), new(8, 0, 6) };
        Assert.Equal(new PlanVertex(1, 0, 6), AxonometricProjection.Midpoint(points));
    }

    [Fact]
    public void NonfiniteOrOverflowingGeometryCannotProduceCadCoordinates()
    {
        Assert.Throws<ArgumentException>(() => AxonometricProjection.Fit(new[] { new PlanVertex(double.NaN, 0) }, 0, 0, 100, 80));
        Assert.Throws<ArgumentException>(() => AxonometricProjection.Fit(new[] { new PlanVertex(-1e308, 0), new PlanVertex(1e308, 0) }, 0, 0, 100, 80));
        Assert.Throws<ArgumentException>(() => AxonometricProjection.Fit(new[] { new PlanVertex(0, 0) }, 1e308, 0, 1e308, 80));
        Assert.Throws<ArgumentException>(() => AxonometricProjection.Fit(Array.Empty<PlanVertex>(), 0, 0, 100, 80));
        Assert.Throws<ArgumentException>(() => AxonometricProjection.Sample(new PlanRoute { Vertices = new() { new(0, 0, 0, 1), new(10, 0, 5) } }));
    }
}
