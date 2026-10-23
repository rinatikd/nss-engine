"""Uniform grid spatial index for 2D segment bounding boxes."""
from collections import defaultdict
from math import floor, isfinite

class SegmentGrid:
    def __init__(self, segments, cell_size=10.0, max_cells=250000, max_cells_per_segment=4096):
        if not isfinite(cell_size) or cell_size <= 0:
            raise ValueError('cell_size must be positive and finite')
        self.segments = list(segments)
        self.cell_size = cell_size
        self.cells = defaultdict(list)
        self.max_cells=max_cells
        self.max_cells_per_segment=max_cells_per_segment
        self.overflow=[]
        self.memberships=0
        if type(max_cells) is not int or max_cells<1 or type(max_cells_per_segment) is not int or max_cells_per_segment<1:
            raise ValueError('invalid index limits')
        for i, s in enumerate(self.segments):
            if self._count(s.a,s.b)>max_cells_per_segment or self.memberships+self._count(s.a,s.b)>max_cells:
                self.overflow.append(i)
                continue
            self.memberships+=self._count(s.a,s.b)
            for cell in self._cells_for(s.a, s.b):
                self.cells[cell].append(i)

    def _count(self,a,b):
        if len(a)!=2 or len(b)!=2 or any(not isfinite(v) for v in (*a,*b)):
            raise ValueError('finite XY coordinates required')
        c=self.cell_size
        return (floor(max(a[0],b[0])/c)-floor(min(a[0],b[0])/c)+1)*(floor(max(a[1],b[1])/c)-floor(min(a[1],b[1])/c)+1)

    def _cells_for(self, a, b):
        c = self.cell_size
        for x in range(floor(min(a[0],b[0])/c), floor(max(a[0],b[0])/c)+1):
            for y in range(floor(min(a[1],b[1])/c), floor(max(a[1],b[1])/c)+1):
                yield x, y

    def candidates(self, a, b, padding=0):
        if not isfinite(padding) or padding < 0: raise ValueError('padding must be finite and nonnegative')
        lo=(min(a[0],b[0])-padding,min(a[1],b[1])-padding)
        hi=(max(a[0],b[0])+padding,max(a[1],b[1])+padding)
        if self._count(lo,hi)>self.max_cells_per_segment:
            ids=set(range(len(self.segments)))
        else:
            ids=set(self.overflow)
            for cell in self._cells_for(lo,hi): ids.update(self.cells.get(cell,()))
        ids={i for i in ids if max(self.segments[i].a[0],self.segments[i].b[0])>=lo[0] and min(self.segments[i].a[0],self.segments[i].b[0])<=hi[0] and max(self.segments[i].a[1],self.segments[i].b[1])>=lo[1] and min(self.segments[i].a[1],self.segments[i].b[1])<=hi[1]}
        return (self.segments[i] for i in sorted(ids))
