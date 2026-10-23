"""Streaming offline audit of reader-supported ModelSpace, NOT an AutoCAD runtime test."""
import argparse
from collections import Counter
import hashlib
import json
import math
from pathlib import Path
from ezdxf.addons import iterdxf
from .contract_v042 import validate_entity, length_units

FACTORS = {1: .0254, 2: .3048, 3: 1609.344, 4: .001, 5: .01, 6: 1., 7: 1000., 10: .9144, 14: .1}


def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def read_units(path):
    """Read only the ASCII DXF HEADER, bounded independently of drawing size."""
    code = None
    in_header = False
    with path.open('rb') as f:
        while f.tell() < 8_000_000:
            group, value = f.readline(), f.readline()
            if not group or not value:
                raise ValueError('truncated/missing HEADER')
            group, value = group.strip(), value.strip()
            if group == b'2' and value == b'HEADER':
                in_header = True
            if in_header and group == b'0' and value == b'ENDSEC':
                return code if code is not None else 0
            if in_header and group == b'9' and value == b'$INSUNITS':
                if code is not None:
                    raise ValueError('duplicate INSUNITS')
                g, v = f.readline().strip(), f.readline().strip()
                if g != b'70':
                    raise ValueError('invalid INSUNITS group')
                code = int(v)
                if not 0 <= code <= 24:
                    raise ValueError('invalid INSUNITS value')
    raise ValueError('HEADER exceeds size limit')


def convert(e):
    kind = e.dxftype()
    record = dict(handle=str(e.dxf.get('handle', '')), layer=e.dxf.layer, type=kind,
                  vertices=[], bulges=[], closed=False, block_name='', attributes={}, normal=[0., 0., 1.], is_xref=False)
    if kind == 'LINE':
        record['vertices'] = [list(e.dxf.start), list(e.dxf.end)]
    elif kind == 'LWPOLYLINE':
        record.update(vertices=[list(p) for p in e.vertices_in_wcs()], bulges=[float(p[2]) for p in e.get_points('xyb')],
                      closed=e.closed, normal=list(e.dxf.extrusion))
    elif kind == 'INSERT':
        # Definition flags need BLOCKS access. Offline export does not pretend to resolve Xrefs.
        record.update(vertices=[list(e.ocs().to_wcs(e.dxf.insert))], block_name=e.dxf.name, normal=list(e.dxf.extrusion))
        if int(e.dxf.get('row_count', 1)) > 1 or int(e.dxf.get('column_count', 1)) > 1:
            raise ValueError('MINSERT array not expanded')
        for a in e.attribs:
            if a.dxf.tag.casefold() in {k.casefold() for k in record['attributes']}:
                raise ValueError('duplicate attribute tag')
            record['attributes'][a.dxf.tag] = a.dxf.text
    else:
        raise ValueError('unsupported entity type ' + kind)
    return validate_entity(record)


def audit(path, output):
    path, output = Path(path).resolve(), Path(output).resolve()
    if output.exists():
        raise ValueError('output must be new')
    before = sha(path)
    units = read_units(path)
    output.mkdir(parents=True)
    counts, exported, skipped, total = Counter(), 0, 0, 0.
    layer_lengths = Counter()
    reader = iterdxf.opendxf(path)
    try:
        with (output/'entities.jsonl').open('w', encoding='utf8') as entities, (output/'warnings.jsonl').open('w', encoding='utf8') as warnings:
            for e in reader.modelspace():
                counts[e.dxftype()] += 1
                handle = str(e.dxf.get('handle', ''))
                try:
                    record = convert(e)
                    length = length_units(record)
                    entities.write(json.dumps(record, ensure_ascii=False, allow_nan=False) + '\n')
                    exported += 1
                    if length is not None:
                        total += length
                        layer_lengths[record['layer']] += length
                    if record['type'] == 'INSERT':
                        warnings.write(json.dumps(dict(handle=handle, code='BLOCK_AND_XREF_GEOMETRY_NOT_RESOLVED', message='Insertion only; definition flags/nested geometry not inspected'), ensure_ascii=False) + '\n')
                except (ValueError, TypeError, OverflowError) as error:
                    skipped += 1
                    warnings.write(json.dumps(dict(handle=handle, code='UNSUPPORTED_OR_INVALID_ENTITY', message=str(error)), ensure_ascii=False) + '\n')
    finally:
        reader.close()
    if sha(path) != before:
        raise RuntimeError('source changed')
    result = dict(schema_version='0.42', source=str(path), sha256=before, source_unchanged=True,
                  producer='ezdxf_offline', scope='reader-supported top-level ModelSpace only',
                  types=dict(counts), visited=sum(counts.values()), exported=exported, skipped=skipped,
                  insunits_code=units, meters_per_unit=FACTORS.get(units), length_units=total,
                  length_meters=total * FACTORS[units] if units in FACTORS else None,
                  layer_lengths_units=dict(layer_lengths), complete_drawing_coverage=False,
                  coordinate_system='unverified', physical_connectivity_confirmed=False,
                  limitations=['Reader omits some native/proxy types; not a full drawing inventory.',
                               'Blocks and Xrefs are not expanded; INSERT points are not physical well connections.',
                               'Units are declared INSUNITS; actual drawing scale has not been independently verified.',
                               'No topology, routing or normative check performed by this audit.'])
    (output/'summary.json').write_text(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False), encoding='utf8')
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', required=True, type=Path)
    parser.add_argument('files', nargs='+', type=Path)
    args = parser.parse_args()
    if args.out.exists():
        parser.error('output must be new')
    args.out.mkdir(parents=True)
    summaries = []
    for i, path in enumerate(args.files, 1):
        report = audit(path, args.out/f'{i:02d}_{path.stem}')
        summaries.append(report)
        print(json.dumps({k: report[k] for k in ('source', 'visited', 'exported', 'skipped', 'insunits_code', 'length_units')}, ensure_ascii=False), flush=True)
    (args.out/'summary.json').write_text(json.dumps(summaries, ensure_ascii=False, indent=2), encoding='utf8')


if __name__ == '__main__':
    main()
