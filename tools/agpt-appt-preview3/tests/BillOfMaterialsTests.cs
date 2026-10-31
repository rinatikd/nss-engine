using System;
using System.IO;
using AGPT.Shared;
using Xunit;

public class BillOfMaterialsTests
{
    [Fact]
    public void CountsOnlyActualInstancesAndKeepsReserveSeparate()
    {
        var bill = new BillOfMaterials();
        bill.Add("Модуль", "МГП-40", "шт.", 1, "Рабочий");
        bill.Add("Модуль", "МГП-40", "шт.", 1, "Рабочий");
        bill.Add("Модуль", "МГП-40", "шт.", 1, "Резерв");
        Assert.Equal(2, bill.Rows.Count);
        Assert.Contains(bill.Rows, x => x.Note == "Рабочий" && x.Quantity == 2);
        Assert.Contains(bill.Rows, x => x.Note == "Резерв" && x.Quantity == 1);
    }

    [Fact]
    public void PipeMetresAreSummedWithoutInventingSpareEquipment()
    {
        var bill = new BillOfMaterials();
        bill.Add("Труба", "Ду20", "м", 5.25);
        bill.Add("Труба", "Ду20", "м", 3.75);
        bill.Add("Труба", "Ду25", "м", 2);
        Assert.Equal(2, bill.Rows.Count);
        Assert.Contains(bill.Rows, x => x.Mark == "Ду20" && x.Quantity == 9);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-1)]
    [InlineData(double.NaN)]
    [InlineData(double.PositiveInfinity)]
    public void InvalidQuantitiesDoNotEnterTheSpecification(double quantity)
    {
        var bill = new BillOfMaterials();
        Assert.Throws<ArgumentOutOfRangeException>(() => bill.Add("Труба", "Ду20", "м", quantity));
        Assert.Empty(bill.Rows);
    }

    [Fact]
    public void EmptyModelHasAnEmptySpecification()
    {
        Assert.Empty(new BillOfMaterials().Rows);
    }

    [Fact]
    public void BundledResourceIsFoundInAPathWithSpacesAndCyrillic()
    {
        string root = Path.Combine(Path.GetTempPath(), "AGPT проверка " + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(Path.Combine(root, "blocks"));
        try
        {
            string expected = Path.Combine(root, "blocks", "Садик_UGO_source.dwg");
            File.WriteAllBytes(expected, new byte[] { 1, 2, 3 });
            Assert.Equal(expected, ResourceLocator.FindBlockFile(root, "Садик_UGO_source.dwg"));
            Assert.Null(ResourceLocator.FindBlockFile(root, "missing.dwg"));
        }
        finally { Directory.Delete(root, true); }
    }
}
