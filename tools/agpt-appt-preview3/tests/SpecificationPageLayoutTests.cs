using System;
using System.Linq;
using AGPT.Shared;
using Xunit;

public class SpecificationPageLayoutTests
{
    static readonly double[] Widths = { 12, 110, 55, 28, 36, 17, 20, 25, 84 };

    [Theory]
    [InlineData(0, 1)]
    [InlineData(1, 1)]
    [InlineData(20, 1)]
    [InlineData(21, 2)]
    [InlineData(63, 4)]
    public void OrdinaryRowsAreCoveredExactlyOnce(int count, int expectedPages)
    {
        var rows = Enumerable.Range(0, count).Select(i => new[] { i.ToString(), "Модуль", "МГП", "", "", "шт.", "1", "", "Р" });
        var pages = SpecificationPageLayout.Plan(rows, Widths);
        Assert.Equal(expectedPages, pages.Count);
        Assert.Equal(Enumerable.Range(0, count), pages.SelectMany(p => p).Select(f => f.SourceIndex));
        Assert.All(pages, p => Assert.True(p.Sum(f => f.Height) <= 170));
        Assert.All(pages, p => Assert.InRange(p.Count, count == 0 ? 0 : 1, 20));
    }

    [Fact]
    public void LongNamesMarksAndNotesContinueAcrossPagesWithoutLosingAnyText()
    {
        var row = new[] { "12", string.Concat(Enumerable.Repeat("Модуль  газового пожаротушения ", 100)),
            new string('М', 2500), "", "", "шт.", "12", "",
            string.Concat(Enumerable.Repeat(" примечание\\{буквальный текст}\r\n", 120)) };
        var pages = SpecificationPageLayout.Plan(new[] { row }, Widths);
        Assert.True(pages.Count > 1);
        var fragments = pages.SelectMany(p => p).ToArray();
        Assert.False(fragments[0].IsContinuation);
        Assert.All(fragments.Skip(1), f => Assert.True(f.IsContinuation));
        for (int column = 0; column < row.Length; column++)
            Assert.Equal(row[column], string.Concat(fragments.SelectMany(f => f.Cells[column])));
        Assert.All(pages, p => Assert.True(p.Sum(f => f.Height) <= 170));
        Assert.All(fragments, f => Assert.All(f.Cells, c => Assert.InRange(c.Length, 0, 3)));
    }

    [Theory]
    [InlineData(double.NaN)]
    [InlineData(double.PositiveInfinity)]
    [InlineData(double.NegativeInfinity)]
    [InlineData(0)]
    [InlineData(-1)]
    public void InvalidLayoutDimensionsFailBeforeRendering(double invalid)
    {
        var rows = new[] { new[] { "text" } };
        Assert.Throws<ArgumentOutOfRangeException>(() => SpecificationPageLayout.Plan(rows, new[] { invalid }));
        Assert.Throws<ArgumentOutOfRangeException>(() => SpecificationPageLayout.Plan(rows, new[] { 20.0 }, bodyHeight: invalid));
        Assert.Throws<ArgumentOutOfRangeException>(() => SpecificationPageLayout.Plan(rows, new[] { 20.0 }, fontSize: invalid));
        Assert.Throws<ArgumentOutOfRangeException>(() => SpecificationPageLayout.Plan(rows, new[] { 20.0 }, linePitch: invalid));
        Assert.Throws<ArgumentOutOfRangeException>(() => SpecificationPageLayout.Wrap("x", invalid, 2.2));
    }

    [Fact]
    public void NarrowPageStillFitsEveryFragmentAndRejectsMismatchedColumns()
    {
        var pages = SpecificationPageLayout.Plan(new[] { new[] { new string('x', 100) } }, new[] { 10.0 }, bodyHeight: 8);
        Assert.All(pages, p => Assert.True(p.Sum(f => f.Height) <= 8));
        Assert.Throws<ArgumentException>(() => SpecificationPageLayout.Plan(new[] { new[] { "x", "y" } }, new[] { 10.0 }));
        Assert.InRange(Widths.Sum(), 1, 420 - 22 - 5);
    }
}
