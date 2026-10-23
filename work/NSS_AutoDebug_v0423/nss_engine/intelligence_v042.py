"""Explainable proposals from exact layers, block names and explicit attributes.
No proposal is engineering approval; conflicts never silently pick one network.
"""
import re
from .contract_v042 import validate_entity

DEFAULT_LAYERS = {
    'НСС': 'telecom', 'НСС проектир': 'telecom', 'пр_телефонная_канализация': 'telecom',
    'СС': 'telecom', 'NSS': 'telecom', 'NSS_NETWORK': 'telecom', 'НСС_Колодцы_Проект': 'telecom',
    'НСС_Колодцы_Существ': 'telecom', 'Газопровод': 'gas', 'Водопровод': 'water',
    'Канализации': 'sewer', 'Теплотрассы': 'heat', 'ЛЭП': 'power',
}
CATEGORIES = {'telecom', 'water', 'sewer', 'gas', 'heat', 'power', 'unknown'}
ATTR_VALUES = {'NSS': 'telecom', 'TELECOM': 'telecom', 'НСС': 'telecom',
               'GAS': 'gas', 'ГАЗ': 'gas', 'WATER': 'water', 'ВОДА': 'water',
               'SEWER': 'sewer', 'POWER': 'power', 'HEAT': 'heat'}


def recognize(record, layer_mapping=None):
    validate_entity(record)
    mapping = DEFAULT_LAYERS if layer_mapping is None else layer_mapping
    if not isinstance(mapping, dict) or any(not isinstance(k,str) or v not in CATEGORIES for k,v in mapping.items()):
        raise ValueError('invalid layer mapping')
    normalized={}
    for key,value in mapping.items():
        key=key.strip().casefold()
        if key in normalized and normalized[key]!=value:
            raise ValueError('conflicting layer mapping')
        normalized[key]=value
    layer=record['layer'].strip().casefold()
    if re.search(r'условн.*обознач|штамп|legend|оформление',layer):
        return dict(category='unknown',kind='annotation',confidence=0.,evidence=['annotation_layer'],review_required=True)
    evidence=[];categories=set()
    if layer in normalized and normalized[layer]!='unknown':
        categories.add(normalized[layer]);evidence.append('exact_layer:'+record['layer'])
    well=record['type']=='INSERT' and re.match(r'^(NSS_KKS|ККС|KKS)(?:\b|_)',record['block_name'],re.I) is not None
    if well:
        categories.add('telecom');evidence.append('block_well_name:'+record['block_name'])
    for tag,value in record['attributes'].items():
        if tag.upper() in ('NETWORK','SYSTEM','СЕТЬ') and value.strip().upper() in ATTR_VALUES:
            categories.add(ATTR_VALUES[value.strip().upper()]);evidence.append('attribute:'+tag+'='+value)
    conflict=len(categories)>1
    return dict(category=next(iter(categories)) if len(categories)==1 else 'unknown',
                kind='well_symbol' if well else ('insertion' if record['type']=='INSERT' else 'route_geometry'),
                confidence=(.95 if any(e.startswith('exact_layer:') for e in evidence) else .8) if len(categories)==1 else 0.,
                evidence=evidence or ['no_semantic_evidence'],conflict=conflict,review_required=True)
