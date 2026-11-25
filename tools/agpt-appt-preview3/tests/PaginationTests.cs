using System;
using System.Linq;
using AGPT.Shared;
using Xunit;

public class PaginationTests
{
    [Theory]
    [InlineData(0, 4, 1)]
    [InlineData(1, 4, 1)]
    [InlineData(4, 4, 1)]
    [InlineData(5, 4, 2)]
    [InlineData(32, 32, 1)]
    [InlineData(33, 32, 2)]
    [InlineData(100, 32, 4)]
    public void PagesCoverEveryInputExactlyOnce(int total, int capacity, int expectedPages)
    {
        var slices = Pagination.Partition(total, capacity).ToArray();
        Assert.Equal(expectedPages, slices.Length);
        int consumed = 0;
        foreach (var slice in slices)
        {
            Assert.Equal(consumed, slice.Start);
            Assert.InRange(slice.Count, total == 0 ? 0 : 1, capacity);
            consumed += slice.Count;
        }
        Assert.Equal(total, consumed);
        Assert.Equal(Enumerable.Range(0, total), slices.SelectMany(s => Enumerable.Range(s.Start, s.Count)));
    }

    [Fact]
    public void EmptyPartitionCanBeOmittedOrRenderedAsAnExplicitEmptyPage()
    {
        Assert.Empty(Pagination.Partition(0, 32, includeEmpty: false));
        var empty = Assert.Single(Pagination.Partition(0, 32));
        Assert.Equal(0, empty.Start);
        Assert.Equal(0, empty.Count);
    }

    [Theory]
    [InlineData(-1, 4)]
    [InlineData(1, 0)]
    [InlineData(1, -1)]
    public void InvalidBoundsFailAtTheCallInsteadOfDuringRendering(int total, int capacity)
    {
        Assert.Throws<ArgumentOutOfRangeException>(() => Pagination.Partition(total, capacity));
    }

    [Fact]
    public void MaximumInputDoesNotOverflowOrAllocateAnArrayForEveryItem()
    {
        var all = Assert.Single(Pagination.Partition(int.MaxValue, int.MaxValue));
        Assert.Equal(0, all.Start);
        Assert.Equal(int.MaxValue, all.Count);
        var pair = Pagination.Partition(int.MaxValue, int.MaxValue - 1).ToArray();
        Assert.Equal(2, pair.Length);
        Assert.Equal(int.MaxValue - 1, pair[1].Start);
        Assert.Equal(1, pair[1].Count);
        var first = Pagination.Partition(int.MaxValue, 1).First();
        Assert.Equal(0, first.Start);
        Assert.Equal(1, first.Count);
    }
}
