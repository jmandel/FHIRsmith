#!/usr/bin/env python3
# Writes the output-heavy catalog entries (entries/oh-*.json): requests whose cost is in building
# response rows (properties, designations, definitions) rather than in computing membership.
# Only oh-* files are written; the other entries are edited by hand or by generate-entries.py.
#
#   python3 -I tools/generate-output-heavy.py [--out DIR]
import json, os, re, argparse

HERE = os.path.dirname(os.path.abspath(__file__))
ap = argparse.ArgumentParser()
ap.add_argument('--out', default=os.path.join(HERE, '..', 'entries'))
OUT = ap.parse_args().out

SCT = 'http://snomed.info/sct'; LOINC = 'http://loinc.org'; RX = 'http://www.nlm.nih.gov/research/umls/rxnorm'
SQLITE = [SCT, LOINC, RX]
entries = []

def F(p, op, v): return {'property': p, 'op': op, 'value': v}
def VS(id_, include, compose_property=None):
    c = {}
    if compose_property: c['property'] = compose_property
    c['include'] = include
    return {'resourceType': 'ValueSet', 'url': 'urn:fhirsmith:catalog:' + id_, 'status': 'active', 'compose': c}
def E(id_, title, systems, exercises, why, stresses, expect, request, patterns=None, count=None, deep=None):
    r = request if 'operation' in request else {'operation': 'expand', **request}
    e = {'id': id_, 'title': title, 'category': 'output-heavy', 'source': {'kind': 'constructed'},
         'exercises': exercises, 'why': why, 'stresses': stresses, 'expect': expect, 'request': r}
    if r['operation'] == 'expand':
        e['patterns'] = patterns or ['first-page']
        e['paging'] = {'count': count}
        if deep is not None: e['paging']['deepOffset'] = deep
    e['orderDefined'] = False
    e['systems'] = systems
    e['engine'] = {'sqlite': [s for s in systems if s in SQLITE], 'main': [s for s in systems if s not in SQLITE]}
    entries.append(e)

SCT_PROPS = ['parent', 'child', 'inactive', 'sufficientlyDefined', 'moduleId', 'effectiveTime', '363698007', '116676008', '246075003', 'normalForm']
LOINC_PROPS = ['COMPONENT', 'PROPERTY', 'TIME_ASPCT', 'SYSTEM', 'SCALE_TYP', 'METHOD_TYP', 'CLASS', 'CLASSTYPE', 'STATUS', 'ORDER_OBS',
               'EXAMPLE_UCUM_UNITS', 'parent', 'answers-for']
RX_PROPS = ['TTY', 'STY', 'SAB', 'has_ingredient', 'has_dose_form', 'has_tradename', 'tradename_of', 'ingredient_of', 'consists_of', 'isa']

E('oh-sct-expand-many-properties', 'Diabetes subtree with ten properties per code (incl. normalForm)', [SCT],
  '$expand property= parent, child, inactive, sufficientlyDefined, moduleId, effectiveTime, three attributes, normalForm',
  'Mixed: membership is one set, but each of 124 rows needs parent/child links, attribute rows and a computed normal form.',
  '124 rows x ~10 properties; normalForm is computed per concept; children are an inverse prop set',
  'mixed', {'valueSet': VS('oh-sct-expand-many-properties', [{'system': SCT, 'filter': [F('concept', 'is-a', '73211009')]}]),
            'parameters': {'property': SCT_PROPS}}, count=1000)
E('oh-sct-expand-property-star', 'Myocardial infarction subtree with property=* (every property)', [SCT],
  '$expand property=* (all properties the code system defines for each concept)',
  'Mixed: every relationship and literal of 124 concepts is read and serialised.',
  '124 rows x all properties (parents, children, all attributes in role groups, module, status)',
  'mixed', {'valueSet': VS('oh-sct-expand-property-star', [{'system': SCT, 'filter': [F('concept', 'is-a', '22298006')]}]),
            'parameters': {'property': '*'}}, count=1000)
E('oh-sct-compose-property', 'Properties requested in the definition (compose.property, R5/R6)', [SCT],
  'ValueSet.compose.property = parent, 363698007, inactive (no request parameter)',
  'Fast if supported: same rows as a property parameter; checks the definition-side form.',
  '~130 rows x 3 properties',
  'fast', {'valueSet': VS('oh-sct-compose-property', [{'system': SCT, 'filter': [F('concept', 'is-a', '38341003')]}], compose_property=['parent', '363698007', 'inactive'])}, count=1000)
