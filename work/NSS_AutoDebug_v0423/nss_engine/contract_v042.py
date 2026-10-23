"""Versioned XYZ snapshot: no automatic downgrade into legacy XY analyzers."""
import math

MAX_ENTITIES = 1_000_000
MAX_VERTICES = 100_000


def number(x):
    try:
        return type(x) in (int, float) and math.isfinite(x)
    except OverflowError:
        return False


def validate_entity(e):
    if not isinstance(e, dict):
        raise ValueError('entity must be an object')
    if not isinstance(e.get('handle'), str) or not e['handle'].strip() or len(e['handle']) > 128 or not isinstance(e.get('layer'), str):
        raise ValueError('invalid identity')
    v, b, normal = e.get('vertices'), e.get('bulges'), e.get('normal')
    if not isinstance(v, list) or len(v) > MAX_VERTICES or any(not isinstance(p, list) or len(p) != 3 or not all(number(x) and abs(x) <= 1e12 for x in p) for p in v):
        raise ValueError('invalid XYZ')
    if not isinstance(normal, list) or len(normal) != 3 or not all(number(x) for x in normal) or not any(normal):
        raise ValueError('invalid normal')
    if not isinstance(b, list) or not all(number(x) for x in b) or type(e.get('closed')) is not bool or type(e.get('is_xref')) is not bool:
        raise ValueError('invalid bulges/flags')
    kind = e.get('type')
    if kind == 'LINE':
        valid = len(v) == 2 and not b and not e['closed']
    elif kind == 'LWPOLYLINE':
        valid = len(v) >= 2 and len(v) == len(b)
        if valid:
            scale = max(abs(x) for x in normal)
            scaled = [x / scale for x in normal]
            norm = math.hypot(*scaled)
            if not math.isfinite(norm) or norm == 0:
                raise ValueError('invalid normal magnitude')
            unit = [x / norm for x in scaled]
            for p in v:
                delta = [p[i] - v[0][i] for i in range(3)]
                if abs(sum(delta[i] * unit[i] for i in range(3))) > max(1, math.hypot(*delta)) * 1e-9:
                    raise ValueError('nonplanar polyline')
    elif kind == 'INSERT':
        valid = len(v) == 1 and not b and not e['closed'] and isinstance(e.get('block_name'), str) and bool(e['block_name'].strip())
    else:
        valid = False
    if not valid:
        raise ValueError('invalid or unsupported geometry type')
    attrs = e.get('attributes')
    if not isinstance(attrs, dict) or any(not isinstance(k, str) or not isinstance(v, str) for k, v in attrs.items()):
        raise ValueError('invalid attributes')
    if len({k.casefold() for k in attrs}) != len(attrs):
        raise ValueError('duplicate attribute tag')
    return e


def length_units(e):
    validate_entity(e)
    if e['type'] == 'INSERT':
        return None
    v = e['vertices']
    pairs = list(zip(v, v[1:]))
    if e['closed']:
        pairs.append((v[-1], v[0]))
    values = []
    for i, (a, b) in enumerate(pairs):
        chord = math.dist(a, b)
        bulge = e['bulges'][i] if e['bulges'] else 0
        if bulge:
            if chord == 0:
                raise ValueError('bulge with coincident endpoints')
            chord *= (abs(bulge) + 1 / abs(bulge)) * math.atan(abs(bulge))
        if not math.isfinite(chord):
            raise ValueError('length overflow')
        values.append(chord)
    total = math.fsum(values)
    if not math.isfinite(total):
        raise ValueError('length overflow')
    return total


def validate_snapshot(data):
    if not isinstance(data, dict) or data.get('schema_version') != '0.42' or data.get('kind') != 'snapshot3d':
        raise ValueError('expected snapshot3d v0.42')
    d = data.get('drawing')
    if not isinstance(d, dict) or any(not isinstance(d.get(k), str) or not d[k].strip() for k in ('id', 'name')) or d.get('coordinate_system') != 'unverified':
        raise ValueError('invalid drawing identity/coordinate reference status')
    if type(d.get('insunits_code')) is not int or not 0 <= d['insunits_code'] <= 24:
        raise ValueError('invalid INSUNITS')
    records = data.get('entities')
    if not isinstance(records, list) or len(records) > MAX_ENTITIES:
        raise ValueError('invalid entity array')
    handles = set()
    for e in records:
        validate_entity(e)
        if e['handle'].upper() in handles:
            raise ValueError('duplicate handle')
        handles.add(e['handle'].upper())
    c = data.get('coverage')
    if not isinstance(c, dict) or any(type(c.get(k)) is not int or c[k] < 0 for k in ('visited', 'exported', 'skipped')):
        raise ValueError('invalid coverage')
    if c['exported'] != len(records) or c['visited'] != c['exported'] + c['skipped'] or type(c.get('truncated')) is not bool or type(c.get('complete')) is not bool or c['complete'] != (c['skipped'] == 0 and not c['truncated']):
        raise ValueError('inconsistent coverage')
    if not isinstance(data.get('warnings'), list) or any(not isinstance(w, dict) or any(not isinstance(w.get(k), str) for k in ('handle', 'code', 'message')) for w in data['warnings']):
        raise ValueError('invalid warnings')
    return {'valid': True, 'inventory_complete': c['complete'], 'units_confirmed': d['insunits_code'] != 0,
            'coordinate_system_confirmed': False, 'engineering_compliance_confirmed': False}
