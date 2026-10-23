using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
namespace NssEngine.Export;
internal static class DatabaseStateV042
{
    // Symbol-table enumeration order is not database content. Retain every row,
    // including duplicate rows, while comparing them in a deterministic order.
    internal static string Canonicalize(IEnumerable<object> rows)=>
        JsonSerializer.Serialize(rows.Select(row=>JsonSerializer.Serialize(row)).OrderBy(row=>row,StringComparer.Ordinal));
}
