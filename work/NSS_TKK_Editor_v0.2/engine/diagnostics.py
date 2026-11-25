"""Locate review issues without changing or inferring network connectivity."""
import hashlib
import json
from collections import Counter
from pathlib import Path

from shapely.geometry import LineString, Point


TITLES = {
    'UNRESOLVED_CONNECTION': 'Цепочка с неподтверждённым концом',
    'WELL_OFF_ROUTE': 'Колодец вне распознанной трассы',
    'UNANCHORED_LOOP': 'Замкнутая трасса без колодца',
    'SELF_RETURNING_SPAN': 'Участок возвращается к тому же узлу',
    'SPAN_OVER_120M': 'Длина участка превышает 120 м',
    'PROTECTED_WELL_DELETED': 'Закреплённый колодец отсутствует',
    'WELL_SPACING_BELOW_RESOLUTION': 'Колодцы ближе разрешения трассы',
    'ZERO_LENGTH_SEGMENT': 'Нулевой сегмент трассы в XY',
    'SELF_INTERSECTION': 'Самопересечение трассы в XY',
    'WELL_PAIR_REVIEW_LIMIT': 'Слишком много близких пар колодцев',
}
REASONS = {
    'OPEN_ENDPOINT': 'Свободный конец трассы; соединение требует проверки.',
    'BRANCH_WITHOUT_WELL': 'Ветвление без распознанного колодца.',
    'NEAR_WELL_TAIL': 'Короткий остаток трассы рядом с колодцем; проверьте фактический конец.',
    'TOUCHES_OTHER_ROUTE': 'Рядом проходит другая трасса; совпадение XY не подтверждает соединение.',
}


def _bounds(points):
    if not points:
        return None
    return [min(p[0] for p in points), min(p[1] for p in points),
            max(p[0] for p in points), max(p[1] for p in points)]


def enrich_warnings(warnings, wells, routes, numbering):
    """Return stable, located issues; never mutate input geometry or graph edges."""
    lines = {r['id']: LineString([p[:2] for p in r['points']]) for r in routes}
    result = []
    for original in warnings:
        issue = dict(original)
        code = issue['code']
        issue['title'] = TITLES.get(code, code)
        source_ids = set(issue.get('routes', []))
        for field in ('id', 'other_id', 'start', 'end'):
            identity = issue.get(field)
            if identity in wells or identity in lines:
                source_ids.add(identity)
        points = list(issue.pop('review_points', []))
        if code == 'WELL_OFF_ROUTE':
            points = [wells[issue['id']]['xyz'][:2]]
            issue['endpoints'] = [dict(xy=points[0], kind='off_route_well', well_id=issue['id'])]
        elif not points:
            for identity in source_ids:
                if identity in wells:
                    points.append(wells[identity]['xyz'][:2])
                if identity in lines:
                    points.extend(list(lines[identity].coords))
        for endpoint in issue.get('endpoints', []):
            point = Point(endpoint['xy'])
            excluded = endpoint.get('well_id')
            if excluded in numbering:
                endpoint['well_number'] = numbering[excluded]
            near_wells = sorted(
                (dict(id=k, number=numbering[k], distance_m=point.distance(Point(w['xyz'][:2])), xy=w['xyz'][:2])
                 for k, w in wells.items() if k != excluded),
                key=lambda item: (item['distance_m'], item['id']))[:3]
            near_routes = []
            for identity, line in lines.items():
                if identity in issue.get('routes', []):
                    continue
                nearest = line.interpolate(line.project(point))
                near_routes.append(dict(id=identity, distance_m=point.distance(nearest), xy=list(nearest.coords[0])))
            near_routes.sort(key=lambda item: (item['distance_m'], item['id']))
            endpoint['nearby_wells'] = near_wells
            endpoint['nearby_routes'] = near_routes[:3]
            if endpoint.get('kind') == 'unresolved':
                if endpoint.get('degree', 0) > 2:
                    reason = 'BRANCH_WITHOUT_WELL'
                elif issue.get('length_m', float('inf')) <= 2 and near_wells and near_wells[0]['distance_m'] <= 1.1:
                    reason = 'NEAR_WELL_TAIL'
                elif near_routes and near_routes[0]['distance_m'] < .2:
                    reason = 'TOUCHES_OTHER_ROUTE'
                else:
                    reason = 'OPEN_ENDPOINT'
                endpoint['reason'] = reason
                endpoint['explanation'] = REASONS[reason]
        issue['source_ids'] = sorted(source_ids)
        issue['bounds'] = _bounds(points)
        # END:* graph nodes depend on insertion order. Stable issue identities use
        # source handles and actual geometry, never transient node names.
        identity = dict(code=code, sources=issue['source_ids'], missing_id=issue.get('id'),
                        ends=sorted([list(map(lambda n: round(n, 6), e['xy'])) for e in issue.get('endpoints', [])]),
                        review_points=sorted([list(map(lambda n: round(n, 6), p[:2])) for p in points]),
                        details={key: issue.get(key) for key in ('other_id', 'segment_index') if key in issue},
                        bounds=[round(n, 6) for n in issue['bounds']] if issue['bounds'] else None)
        issue['issue_id'] = 'NSS-' + hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()[:16].upper()
        result.append(issue)
    if len({i['issue_id'] for i in result}) != len(result):
        raise ValueError('Review issue identity collision')
    return sorted(result, key=lambda item: (item['code'], item['source_ids'], item['issue_id']))