E('oh-loinc-expand-many-properties', 'Quantitative glucose terms with thirteen LOINC properties', [LOINC],
  '$expand property= the six axes, CLASS, CLASSTYPE, STATUS, ORDER_OBS, EXAMPLE_UCUM_UNITS, parent, answers-for',
  'Fast: 75 rows, each with ~13 part/literal facts.',
  '75 rows x ~13 properties (part codes for the six axes)',
  'fast', {'valueSet': VS('oh-loinc-expand-many-properties', [{'system': LOINC, 'filter': [F('SCALE_TYP', '=', 'LP7753-9'), F('COMPONENT', '=', 'LP14635-4')]}]),
           'parameters': {'property': LOINC_PROPS}}, count=1000)
E('oh-loinc-property-star-1000', 'Laboratory LOINC terms, 1,000 per page, property=*', [LOINC],
  '$expand CLASSTYPE=1 with property=* and count=1000, first page and a deep page',
  'Slow-ish: 1,000 rows x every property; row building dominates, not membership.',
  '1,000 rows x ~15-25 properties; response in the megabytes',
  'mixed', {'valueSet': VS('oh-loinc-property-star-1000', [{'system': LOINC, 'filter': [F('CLASSTYPE', '=', '1')]}]),
            'parameters': {'property': '*'}}, ['first-page', 'deep-jump'], 1000, 2000)
# active metformin-containing SCDs in RxNorm 03022026 (TTY = SCD filtered by has_ingredient = CUI:6809 returns 0 on tx.fhir.org)
METFORMIN_SCD = ['428759', '860975', '431724', '861731', '861736', '861740', '861743', '861748', '861753', '246522', '432366', '432780', '250919', '429841', '541775']
E('oh-rxnorm-expand-properties', 'Fifteen metformin SCDs with ten RxNorm properties', [RX],
  '$expand property= TTY, STY, SAB, and seven relationship properties',
  'Fast: few rows, but relationship properties fan out (consists_of, ingredient_of).',
  '15 rows x ~10 properties, several multi-valued',
  'fast', {'valueSet': VS('oh-rxnorm-expand-properties', [{'system': RX, 'concept': [{'code': c} for c in METFORMIN_SCD]}]),
           'parameters': {'property': RX_PROPS}}, count=1000)
E('oh-rxnorm-property-star', 'Acetaminophen brands with property=*', [RX],
  '$expand property=* on RxNorm brand names',
  'Mixed: brand names have many tradename_of/ingredient_of links.',
  '~366 rows x all properties',
  'mixed', {'valueSet': VS('oh-rxnorm-property-star', [{'system': RX, 'filter': [F('TTY', '=', 'BN'), F('tradename_of', '=', 'CUI:161')]}]),
            'parameters': {'property': '*'}}, count=1000)
E('oh-sct-designations-1000', 'Clinical findings, 1,000 per page, with all designations', [SCT],
  'includeDesignations=true, count=1000, first page and a deep page within tx.fhir.org\'s 3,000 limit',
  'Mixed: 1,000 rows x ~3-6 designations each (FSN, synonyms, inactive descriptions).',
  '1,000 rows, ~4,000 designation rows with use and language-refset acceptability',
  'mixed', {'valueSet': VS('oh-sct-designations-1000', [{'system': SCT, 'filter': [F('concept', 'is-a', '404684003')]}]),
            'parameters': {'includeDesignations': True}}, ['first-page', 'deep-jump'], 1000, 2000)
E('oh-loinc-designations-all-languages-1000', 'Laboratory LOINC, 1,000 per page, designations in every language', [LOINC],
  'includeDesignations=true, no displayLanguage, count=1000',
  'Slow-ish: up to ~20 language variants x several name kinds per code.',
  '1,000 rows x ~15-40 designations; the largest response in the catalog',
  'mixed', {'valueSet': VS('oh-loinc-designations-all-languages-1000', [{'system': LOINC, 'filter': [F('CLASSTYPE', '=', '1')]}]),
            'parameters': {'includeDesignations': True}}, ['first-page'], 1000)
