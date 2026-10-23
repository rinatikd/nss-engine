"""Validate native v0.42 XYZ export and report quantities; never infer connections."""
import argparse
import json
from pathlib import Path
from .contract_v042 import validate_snapshot, length_units
from .dxf_audit_v042 import FACTORS


def analyze(data):
    report = validate_snapshot(data)
    lengths, failures = {}, []
    for e in data['entities']:
        try:
            length = length_units(e)
            if length is not None:
                lengths[e['handle']] = length
        except (ValueError, OverflowError) as error:
            failures.append(dict(handle=e['handle'], reason=str(error)))
    factor = FACTORS.get(data['drawing']['insunits_code'])
    report.update(schema_version='0.42', drawing=data['drawing'], lengths_units=lengths,
                  meters_per_unit=factor, length_failures=failures,
                  total_length_meters=sum(lengths.values()) * factor if factor is not None else None,
                  source_warnings=data['warnings'], physical_connectivity_confirmed=False,
                  status='review_required')
    return report


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--input', required=True, type=Path)
    p.add_argument('--output', required=True, type=Path)
    a = p.parse_args()
    if a.input.resolve() == a.output.resolve() or a.output.exists():
        p.error('output must be new and separate from input')
    if a.input.stat().st_size > 256_000_000:
        p.error('snapshot exceeds 256 MB input limit')
    result = analyze(json.loads(a.input.read_text(encoding='utf-8-sig')))
    a.output.write_text(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False), encoding='utf8')
    print('valid contract; inventory_complete=' + str(result['inventory_complete']))


if __name__ == '__main__':
    main()