def summary(warnings, well_pair_review_tolerance_m=0.005, zero_xy_segment_tolerance_m=1e-12):
    return dict(schema_version=1, total=len(warnings), by_code=dict(sorted(Counter(w['code'] for w in warnings).items())),
                coordinate_system='Drawing WCS XY, meters',
                tolerances_m=dict(well_to_route=1.1, endpoint_merge=.2,
                                  minimum_segment=.005,
                                  well_pair_review=well_pair_review_tolerance_m,
                                  zero_xy_segment=zero_xy_segment_tolerance_m),
                connectivity_inferred=False)


def write_reports(data, result, folder):
    """Write reports next to this worker result, tied to its fingerprint/job."""
    folder = Path(folder)
    report = dict(phase='READY', job_id=data.get('job_id'), fingerprint=data.get('fingerprint'),
                  diagnostics=result['diagnostics'], issues=result['warnings'])
    text = ['# Проверка соединений NSS', '',
            f"Всего предупреждений: **{len(report['issues'])}**. Координаты WCS XY, расстояния в метрах.", '',
            'Близость объектов и совпадение XY не подтверждают инженерное соединение. Геометрия и связи этим отчётом не изменяются.', '',
            f"Расчёт: `{report['job_id'] or 'standalone'}`. Отпечаток: `{report['fingerprint'] or 'not supplied'}`.", '',
            'В AutoCAD: `NSS_TKK_ISSUES` — обновить список; `NSS_TKK_ISSUE` — выбрать номер; `NSS_TKK_NEXT_ISSUE` — следующий.', '']
    for index, issue in enumerate(report['issues'], 1):
        text += [f"## {index}. {issue['title']} — {issue['issue_id']}", '',
                 f"Код: `{issue['code']}`. Объекты: {', '.join('`'+k+'`' for k in issue['source_ids']) or 'отсутствуют в чертеже'}."]
        if issue.get('id') and not issue['source_ids']:
            text.append(f"Отсутствующий объект: `{issue['id']}`; номер {issue.get('number', '—')} зарезервирован.")
        if 'length_m' in issue or 'length' in issue:
            text.append(f"Длина: {issue.get('length_m', issue.get('length')):.3f} м.")
        if issue.get('message'):
            text.append(issue['message'])
        if issue['bounds']:
            text.append('Область XY: ' + ', '.join(f'{n:.3f}' for n in issue['bounds']) + '.')
        text.append('')
        for end_index, endpoint in enumerate(issue.get('endpoints', []), 1):
            x, y = endpoint['xy']
            kind = {'well': 'распознанный колодец', 'building_entry': 'ввод в здание',
                    'unresolved': 'неподтверждённый узел', 'off_route_well': 'колодец вне трассы'}.get(endpoint['kind'], endpoint['kind'])
            if 'well_number' in endpoint:
                kind += f" КК-{endpoint['well_number']} (`{endpoint['well_id']}`)"
            text += [f"Конец {end_index}: X={x:.3f}, Y={y:.3f}; {kind}.",
                     endpoint.get('explanation', 'Распознанная граница участка.'), '']
            candidates = [(kind, c) for kind, field in [('Колодец', 'nearby_wells'), ('Трасса', 'nearby_routes')]
                          for c in endpoint[field]]
            if candidates:
                text += ['| Объект | Handle | Расстояние XY, м |', '| --- | --- | ---: |']
                for kind, candidate in candidates:
                    label = kind + (f" КК-{candidate['number']}" if 'number' in candidate else '')
                    text.append(f"| {label} | `{candidate['id']}` | {candidate['distance_m']:.3f} |")
                text.append('')
    for name, value in [('issues.json', json.dumps(report, ensure_ascii=False, indent=2)),
                        ('ISSUES_RU.md', '\n'.join(text) + '\n')]:
        target = folder / name
        temporary = target.with_suffix(target.suffix + '.tmp')
        temporary.write_text(value, encoding='utf8')
        temporary.replace(target)