E('oh-loinc-designations-weighted-languages', 'Glucose terms with displayLanguage nl-NL,de-DE;q=0.8,fr-FR;q=0.5 and designations', [LOINC],
  'displayLanguage as a weighted Accept-Language list, plus includeDesignations',
  'Fast: 845 rows; display chosen per code by language preference.',
  '845 rows x all designations; display picked from three languages with fallback',
  'fast', {'valueSet': VS('oh-loinc-designations-weighted-languages', [{'system': LOINC, 'filter': [F('concept', 'is-a', 'LP14635-4')]}]),
           'parameters': {'includeDesignations': True, 'displayLanguage': 'nl-NL,de-DE;q=0.8,fr-FR;q=0.5'}, 'recordDisplays': True}, count=1000)
E('oh-loinc-designation-filter', 'Glucose terms, designations restricted to nl-NL and fr-FR (designation parameter)', [LOINC],
  'includeDesignations=true with designation=nl-NL and designation=fr-FR',
  'Fast: the filter shrinks output; checks which designations survive.',
  '845 rows x 2 languages of designations',
  'fast', {'valueSet': VS('oh-loinc-designation-filter', [{'system': LOINC, 'filter': [F('concept', 'is-a', 'LP14635-4')]}]),
           'parameters': {'includeDesignations': True, 'designation': ['nl-NL', 'fr-FR']}}, count=1000)
E('oh-sct-designation-filter-fsn', 'Clinical findings, 1,000 per page, FSN designations only', [SCT],
  'includeDesignations=true with designation=http://snomed.info/sct|900000000000003001 (use = FSN)',
  'Fast: one designation per row after the filter.',
  '1,000 rows x 1 designation (FSN)',
  'fast', {'valueSet': VS('oh-sct-designation-filter-fsn', [{'system': SCT, 'filter': [F('concept', 'is-a', '404684003')]}]),
           'parameters': {'includeDesignations': True, 'designation': SCT + '|900000000000003001'}}, count=1000)
E('oh-sct-include-definition', 'Children of autosomal recessive hereditary disorder with includeDefinition', [SCT],
  'includeDefinition=true on a subtree where most concepts have SNOMED text definitions',
  'Fast: one definition read per row (about 1,000 of the 1,079 children have one).',
  '~1,080 rows x 1 definition text (often several hundred characters)',
  'fast', {'valueSet': VS('oh-sct-include-definition', [{'system': SCT, 'filter': [F('concept', 'child-of', '85995004')]}]),
           'parameters': {'includeDefinition': True}}, count=1000)
E('oh-loinc-include-definition', 'Glucose terms with includeDefinition (LOINC DefinitionDescription)', [LOINC],
  'includeDefinition=true on LOINC terms',
  'Fast; records whether a LOINC definition is served (our 2.83 import stores none).',
  '845 rows x 0-1 definition',
  'fast', {'valueSet': VS('oh-loinc-include-definition', [{'system': LOINC, 'filter': [F('concept', 'is-a', 'LP14635-4')]}]),
           'parameters': {'includeDefinition': True}}, count=1000)
E('oh-deep-designations-properties', 'Clinical findings at offset 2,500: designations and properties at depth', [SCT],
  'includeDesignations + property=parent,inactive,moduleId at offset 2,500 (inside tx.fhir.org\'s 3,000 limit) and 100,000',
  'Mixed: the engine reaches any offset in O(1), so the cost is the 500 rows it builds; main walks to the offset first.',
  '500 rows x ~4 designations x 3 properties, at depth',
  'mixed', {'valueSet': VS('oh-deep-designations-properties', [{'system': SCT, 'filter': [F('concept', 'is-a', '404684003')]}]),
            'parameters': {'includeDesignations': True, 'property': ['parent', 'inactive', 'moduleId']}}, ['deep-jump', 'first-then-deep'], 500, 2500)
E('oh-deep-designations-properties-100k', 'Same at offset 100,000 (beyond tx.fhir.org\'s limit)', [SCT],
  'includeDesignations + properties at offset 100,000',
  'Fast on the engine (O(1) offset, 500 rows); tx.fhir.org refuses with 422.',
  '500 rows x ~4 designations x 3 properties at offset 100,000',
  'mixed', {'valueSet': VS('oh-deep-designations-properties-100k', [{'system': SCT, 'filter': [F('concept', 'is-a', '404684003')]}]),
            'parameters': {'includeDesignations': True, 'property': ['parent', 'inactive', 'moduleId']}}, ['deep-jump'], 500, 100000)
