using System;
using System.Collections.Generic;

namespace AGPT.Shared
{
    public readonly struct Slice
    {
        public int Start { get; }
        public int Count { get; }
        public Slice(int start, int count) { Start = start; Count = count; }
    }

    public static class Pagination
    {
        // Validation happens at the call, before a lazy enumeration starts.
        public static IEnumerable<Slice> Partition(int total, int capacity, bool includeEmpty = true)
        {
            if (total < 0) throw new ArgumentOutOfRangeException(nameof(total));
            if (capacity <= 0) throw new ArgumentOutOfRangeException(nameof(capacity));
            return Enumerate(total, capacity, includeEmpty);
        }

        static IEnumerable<Slice> Enumerate(int total, int capacity, bool includeEmpty)
        {
            if (total == 0)
            {
                if (includeEmpty) yield return new Slice(0, 0);
                yield break;
            }
            int start = 0;
            while (start < total)
            {
                int count = Math.Min(capacity, total - start);
                yield return new Slice(start, count);
                start += count; // At most total, including int.MaxValue.
            }
        }
    }
}
