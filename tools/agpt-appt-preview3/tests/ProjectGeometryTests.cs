using System;
using AGPT.Shared;
using Xunit;

public class ProjectGeometryTests
{
    [Theory]
    [InlineData(.001, 10000)]
    [InlineData(.01, 1000)]
    [InlineData(1, 10)]
    public void SamePhysicalGeometryUsesOneScaleInEverySupportedUnit(double metresPerUnit, double nativeLength)
    {
        var view = PlanViewport.FitAtScale(new Bounds2D(0, 0, nativeLength, nativeLength / 2), metresPerUnit, 100, 0, 0, 200, 100);
        var a = view.Project(new PlanVertex(0, 0));
        var b = view.Project(new PlanVertex(nativeLength, nativeLength / 2));
        Assert.Equal(100, b.X - a.X, 9);
        Assert.Equal(50, b.Y - a.Y, 9);
        Assert.Equal(100, view.ScaleDenominator);
    }

    [Fact]
    public void OversizedGeometryIsRejectedInsteadOfClampedOrDistorted()
    {
        Assert.Throws<ArgumentException>(() => PlanViewport.FitAtScale(new Bounds2D(0, 0, 30000, 10000), .001, 100, 0, 0, 200, 200));
        var view = PlanViewport.ChooseScaleA3(new Bounds2D(0, 0, 30000, 10000), .001, 0, 0, 200, 200);
        Assert.Equal(200, view.ScaleDenominator);
        Assert.Equal(150, view.Project(new(30000, 10000)).X - view.Project(new(0, 0)).X, 9);
        Assert.Throws<ArgumentException>(() => PlanViewport.ChooseScaleA3(new Bounds2D(0, 0, 1000000, 1000000), .001, 0, 0, 200, 200));
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-1)]
    [InlineData(double.NaN)]
    [InlineData(double.PositiveInfinity)]
    public void UnknownOrNonfiniteUnitsCannotBecomeAnAssumedScale(double units)
    {
        Assert.Throws<ArgumentException>(() => PlanViewport.FitAtScale(new Bounds2D(0, 0, 1, 1), units, 100, 0, 0, 200, 200));
    }

    [Fact]
    public void CoordinatesAndBulgesSurviveProjectionWithTheirTrueProportions()
    {
        var view = PlanViewport.FitAtScale(new Bounds2D(-1000, -2000, 9000, 3000), .001, 50, 15, 20, 300, 200);
        var p = view.Project(new(-1000, -2000, 7, .414213562373095));
        var q = view.Project(new(9000, 3000));
        Assert.Equal(200, q.X - p.X, 9);
        Assert.Equal(100, q.Y - p.Y, 9);
        Assert.Equal(.414213562373095, p.Bulge);
        Assert.Equal(0, p.Z);
        Assert.Equal(65, p.X, 9);
        Assert.Equal(70, p.Y, 9);
    }

    [Fact]
    public void ManualZoneAndIssuesDoNotGenerateAFictitiousRoom()
    {
        var model = new PlanModel { MetresPerUnit = .001 };
        model.Zones.Add(new PlanZone { Id = "manual", Name = "Расчётная зона" });
        model.Issues.Add("No physical boundary");
        Assert.Null(model.GetBounds());
        Assert.Empty(model.Zones[0].Boundary);
        Assert.Single(model.Issues);
    }

    [Fact]
    public void ActualSourceCoordinatesAndNativeArcExtentsDeterminePlanBounds()
    {
        var model = new PlanModel { MetresPerUnit = .001 };
        model.Zones.Add(new PlanZone { Boundary = new() { new(10, 20, 0, 1), new(110, 20), new(110, 70) }, Bounds = new Bounds2D(10, -30, 110, 70) });
        model.Devices.Add(new PlanDevice { Position = new(-100, 40) });
        model.Routes.Add(new PlanRoute { Kind = "CABLE", Vertices = new() { new(0, 0), new(200, 10) } });
        Assert.Equal(new Bounds2D(-100, -30, 200, 70), model.GetBounds());
        Assert.Equal(new Bounds2D(-100, -30, 110, 70), model.GetBounds(showCables: false));
    }


    [Fact]
    public void FiniteInputsCannotProduceInfiniteOffsetsOrPaperExtents()
    {
        Assert.Throws<ArgumentException>(() => PlanViewport.FitAtScale(
            new Bounds2D(1e308, 0, 1e308, 0), .1, 1, 0, 0, 200, 100));
        Assert.Throws<ArgumentException>(() => PlanViewport.FitAtScale(
            new Bounds2D(0, 1e308, 0, 1e308), .1, 1, 0, 0, 200, 100));
        Assert.Throws<ArgumentException>(() => PlanViewport.FitAtScale(
            new Bounds2D(0, 0, 0, 0), .001, 100, 1e308, 0, 1e308, 100));
        Assert.Throws<ArgumentException>(() => PlanViewport.FitAtScale(
            new Bounds2D(0, 0, 0, 0), .001, 100, 0, 1e308, 200, 1e308));
    }

    [Fact]
    public void ArcEndpointsCannotPretendToBeCompleteBounds()
    {
        Assert.Throws<ArgumentException>(() => Bounds2D.FromVertices(new[] { new PlanVertex(0, 0, 0, 1), new PlanVertex(100, 0) }));
        Assert.Throws<ArgumentException>(() => Bounds2D.FromVertices(new[] { new PlanVertex(double.NaN, 0) }));
        Assert.False(new Bounds2D(10, 0, 0, 20).IsValid);
    }
}