def L(id_, title, system, code, exercises, stresses, extra=None):
    params = {'system': system, 'code': code}
    if extra: params.update(extra)
    E(id_, title, [system], exercises, 'Fast: one concept, but every fact and designation is serialised.', stresses, 'fast',
      {'operation': 'lookup', 'parameters': params})
L('oh-lookup-sct-property-star', '$lookup 73211009 Diabetes mellitus with property=*', SCT, '73211009',
  '$lookup with property=* on a concept with many children and relationships', '1 concept: ~30 children, attributes, all designations',
  {'property': '*'})
L('oh-lookup-sct-default', '$lookup 22298006 with no property parameter (server default)', SCT, '22298006',
  '$lookup default property set and all designations', 'default properties + every designation')
L('oh-lookup-loinc-panel-star', '$lookup LOINC panel 24323-8 (CMP) with property=*', LOINC, '24323-8',
  '$lookup property=* on a panel: parts, panel members?, answer lists, all language designations', 'one panel, all parts and ~20 languages of names', {'property': '*'})
L('oh-lookup-rxnorm-sbd-star', '$lookup RxNorm SBD 209387 (Tylenol 325 mg tablet) with property=*', RX, '209387',
  '$lookup property=* on a branded drug', 'one SBD: TTY, STY, SAB, all relationships (tradename, consists_of, dose form, ...)',
  {'property': '*'})

# ---------------------------------------------------------------- known differences (written reasons)
by_id = {e['id']: e for e in entries}
def known(id_, aspects, kind, reason):
    for a in aspects: by_id[id_].setdefault('expectedDifferences', []).append({'aspect': a, 'kind': kind, 'reason': reason})
NO_PROPS = ('tx.fhir.org ignores the $expand property parameter and ValueSet.compose.property: no requested properties are returned '
            '(probed on /r4 and /r5, valueCode and valueString, 2026-11-01); it only adds a status property to non-active LOINC codes.')
for e in entries:
    r = e['request']
    if r['operation'] == 'expand' and ('property' in (r.get('parameters') or {}) or r.get('valueSet', {}).get('compose', {}).get('property')):
        known(e['id'], ['properties'], 'reference behaviour', NO_PROPS)
for i in ['oh-loinc-designations-all-languages-1000', 'oh-loinc-designations-weighted-languages']:
    known(i, ['designations'], 'reference data gap',
          'tx.fhir.org serves 12 LOINC languages (no zh-CN, it-IT, el-GR, ru-RU, es-ES, et-EE, pl-PL, tr-TR, fr-BE, fr-CA) and adds the Uzbek lang-pack supplement unasked; our LOINC 2.83 import has all 20 release languages.')
known('oh-loinc-designation-filter', ['designations'], 'reference behaviour',
      'with designation=nl-NL and designation=fr-FR tx.fhir.org returns no designations at all, although both languages exist for these codes.')
known('oh-sct-include-definition', ['definitions'], 'reference data gap',
      'tx.fhir.org returns no definitions with includeDefinition=true; SNOMED CT International 20250201 has 8,252 active text definitions, most of this subtree among them.')
known('oh-lookup-rxnorm-sbd-star', ['properties'], 'reference does not support',
      "main's RxNorm provider returns only inactive and notSelectable for $lookup property=*; TTY, STY, SAB and relationships are not exposed as properties.")

_inner = re.compile(r'\{\n\s*((?:"[^"\n]*": (?:"(?:[^"\\\n]|\\.)*"|[-\w.]+),?\n\s*){1,3})\}')
def compact(text):
    return _inner.sub(lambda m: '{' + ' '.join(x.strip() for x in m.group(1).strip().split('\n')) + '}', text)
for f in os.listdir(OUT):
    if f.startswith('oh-') and f.endswith('.json'): os.remove(os.path.join(OUT, f))
for e in entries:
    with open(os.path.join(OUT, e['id'] + '.json'), 'w') as fh:
        fh.write(compact(json.dumps(e, indent=2, ensure_ascii=False)) + '\n')
print(len(entries), 'output-heavy entries')
