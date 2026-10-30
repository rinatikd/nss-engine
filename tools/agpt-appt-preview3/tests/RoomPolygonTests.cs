using System;
using AGPT.Shared;
using Xunit;

public class RoomPolygonTests
{
    [Fact]
    public void RectangleInEitherWindingAndConcaveRoomAreAccepted()
    {
        var rectangle = new[] { new PlanVertex(0, 0), new(10, 0), new(10, 6), new(0, 6) };
        RoomPolygon.Validate(rectangle);
        Array.Reverse(rectangle);
        RoomPolygon.Validate(rectangle);
        RoomPolygon.Validate(new[] { new PlanVertex(0, 0), new(10, 0), new(10, 3), new(5, 3), new(5, 6), new(0, 6) });
    }

    [Fact]
    public void LargeWorldOriginDoesNotCorruptAreaOrIntersectionChecks()
    {
        const double offset = 1e12;
        RoomPolygon.Validate(new[] { new PlanVertex(offset, offset, 7), new(offset + 10, offset, 7),
            new(offset + 10, offset + 6, 7), new(offset, offset + 6, 7) });
    }

    [Fact]
    public void BowTieIsRejected()
    {
        Assert.Throws<ArgumentException>(() => RoomPolygon.Validate(new[] {
            new PlanVertex(0, 0), new(10, 6), new(0, 6), new(10, 0) }));
    }

    [Fact]
    public void CrossingWithNonzeroSignedAreaIsRejected()
    {
        Assert.Throws<ArgumentException>(() => RoomPolygon.Validate(new[] {
            new PlanVertex(0, 0), new(10, 6), new(0, 6), new(10, 0), new(15, 0) }));
    }

    [Fact]
    public void TouchingOrOverlappingNonadjacentEdgesAreRejected()
    {
        Assert.Throws<ArgumentException>(() => RoomPolygon.Validate(new[] {
            new PlanVertex(0, 0), new(10, 0), new(10, 6), new(5, 0), new(0, 6) }));
        Assert.Throws<ArgumentException>(() => RoomPolygon.Validate(new[] {
            new PlanVertex(0, 0), new(10, 0), new(10, 6), new(3, 6), new(3, 0), new(7, 0), new(7, 3), new(0, 3) }));
    }

    [Fact]
    public void AdjacentEdgesCannotRetraceButMayContinueStraight()
    {
        Assert.Throws<ArgumentException>(() => RoomPolygon.Validate(new[] {
            new PlanVertex(0, 0), new(10, 0), new(5, 0), new(5, 6), new(0, 6) }));
        RoomPolygon.Validate(new[] { new PlanVertex(0, 0), new(5, 0), new(10, 0), new(10, 6), new(0, 6) });
    }

    [Fact]
    public void RepeatedAdjacentOrNonadjacentCornersAreRejected()
    {
        Assert.Throws<ArgumentException>(() => RoomPolygon.Validate(new[] {
            new PlanVertex(0, 0), new(0, 0), new(10, 0), new(0, 6) }));
        Assert.Throws<ArgumentException>(() => RoomPolygon.Validate(new[] {
            new PlanVertex(0, 0), new(10, 0), new(10, 6), new(0, 0), new(0, 6) }));
    }

    [Fact]
    public void MissingCornersAndZeroAreaAreRejected()
    {
        Assert.Throws<ArgumentException>(() => RoomPolygon.Validate(null));
        Assert.Throws<ArgumentException>(() => RoomPolygon.Validate(new[] { new PlanVertex(0, 0), new(10, 0) }));
        Assert.Throws<ArgumentException>(() => RoomPolygon.Validate(new[] { new PlanVertex(0, 0), new(5, 0), new(10, 0) }));
    }

    [Fact]
    public void NonfiniteCoordinatesElevationChangesAndBulgesAreRejected()
    {
        foreach (var bad in new[] { new PlanVertex(double.NaN, 0), new PlanVertex(0, double.PositiveInfinity),
            new PlanVertex(0, 0, double.NaN), new PlanVertex(0, 0, 1), new PlanVertex(0, 0, 0, .1) })
            Assert.Throws<ArgumentException>(() => RoomPolygon.Validate(new[] { bad, new PlanVertex(10, 0), new(0, 6) }));
    }

    [Fact]
    public void UnrepresentableAreaAndCoordinateDifferencesAreRejected()
    {
        Assert.Throws<ArgumentException>(() => RoomPolygon.Validate(new[] {
            new PlanVertex(0, 0), new(1e200, 0), new(0, 1e200) }));
        Assert.Throws<ArgumentException>(() => RoomPolygon.Validate(new[] {
            new PlanVertex(-1e308, 0), new(1e308, 0), new(0, 1) }));
    }
}
