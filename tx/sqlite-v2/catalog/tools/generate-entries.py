#!/usr/bin/env python3
# Generates tx/sqlite-v2/catalog/entries/*.json (replacing the files there).
#
#   python3 -I tools/generate-entries.py --raw DIR --uz FILE [--out DIR]
#
# --raw: a directory of extracted FHIR packages (<pkg>/package/ValueSet-*.json) containing
#        us.nlm.vsac-0.24.0, hl7.fhir.us.core-9.0.0 and hl7.fhir.uv.ips-2.0.1.
# --uz:  searchset Bundle holding https://terminology.dhp.uz/fhir/CodeSystem/loinc-supplement-uz
#        (CodeSystem?url=... from tx.fhir.org).
# Package content is only ever JSON-parsed.
import json, os, sys, copy, urllib.parse, argparse

HERE = os.path.dirname(os.path.abspath(__file__))
ap = argparse.ArgumentParser()
ap.add_argument('--raw', required=True)
ap.add_argument('--uz', required=True)
ap.add_argument('--out', default=os.path.join(HERE, '..', 'entries'))
A = ap.parse_args()
OUT, RAW, UZ = A.out, A.raw, A.uz
BNS = json.load(open(os.path.join(HERE, 'acetaminophen-bns.json')))['codes']

SCT = 'http://snomed.info/sct'; LOINC = 'http://loinc.org'; RX = 'http://www.nlm.nih.gov/research/umls/rxnorm'
INTL = 'http://snomed.info/sct/900000000000207008/version/20250201'
US = 'http://snomed.info/sct/731000124108/version/20250901'
ICD10CM = 'http://hl7.org/fhir/sid/icd-10-cm'
SQLITE = [SCT, LOINC, RX]
ALL_PATTERNS = ['first-page', 'pages-1-3', 'deep-jump', 'first-then-deep', 'last-with-total']
BIG = ['first-page', 'pages-1-3', 'first-then-deep', 'last-with-total']

entries = []

def F(prop, op, value): return {'property': prop, 'op': op, 'value': value}
def inc(system, *filters, version=None, concepts=None, valueSet=None):
    i = {}
    if system: i['system'] = system
    if version: i['version'] = version
    if concepts is not None: i['concept'] = [c if isinstance(c, dict) else {'code': c} for c in concepts]
    if filters: i['filter'] = list(filters)
    if valueSet: i['valueSet'] = valueSet
    return i
def ecl(text, version=None): return inc(SCT, F('constraint', '=', text), version=version)
def VS(id_, include, exclude=None, inactive=None, url=None, extension=None, name=None):
    v = {'resourceType': 'ValueSet'}
    if extension: v['extension'] = extension
    v['url'] = url or ('urn:fhirsmith:catalog:' + id_)
    v['status'] = 'active'
    c = {}
    if inactive is not None: c['inactive'] = inactive
    c['include'] = include
    if exclude: c['exclude'] = exclude
    v['compose'] = c
    return v

def systems_in(obj):
    s = set()
    def walk(o):
        if isinstance(o, dict):
            if 'system' in o and isinstance(o['system'], str) and o['system'].startswith(('http', 'urn')): s.add(o['system'])
            if o.get('resourceType') == 'CodeSystem' and o.get('supplements'): s.add(o['supplements'].split('|')[0])
            for v in o.values(): walk(v)
        elif isinstance(o, list):
            for v in o: walk(v)
    walk(obj)
    return sorted(s)

UNSET = object()
def E(id_, title, category, exercises, why, expect, request, patterns=None, count=UNSET, deep=None,
      order=False, source=None, notes=None, systems=None, engine_notes=None):
    r = {'operation': 'expand', **request} if 'operation' not in request else request
    sy = systems or systems_in({k: v for k, v in r.items() if k != 'parameters'} | {'p': {k: v for k, v in (r.get('parameters') or {}).items() if k == 'system'}})
    e = {'id': id_, 'title': title, 'category': category,
         'source': source or {'kind': 'constructed'},
         'exercises': exercises, 'why': why, 'expect': expect,
         'request': r}
    if r['operation'] == 'expand':
        e['patterns'] = patterns or ['first-page']
        e['paging'] = {'count': 50 if count is UNSET else count}
        if deep is not None: e['paging']['deepOffset'] = deep
    e['orderDefined'] = order
    e['systems'] = sy
    e['engine'] = {'sqlite': [s for s in sy if s in SQLITE], 'main': [s for s in sy if s not in SQLITE]}
    if engine_notes: e['engine']['notes'] = engine_notes
    if notes: e['notes'] = notes
    entries.append(e)

def X(id_, title, inc_, **kw):  # expand of a one-compose VS
    pass

# ---------------------------------------------------------------- hierarchy
E('sct-descendants-clinical-finding', 'All clinical findings (descendent-of 404684003)', 'hierarchy',
  'descendent-of over a 124k-member subtree; paging deep into it',
  'Fast: one stored descendants set; any page needs only rank/select on the bitmap, where main must walk 100k codes to reach a deep offset.',
  'fast', {'valueSet': VS('sct-descendants-clinical-finding', [inc(SCT, F('concept', 'descendent-of', '404684003'))])},
  ALL_PATTERNS, 50, 100000)
E('sct-isa-diabetes', 'Diabetes mellitus and its subtypes (is-a 73211009)', 'hierarchy',
  'small is-a including the anchor; whole set in one page',
  'Fast: descendants set plus the anchor, 124 codes.',
  'fast', {'valueSet': VS('sct-isa-diabetes', [inc(SCT, F('concept', 'is-a', '73211009'))])}, count=1000)
E('sct-child-of-diabetes', 'Direct children of diabetes mellitus (child-of)', 'hierarchy',
  'child-of: one level only, the inverse of the hierarchy property',
  'Fast: the prop set for (116680003 = 73211009), no closure involved.',
  'fast', {'valueSet': VS('sct-child-of-diabetes', [inc(SCT, F('concept', 'child-of', '73211009'))])}, count=1000)
E('sct-descendent-leaf-diabetes', 'Leaf descendants of diabetes mellitus (descendent-leaf)', 'hierarchy',
  'descendent-leaf = descendants AND leaf set',
  'Fast on the engine (one AND of two stored sets); main may not implement descendent-leaf for SNOMED, so the reference may be an error.',
  'fast', {'valueSet': VS('sct-descendent-leaf-diabetes', [inc(SCT, F('concept', 'descendent-leaf', '73211009'))])}, count=1000)
E('sct-generalizes-t2dm', 'Ancestors of type 2 diabetes (generalizes 44054006)', 'hierarchy',
  'generalizes: walk is-a links upward, the reverse direction of every other hierarchy filter',
  'Fast: at most ~30 hops up concept_link; no stored set answers it directly.',
  'fast', {'valueSet': VS('sct-generalizes-t2dm', [inc(SCT, F('concept', 'generalizes', '44054006'))])}, count=1000)
E('sct-isa-procedure', 'All procedures (is-a 71388002)', 'hierarchy',
  'second very large subtree (59k) with deep paging and last page',
  'Fast: one stored set; checks that offsets near the end and total agree with main.',
  'fast', {'valueSet': VS('sct-isa-procedure', [inc(SCT, F('concept', 'is-a', '71388002'))])},
  BIG + ['deep-jump'], 50, 40000)
E('loinc-isa-glucose-component', 'LOINC terms under the Glucose component part (is-a LP14635-4)', 'hierarchy',
  'LOINC component hierarchy from PATH_TO_ROOT (explicit pairs, not edge closure)',
  'Fast: stored descendants built from explicit pairs; tests that polyhierarchy extras are not served.',
  'fast', {'valueSet': VS('loinc-isa-glucose-component', [inc(LOINC, F('concept', 'is-a', 'LP14635-4'))])}, count=1000)
E('loinc-descendants-chem', 'All LOINC under CHEM class node (descendent-of LP7786-9)', 'hierarchy',
  'large LOINC hierarchy node (20k), paged',
  'Fast: stored set; main walks the LOINC closure table.',
  'fast', {'valueSet': VS('loinc-descendants-chem', [inc(LOINC, F('concept', 'descendent-of', 'LP7786-9'))])},
  ['first-page', 'first-then-deep', 'last-with-total'], 50, 15000)
E('sct-overlapping-includes', 'Overlapping includes: T1DM, T2DM subtrees plus enumerated codes', 'hierarchy',
  'union of overlapping includes; duplicates must collapse',
  'Fast: OR of two stored sets plus three ids; checks duplicate suppression and total.',
  'fast', {'valueSet': VS('sct-overlapping-includes', [inc(SCT, F('concept', 'is-a', '73211009')), inc(SCT, F('concept', 'is-a', '46635009')),
    inc(SCT, concepts=['44054006', '73211009', '38341003'])])}, count=1000)

# ---------------------------------------------------------------- exclusion / inactive
E('sct-findings-minus-disease-exclude', 'Clinical findings that are not diseases (compose.exclude)', 'exclusion-inactive',
  'include is-a 404684003, exclude is-a 64572001; large difference with deep paging',
  'Fast: AND-NOT of two stored sets; main must materialise both to subtract.',
  'fast', {'valueSet': VS('sct-findings-minus-disease-exclude', [inc(SCT, F('concept', 'is-a', '404684003'))],
    exclude=[inc(SCT, F('concept', 'is-a', '64572001'))])}, ALL_PATTERNS, 50, 30000)
E('sct-is-not-a', 'Clinical findings is-not-a disease (filter op is-not-a)', 'exclusion-inactive',
  'is-not-a as a filter inside one include',
  'Fast on the engine (same AND-NOT); main may not support is-not-a on SNOMED.',
  'fast', {'valueSet': VS('sct-is-not-a', [inc(SCT, F('concept', 'is-a', '404684003'), F('concept', 'is-not-a', '64572001'))])},
  ['first-page', 'last-with-total'], 50)
E('sct-not-in', 'Diabetes subtree except two enumerated codes (filter op not-in)', 'exclusion-inactive',
  'concept not-in list combined with is-a',
  'Fast: tiny AND-NOT; checks not-in support.',
  'fast', {'valueSet': VS('sct-not-in', [inc(SCT, F('concept', 'is-a', '73211009'), F('concept', 'not-in', '44054006,46635009'))])}, count=1000)
INACTIVE_LIST = ['15771004', '982001', '21858001', '24927004', '73211009', '44054006', '15777000']
E('sct-enumerated-with-inactive', 'Enumerated list mixing active and inactive codes (compose.inactive = true)', 'exclusion-inactive',
  'inactive codes kept when compose.inactive=true; inactive flag on contains',
  'Fast: direct id lookups; checks inactive marking and order.',
  'fast', {'valueSet': VS('sct-enumerated-with-inactive', [inc(SCT, concepts=INACTIVE_LIST)], inactive=True), 'recordDisplays': True}, count=1000, order=True)
E('sct-enumerated-activeonly', 'Same list with activeOnly=true', 'exclusion-inactive',
  'activeOnly parameter drops inactive enumerated codes',
  'Fast: AND with the active range.',
  'fast', {'valueSet': VS('sct-enumerated-activeonly', [inc(SCT, concepts=INACTIVE_LIST)], inactive=True), 'parameters': {'activeOnly': True}}, count=1000, order=True)
E('sct-inactive-filter-true', 'All inactive SNOMED concepts (filter inactive = true)', 'exclusion-inactive',
  'inactive filter over the whole system (148k), paged',
  'Fast: complement of the active range is itself a range.',
  'fast', {'valueSet': VS('sct-inactive-filter-true', [inc(SCT, F('inactive', '=', 'true'))])}, ['first-page', 'first-then-deep', 'last-with-total'], 50, 100000)
E('loinc-status-deprecated', 'Deprecated LOINC terms (STATUS = DEPRECATED)', 'exclusion-inactive',
  'LOINC status filter returning inactive codes',
  'Fast: literal prop set; checks whether deprecated codes are returned and flagged inactive.',
  'fast', {'valueSet': VS('loinc-status-deprecated', [inc(LOINC, F('STATUS', '=', 'DEPRECATED'))])}, ['first-page', 'last-with-total'], 50)
E('loinc-discouraged-activeonly', 'Discouraged LOINC terms with activeOnly=true', 'exclusion-inactive',
  'STATUS = DISCOURAGED combined with activeOnly',
  'Fast: AND with the active range; shows how DISCOURAGED counts for activeOnly.',
  'fast', {'valueSet': VS('loinc-discouraged-activeonly', [inc(LOINC, F('STATUS', '=', 'DISCOURAGED'))]), 'parameters': {'activeOnly': True}}, ['first-page', 'last-with-total'], 50)

# ---------------------------------------------------------------- properties & attributes
E('sct-attr-finding-site-eq', 'Concepts with finding site = pulmonary valve structure (property filter)', 'properties-attributes',
  'SNOMED attribute as a FHIR property filter (363698007 = 39057004)',
  'Fast: one prop set.',
  'fast', {'valueSet': VS('sct-attr-finding-site-eq', [inc(SCT, F('363698007', '=', '39057004'))])}, count=1000)
E('sct-ecl-attr-small-value', 'Findings with finding site << pulmonary valve (ECL refinement)', 'properties-attributes',
  'ECL attribute refinement with a small value hierarchy',
  'Fast: OR of ~28 prop sets AND descendants.',
  'fast', {'valueSet': VS('sct-ecl-attr-small-value', [ecl('< 404684003 |Clinical finding| : 363698007 |Finding site| = << 39057004 |Pulmonary valve structure|')])}, count=1000)
E('sct-ecl-attr-broad-morphology', 'Findings with any abnormal morphology (broad attribute value)', 'properties-attributes',
  'ECL refinement whose value hierarchy has thousands of members',
  'Slow-ish: OR over thousands of prop sets (spike: 30 ms); a per-attribute range set would fix it.',
  'slow', {'valueSet': VS('sct-ecl-attr-broad-morphology', [ecl('< 404684003 |Clinical finding| : 116676008 |Associated morphology| = << 49755003 |Morphologically abnormal structure|')])},
  ['first-page', 'first-then-deep', 'last-with-total'], 50, 50000)
E('sct-ecl-finding-site-any-body', 'Findings with a finding site anywhere in body structure', 'properties-attributes',
  'refinement whose value set is 42k body structures',
  'Slow: the known worst case (spike 232 ms): OR of 42k prop sets before the AND.',
  'slow', {'valueSet': VS('sct-ecl-finding-site-any-body', [ecl('< 404684003 |Clinical finding| : 363698007 |Finding site| = << 123037004 |Body structure|')])},
  ['first-page', 'first-then-deep', 'last-with-total'], 50, 60000)
E('sct-ecl-role-group', 'Heart disorders with infarct morphology in the same role group', 'properties-attributes',
  'ECL role group { site = << heart, morphology = << infarct }',
  'Mixed: sets narrow the candidates fast, then group_id checks on concept_link rows.',
  'mixed', {'valueSet': VS('sct-ecl-role-group', [ecl('< 404684003 |Clinical finding| : { 363698007 |Finding site| = << 80891009 |Heart structure|, 116676008 |Associated morphology| = << 55641003 |Infarct| }')])}, count=1000)
E('sct-ecl-dotted', 'Precise active ingredients of medicinal products (dotted attribute)', 'properties-attributes',
  'ECL dot notation: values of an attribute over a set',
  'Slow-ish: forward links from 24k products (spike 21 ms); no set gives attribute targets directly.',
  'slow', {'valueSet': VS('sct-ecl-dotted', [ecl('< 763158003 |Medicinal product| . 762949000 |Has precise active ingredient|')])}, ['first-page', 'last-with-total'], 50)
E('sct-ecl-reverse', 'Substances that are precise active ingredients of some product (reverse attribute)', 'properties-attributes',
  'ECL reverse flag R',
  'Slow-ish: same forward-link walk as dotted (spike 29 ms).',
  'slow', {'valueSet': VS('sct-ecl-reverse', [ecl('< 105590001 |Substance| : R 762949000 |Has precise active ingredient| = < 763158003 |Medicinal product|')])}, ['first-page', 'last-with-total'], 50)
E('sct-ecl-concrete-value', 'Products with presentation strength numerator 500 (concrete value)', 'properties-attributes',
  'ECL concrete domain = #500 on a decimal attribute',
  'Fast: one literal prop set (value 500).',
  'fast', {'valueSet': VS('sct-ecl-concrete-value', [ecl('< 763158003 |Medicinal product| : 1142135004 |Has presentation strength numerator value| = #500')])}, count=1000)
E('sct-ecl-concrete-range', 'Products with presentation strength numerator >= 1000 (concrete range)', 'properties-attributes',
  'ECL concrete comparison >= over decimal values',
  'Fast: key range scan of literal prop sets, then OR.',
  'fast', {'valueSet': VS('sct-ecl-concrete-range', [ecl('< 763158003 |Medicinal product| : 1142135004 |Has presentation strength numerator value| >= #1000')])}, count=1000)
E('sct-ecl-cardinality', 'Medicinal products with two or more precise active ingredients', 'properties-attributes',
  'ECL attribute cardinality [2..*]',
  'Mixed: needs per-concept counts of links, not a set lookup.',
  'mixed', {'valueSet': VS('sct-ecl-cardinality', [ecl('< 763158003 |Medicinal product| : [2..*] 762949000 |Has precise active ingredient| = *')])}, ['first-page', 'last-with-total'], 50)
E('sct-ecl-paracetamol-products', 'Medicinal products with precise ingredient paracetamol', 'properties-attributes',
  'the design-trace SNOMED half: descendants AND OR-of-prop-sets',
  'Fast: the trace query (spike 1.7 ms cold-ish).',
  'fast', {'valueSet': VS('sct-ecl-paracetamol-products', [ecl('< 763158003 |Medicinal product| : 762949000 |Has precise active ingredient| = << 387517004 |Paracetamol|')])}, count=1000)
E('loinc-component-glucose', 'LOINC terms whose COMPONENT is Glucose', 'properties-attributes',
  'LOINC part property filter (COMPONENT = LP14635-4)',
  'Fast: one prop set.',
  'fast', {'valueSet': VS('loinc-component-glucose', [inc(LOINC, F('COMPONENT', '=', 'LP14635-4'))])}, count=1000)
E('loinc-scale-quantitative', 'All quantitative LOINC terms (SCALE_TYP = Qn)', 'properties-attributes',
  'very common property value (44k), deep paging',
  'Fast: one stored prop set, deep offsets O(1).',
  'fast', {'valueSet': VS('loinc-scale-quantitative', [inc(LOINC, F('SCALE_TYP', '=', 'LP7753-9'))])}, ALL_PATTERNS, 50, 30000)
E('loinc-common-and-rare', 'Quantitative glucose terms (common AND rare property)', 'properties-attributes',
  'two filters in one include: 44k-member set AND 800-member set',
  'Fast: intersection driven by the small side.',
  'fast', {'valueSet': VS('loinc-common-and-rare', [inc(LOINC, F('SCALE_TYP', '=', 'LP7753-9'), F('COMPONENT', '=', 'LP14635-4'))])}, count=1000)
E('loinc-classtype-clinical', 'Clinical LOINC terms (CLASSTYPE = 2)', 'properties-attributes',
  'CLASSTYPE literal filter, 28k members',
  'Fast: literal prop set.',
  'fast', {'valueSet': VS('loinc-classtype-clinical', [inc(LOINC, F('CLASSTYPE', '=', '2'))])}, ['first-page', 'first-then-deep', 'last-with-total'], 50, 20000)
E('loinc-class-chem', 'LOINC CLASS = CHEM (class given by name)', 'properties-attributes',
  'CLASS filter with the class name rather than its part code',
  'Fast if the value maps to the part; records which value form tx.fhir.org accepts.',
  'fast', {'valueSet': VS('loinc-class-chem', [inc(LOINC, F('CLASS', '=', 'CHEM'))])}, ['first-page', 'last-with-total'], 50)
E('loinc-order-obs-order', 'LOINC terms orderable only (ORDER_OBS = Order)', 'properties-attributes',
  'ORDER_OBS literal property',
  'Fast: literal prop set.',
  'fast', {'valueSet': VS('loinc-order-obs-order', [inc(LOINC, F('ORDER_OBS', '=', 'Order'))])}, ['first-page', 'last-with-total'], 50)
E('loinc-answers-for-smoking', 'Answers for LOINC 72166-2 Tobacco smoking status (answers-for)', 'properties-attributes',
  'answers-for: term -> answer list -> answers',
  'Fast: refset(L) for the term\'s list.',
  'fast', {'valueSet': VS('loinc-answers-for-smoking', [inc(LOINC, F('answers-for', '=', '72166-2'))])}, count=1000, order=False)
E('loinc-list-route', 'Members of LOINC answer list LL696-6 (LIST filter)', 'properties-attributes',
  'LIST = answer list code',
  'Fast: stored refset kind for answer lists.',
  'fast', {'valueSet': VS('loinc-list-route', [inc(LOINC, F('LIST', '=', 'LL696-6'))])}, count=1000)
E('loinc-rad-modality-exists', 'LOINC terms that have a radiology modality type (exists)', 'properties-attributes',
  'property exists = true',
  'Fast: hasProp set.',
  'fast', {'valueSet': VS('loinc-rad-modality-exists', [inc(LOINC, F('rad-modality-modality-type', 'exists', 'true'))])}, ['first-page', 'last-with-total'], 50)
E('rxnorm-tty-scd', 'All RxNorm semantic clinical drugs (TTY = SCD)', 'properties-attributes',
  'RxNorm TTY filter, 40k members, deep paging',
  'Fast: literal prop set.',
  'fast', {'valueSet': VS('rxnorm-tty-scd', [inc(RX, F('TTY', '=', 'SCD'))])}, ALL_PATTERNS, 50, 30000)
E('rxnorm-tty-in', 'Branded drugs and packs (TTY in SBD,BPCK)', 'properties-attributes',
  'TTY in list',
  'Fast: OR of two prop sets.',
  'fast', {'valueSet': VS('rxnorm-tty-in', [inc(RX, F('TTY', 'in', 'SBD,BPCK'))])}, ['first-page', 'last-with-total'], 50)
E('rxnorm-sty-and-sab', 'RxNorm pharmacologic substances also present in CVX (STY = T121, SAB = CVX)', 'properties-attributes',
  'STY and SAB filters together',
  'Fast: AND of two literal prop sets.',
  'fast', {'valueSet': VS('rxnorm-sty-and-sab', [inc(RX, F('STY', '=', 'T121'), F('SAB', '=', 'CVX'))])}, count=1000)
E('rxnorm-acetaminophen-brands', 'Brand names of acetaminophen (TTY = BN, tradename_of = 161)', 'properties-attributes',
  'RxNorm relationship (RELA) filter in main\'s CUI: form',
  'Fast: one prop set; records the relationship direction main uses.',
  'fast', {'valueSet': VS('rxnorm-acetaminophen-brands', [inc(RX, F('TTY', '=', 'BN'), F('tradename_of', '=', 'CUI:161'))])}, count=1000)
E('rxnorm-rel-rn-acetaminophen', 'RxNorm concepts in REL=RN with acetaminophen', 'properties-attributes',
  'REL (coarse relationship) filter',
  'Fast: OR of the RELA sets under RN (cs_config.relaByRel).',
  'fast', {'valueSet': VS('rxnorm-rel-rn-acetaminophen', [inc(RX, F('RN', '=', 'CUI:161'))])}, ['first-page', 'last-with-total'], 50)
E('rxnorm-sbd-by-brand-in-list', 'SBDs whose ingredient is one of 80 acetaminophen brands (has_ingredient in list)', 'properties-attributes',
  'main-expressible form of a relation chain: 80 values in one in-filter',
  'Fast on the engine (OR of 80 small sets, 133 index rows in the spike); main issues per-value SQL.',
  'fast', {'valueSet': VS('rxnorm-sbd-by-brand-in-list', [inc(RX, F('TTY', '=', 'SBD'), F('has_ingredient', 'in', ','.join('CUI:' + b for b in BNS)))])}, count=1000)

# ---------------------------------------------------------------- refsets / implicit / ECL
E('sct-ecl-member-of-lateralizable', 'Lateralizable body structures (^ 723264001)', 'refsets-implicit-ecl',
  'ECL member-of a 21k simple refset, paged',
  'Fast: stored refset set.',
  'fast', {'valueSet': VS('sct-ecl-member-of-lateralizable', [ecl('^ 723264001 |Lateralizable body structure reference set|')])}, ['first-page', 'first-then-deep', 'last-with-total'], 50, 15000)
E('sct-ecl-member-and-isa', 'Lateralizable heart structures (^ refset AND << heart)', 'refsets-implicit-ecl',
  'ECL conjunction of member-of and descendant-or-self',
  'Fast: AND of two stored sets.',
  'fast', {'valueSet': VS('sct-ecl-member-and-isa', [ecl('^ 723264001 AND << 80891009 |Heart structure|')])}, count=1000)
E('sct-implicit-refset-icd10cm-map', 'US Edition implicit VS: members of the ICD-10-CM complex map refset', 'refsets-implicit-ecl',
  'canonical ?fhir_vs=refset/6011000124106 on the US edition (138k members), deep paging',
  'Fast: stored refset set; main enumerates refset members.',
  'fast', {'valueSetUrl': 'http://snomed.info/sct/731000124108?fhir_vs=refset/6011000124106'}, ALL_PATTERNS, 50, 100000,
  systems=[SCT])
E('sct-implicit-refset-lateralizable', 'Implicit VS ?fhir_vs=refset/723264001 (International simple refset)', 'refsets-implicit-ecl',
  'canonical implicit value set for a 21k-member simple refset, paged',
  'Fast: stored refset set; contrast with the US complex-map refset, which tx.fhir.org does not resolve.',
  'fast', {'valueSetUrl': 'http://snomed.info/sct?fhir_vs=refset/723264001'}, ['first-page', 'first-then-deep', 'last-with-total'], 50, 15000, systems=[SCT])
E('sct-implicit-isa', 'Implicit VS ?fhir_vs=isa/73211009', 'refsets-implicit-ecl',
  'implicit is-a value set by canonical URL',
  'Fast: same set as sct-isa-diabetes; checks implicit URL handling.',
  'fast', {'valueSetUrl': 'http://snomed.info/sct?fhir_vs=isa/73211009'}, count=1000, systems=[SCT])
E('sct-implicit-ecl', 'Implicit VS ?fhir_vs=ecl/ (<< 73211009 MINUS << 44054006)', 'refsets-implicit-ecl',
  'implicit ECL value set by canonical URL (url-encoded expression)',
  'Fast on the engine; main may not resolve ?fhir_vs=ecl/, so the reference may be an error.',
  'fast', {'valueSetUrl': 'http://snomed.info/sct?fhir_vs=ecl/' + urllib.parse.quote('<< 73211009 MINUS << 44054006', safe='')}, count=1000, systems=[SCT])
E('sct-implicit-refset-list', 'Implicit VS ?fhir_vs=refset (all reference sets)', 'refsets-implicit-ecl',
  'implicit value set of refset concepts',
  'Fast: refsets are known at import.',
  'fast', {'valueSetUrl': 'http://snomed.info/sct?fhir_vs=refset'}, count=1000, systems=[SCT])
E('sct-ecl-or', 'Diabetes OR hypertensive disorder (ECL OR)', 'refsets-implicit-ecl',
  'ECL disjunction',
  'Fast: OR of two stored sets.',
  'fast', {'valueSet': VS('sct-ecl-or', [ecl('<< 73211009 |Diabetes mellitus| OR << 38341003 |Hypertensive disorder|')])}, count=1000)
E('sct-ecl-minus', 'Clinical findings MINUS diseases (ECL MINUS)', 'refsets-implicit-ecl',
  'ECL MINUS over two big sets; deep paging',
  'Fast: AND-NOT, same answer as the compose.exclude form.',
  'fast', {'valueSet': VS('sct-ecl-minus', [ecl('<< 404684003 |Clinical finding| MINUS << 64572001 |Disease|')])}, ['first-page', 'first-then-deep', 'last-with-total'], 50, 30000)
E('sct-ecl-nested-viral-infections', 'Infectious diseases caused by viruses other than influenza A (nested ECL)', 'refsets-implicit-ecl',
  'refinement whose value is a nested MINUS expression',
  'Fast: OR of prop sets over a set difference.',
  'fast', {'valueSet': VS('sct-ecl-nested-viral-infections', [ecl('<< 40733004 |Infectious disease| : 246075003 |Causative agent| = (<< 49872002 |Virus| MINUS << 407479009 |Influenza A virus|)')])},
  ['first-page', 'last-with-total'], 50)
E('sct-ecl-ancestors-and-parents', 'Ancestors of T2DM that are also parents of T1DM (>> AND >!)', 'refsets-implicit-ecl',
  'ECL ancestorOrSelf and parentOf combined',
  'Fast: two short upward walks.',
  'fast', {'valueSet': VS('sct-ecl-ancestors-and-parents', [ecl('>> 44054006 |Type 2 diabetes mellitus| AND >! 46635009 |Type 1 diabetes mellitus|')])}, count=1000)
E('sct-ecl-description-filter', 'Clinical findings with term "heart attack" (ECL 2 description filter)', 'refsets-implicit-ecl',
  'ECL {{ term = "..." }} description filter',
  'Mixed: FTS on designations then AND with descendants; main may not support description filters.',
  'mixed', {'valueSet': VS('sct-ecl-description-filter', [ecl('< 404684003 |Clinical finding| {{ term = "heart attack" }}')])}, count=1000)
E('loinc-implicit-answer-list', 'LOINC implicit VS http://loinc.org/vs/LL150-4 (place of death)', 'refsets-implicit-ecl',
  'LOINC answer-list implicit value set by canonical',
  'Fast: stored answer-list set; answer order is defined by the list.',
  'fast', {'valueSetUrl': 'http://loinc.org/vs/LL150-4'}, count=1000, systems=[LOINC])
E('loinc-implicit-part-vs', 'LOINC implicit VS for a part (http://loinc.org/vs/LP14635-4)', 'refsets-implicit-ecl',
  'LOINC implicit part value set',
  'Fast: descendants of the part.',
  'fast', {'valueSetUrl': 'http://loinc.org/vs/LP14635-4'}, count=1000, systems=[LOINC])

# ---------------------------------------------------------------- text
E('sct-regex-display-tumour', 'SNOMED displays matching .*[Tt]umou?r.* (regex)', 'text',
  'display regex over the whole system',
  'Slow: no index serves a regex; a full scan of 520k displays (spike 212 ms).',
  'slow', {'valueSet': VS('sct-regex-display-tumour', [inc(SCT, F('display', 'regex', '.*[Tt]umou?r.*'))])}, ['first-page', 'last-with-total'], 50)
E('sct-regex-within-isa', 'Diseases whose display ends in -itis (is-a AND regex)', 'text',
  'regex restricted by a hierarchy filter',
  'Slow-ish: the regex runs over 88k candidate displays.',
  'slow', {'valueSet': VS('sct-regex-within-isa', [inc(SCT, F('concept', 'is-a', '64572001'), F('display', 'regex', '.*itis'))])}, ['first-page', 'last-with-total'], 50)
E('sct-regex-display-common', 'SNOMED displays containing "e" (regex matching 90%)', 'text',
  'regex that matches almost everything; deep paging',
  'Slow: full scan, and the result is too big to cache cheaply.',
  'slow', {'valueSet': VS('sct-regex-display-common', [inc(SCT, F('display', 'regex', '.*e.*'))])}, ['first-page', 'first-then-deep', 'last-with-total'], 50, 300000)
E('sct-text-filter-heart-attack', 'Clinical findings + $expand filter "heart attack"', 'text',
  '$expand filter parameter (text search) over a large set',
  'Mixed: FTS on designations then AND; match semantics differ between servers.',
  'mixed', {'valueSet': VS('sct-text-filter-heart-attack', [inc(SCT, F('concept', 'is-a', '404684003'))]), 'parameters': {'filter': 'heart attack'}}, count=1000)
E('loinc-text-filter-glucose', 'All LOINC + filter "glucose serum"', 'text',
  '$expand filter over a whole code system',
  'Mixed: trigram FTS; ranking/order is server-specific.',
  'mixed', {'valueSet': VS('loinc-text-filter-glucose', [inc(LOINC)]), 'parameters': {'filter': 'glucose serum'}}, ['first-page', 'last-with-total'], 50)
E('rxnorm-text-filter-acetaminophen', 'SCDs + filter "acetaminophen 325"', 'text',
  '$expand filter on an RxNorm property-filtered set',
  'Mixed: FTS AND prop set.',
  'mixed', {'valueSet': VS('rxnorm-text-filter-acetaminophen', [inc(RX, F('TTY', '=', 'SCD'))]), 'parameters': {'filter': 'acetaminophen 325'}}, count=1000)
E('loinc-component-regex', 'LOINC terms whose COMPONENT matches ^Glucose (property regex)', 'text',
  'regex on a concept-valued property (matches against part codes or names?)',
  'Slow-ish: scans the COMPONENT prop keys; records what the regex is applied to.',
  'slow', {'valueSet': VS('loinc-component-regex', [inc(LOINC, F('COMPONENT', 'regex', 'Glucose.*'))])}, ['first-page', 'last-with-total'], 50)

# ---------------------------------------------------------------- enumerated / nested
ORDERED_SCT = ['38341003', '73211009', '195967001', '13645005', '84114007', '22298006', '49436004', '44054006', '46635009', '40930008',
               '35489007', '197480006', '230690007', '399211009', '59621000', '26929004', '69896004', '396275006', '414916001', '271737000']
E('sct-enumerated-ordered', '20 common SNOMED problems in a deliberate non-hierarchical order', 'enumerated-nested',
  'enumerated concept list; order must be preserved',
  'Fast: id lookups; checks order is the compose order, not id order.',
  'fast', {'valueSet': VS('sct-enumerated-ordered', [inc(SCT, concepts=ORDERED_SCT)])}, count=1000, order=True)
ORDERED_LOINC = ['8480-6', '8462-4', '8867-4', '9279-1', '8310-5', '29463-7', '8302-2', '39156-5', '2708-6', '59408-5', '2345-7', '4548-4', '718-7', '2160-0', '2093-3']
E('loinc-enumerated-ordered', 'Vital signs + common labs as an ordered LOINC list', 'enumerated-nested',
  'enumerated LOINC list with order',
  'Fast; checks order and displays.',
  'fast', {'valueSet': VS('loinc-enumerated-ordered', [inc(LOINC, concepts=ORDERED_LOINC)])}, count=1000, order=True)
H_DM = VS('helper-diabetes', [inc(SCT, F('concept', 'is-a', '73211009'))], url='urn:fhirsmith:catalog:helper:diabetes')
H_HTN = VS('helper-htn', [inc(SCT, F('concept', 'is-a', '38341003'))], url='urn:fhirsmith:catalog:helper:hypertension')
H_RENAL = VS('helper-renal', [ecl('<< 90708001 |Kidney disease|')], url='urn:fhirsmith:catalog:helper:kidney-disease')
H_DM_COMPLICATION = VS('helper-dm-comp', [ecl('<< 74627003 |Diabetic complication|')], url='urn:fhirsmith:catalog:helper:diabetic-complication')
E('nested-union-tx-resource', 'Union of two helper value sets (include.valueSet, tx-resource)', 'enumerated-nested',
  'two includes each importing a tx-resource ValueSet',
  'Fast: OR of the two imported sets.',
  'fast', {'valueSet': VS('nested-union-tx-resource', [inc(None, valueSet=[H_DM['url']]), inc(None, valueSet=[H_HTN['url']])]), 'txResources': [H_DM, H_HTN]}, count=1000)
E('nested-intersection-two-vs', 'Intersection: kidney disease AND diabetic complication (one include, two valueSets)', 'enumerated-nested',
  'include.valueSet with two entries = intersection',
  'Fast: AND of the imported sets.',
  'fast', {'valueSet': VS('nested-intersection-two-vs', [inc(None, valueSet=[H_RENAL['url'], H_DM_COMPLICATION['url']])]), 'txResources': [H_RENAL, H_DM_COMPLICATION]}, count=1000)
E('nested-filter-intersect-vs', 'Diabetes subtree restricted to kidney disease (system filter + valueSet in one include)', 'enumerated-nested',
  'include with both a filter and a valueSet (passesImports)',
  'Fast: AND of filter set and import.',
  'fast', {'valueSet': VS('nested-filter-intersect-vs', [inc(SCT, F('concept', 'is-a', '73211009'), valueSet=[H_RENAL['url']])]), 'txResources': [H_RENAL]}, count=1000)
E('nested-difference-exclude-vs', 'Diabetes minus diabetic complications (exclude.valueSet)', 'enumerated-nested',
  'exclude by value set import',
  'Fast: AND-NOT.',
  'fast', {'valueSet': VS('nested-difference-exclude-vs', [inc(SCT, F('concept', 'is-a', '73211009'))], exclude=[inc(None, valueSet=[H_DM_COMPLICATION['url']])]), 'txResources': [H_DM_COMPLICATION]}, count=1000)
H_L1 = VS('l1', [inc(None, valueSet=[H_DM['url']]), inc(SCT, concepts=['38341003'])], url='urn:fhirsmith:catalog:helper:level1')
H_L2 = VS('l2', [inc(None, valueSet=[H_L1['url']]), inc(LOINC, concepts=['4548-4', '2345-7'])], url='urn:fhirsmith:catalog:helper:level2')
E('nested-three-levels', 'Three-level import chain across SNOMED and LOINC', 'enumerated-nested',
  'VS imports VS imports VS (tx-resource), mixed systems at each level',
  'Fast: recursive import resolution; checks that cached import sets are reused.',
  'fast', {'valueSet': VS('nested-three-levels', [inc(None, valueSet=[H_L2['url']]), inc(RX, concepts=['860975'])]), 'txResources': [H_DM, H_L1, H_L2]}, count=1000)
E('enumerated-filter-exclude-mix', 'Enumerated + filter include with an enumerated exclude', 'enumerated-nested',
  'enumerated concepts, a filter, and an enumerated exclude in one compose',
  'Fast; checks exclusion applies to both include kinds.',
  'fast', {'valueSet': VS('enumerated-filter-exclude-mix', [inc(SCT, concepts=['38341003', '22298006']), inc(SCT, F('concept', 'is-a', '46635009'))],
    exclude=[inc(SCT, concepts=['22298006', '46635009'])])}, count=1000)
E('rxnorm-trace-helper-includes', 'Paracetamol trace (main form): SNOMED ECL + 80 RxNorm includes via helper VS', 'enumerated-nested',
  'the design-trace query as main can express it: helper VS with one include per brand',
  'Fast on the engine (spike 3.9 ms); main runs 80 SQL filters.',
  'fast', {'valueSet': VS('rxnorm-trace-helper-includes', [ecl('< 763158003 |Medicinal product| : 762949000 |Has precise active ingredient| = << 387517004 |Paracetamol|'),
    inc(None, valueSet=['urn:fhirsmith:catalog:helper:sbd-by-bn'])], inactive=False),
    'txResources': [VS('h', [inc(RX, F('TTY', '=', 'SBD'), F('has_ingredient', '=', 'CUI:' + b)) for b in BNS], url='urn:fhirsmith:catalog:helper:sbd-by-bn')]},
  ['first-page', 'pages-1-3', 'last-with-total'], 50)

# ---------------------------------------------------------------- multi-system & versions
E('multi-sct-loinc-rxnorm', 'Diabetes care: SNOMED conditions, LOINC labs, RxNorm drugs', 'multi-system-versions',
  'three SQLite-backed systems in one compose',
  'Fast: per-system sets concatenated; checks system order in the expansion.',
  'fast', {'valueSet': VS('multi-sct-loinc-rxnorm', [inc(SCT, F('concept', 'is-a', '73211009')), inc(LOINC, F('COMPONENT', '=', 'LP14635-4'), F('SCALE_TYP', '=', 'LP7753-9')),
    inc(RX, F('TTY', '=', 'SCD'), F('has_ingredient', '=', 'CUI:6809'))])}, ['first-page', 'pages-1-3', 'last-with-total'], 100)
E('sct-two-versions-doingversion', 'Diabetes subtree in both Intl 20250201 and US 20250901 (doingVersion)', 'multi-system-versions',
  'same system at two versions in one compose: keys become system|version#code',
  'Fast: two per-version sets, total = sum; checks version on every contains.',
  'fast', {'valueSet': VS('sct-two-versions-doingversion', [inc(SCT, F('concept', 'is-a', '73211009'), version=INTL), inc(SCT, F('concept', 'is-a', '73211009'), version=US)])}, count=1000)
E('sct-us-minus-intl-diabetes', 'Diabetes concepts new in the US Edition (include US, exclude Intl, versionsMatch)', 'multi-system-versions',
  'version-diff value set: exclude matches by code across versions',
  'Fast: AND-NOT after translating Intl ids to US ids by code.',
  'fast', {'valueSet': VS('sct-us-minus-intl-diabetes', [inc(SCT, F('concept', 'is-a', '73211009'), version=US)], exclude=[inc(SCT, F('concept', 'is-a', '73211009'), version=INTL)])}, count=1000)
E('sct-us-minus-intl-whole', 'All concepts new in the US Edition (whole US minus whole Intl)', 'multi-system-versions',
  'version diff of two whole systems (530k vs 520k)',
  'Mixed: the engine translates 520k codes once; main must materialise both systems (likely too costly).',
  'mixed', {'valueSet': VS('sct-us-minus-intl-whole', [inc(SCT, version=US)], exclude=[inc(SCT, version=INTL)])}, ['first-page', 'last-with-total'], 50)
E('sct-us-only-code-in-intl', 'US-only code enumerated against the Intl version', 'multi-system-versions',
  'edition-specific code (721111000124107) requested in an edition that lacks it',
  'Fast; records how the server reports an unknown code in an enumerated include.',
  'fast', {'valueSet': VS('sct-us-only-code-in-intl', [inc(SCT, concepts=['721111000124107', '46635009'], version=INTL)])}, count=1000)
E('sct-us-edition-isa-t1dm', 'Type 1 diabetes subtree in the US Edition (includes US-only stages)', 'multi-system-versions',
  'is-a on the US edition by explicit version',
  'Fast: US file\'s stored set.',
  'fast', {'valueSet': VS('sct-us-edition-isa-t1dm', [inc(SCT, F('concept', 'is-a', '46635009'), version=US)])}, count=1000)
E('sct-system-version-param', 'Diabetes subtree with system-version=US (no version in compose)', 'multi-system-versions',
  'system-version parameter selecting the edition',
  'Fast; checks used-codesystem reports US.',
  'fast', {'valueSet': VS('sct-system-version-param', [inc(SCT, F('concept', 'is-a', '46635009'))]), 'parameters': {'system-version': SCT + '|' + US}}, count=1000)

# ---------------------------------------------------------------- mixed providers
E('mixed-sct-admin-gender', 'SNOMED sex findings + FHIR administrative-gender', 'mixed-providers',
  'SNOMED enumerated + a FHIR core CodeSystem resource (whole system)',
  'Fast; main\'s CodeSystem-resource provider must give identical results either way.',
  'fast', {'valueSet': VS('mixed-sct-admin-gender', [inc(SCT, concepts=['248153007', '248152002']), inc('http://hl7.org/fhir/administrative-gender')])}, count=1000)
E('mixed-loinc-ucum', 'LOINC glucose terms + UCUM units (grammar-based system)', 'mixed-providers',
  'LOINC filter + enumerated UCUM codes (UCUM is a grammar, no full expansion)',
  'Fast; UCUM validates each enumerated unit.',
  'fast', {'valueSet': VS('mixed-loinc-ucum', [inc(LOINC, F('COMPONENT', '=', 'LP14635-4'), F('SCALE_TYP', '=', 'LP7753-9')), inc('http://unitsofmeasure.org', concepts=['mg/dL', 'mmol/L', '%', 'g/L'])])}, count=1000)
E('mixed-sct-icd10cm', 'Diabetes in SNOMED and ICD-10-CM (E11 hierarchy)', 'mixed-providers',
  'SNOMED is-a + ICD-10-CM is-a (ICD-10-CM served as a CodeSystem resource from fhir.tx.support)',
  'Fast on the SNOMED half; ICD-10-CM goes through main.',
  'fast', {'valueSet': VS('mixed-sct-icd10cm', [inc(SCT, F('concept', 'is-a', '44054006')), inc(ICD10CM, F('concept', 'is-a', 'E11'))])}, count=1000)
E('mixed-loinc-answers-nullflavor', 'LOINC smoking answers + v3 NullFlavor', 'mixed-providers',
  'LOINC answer list + THO CodeSystem enumerated',
  'Fast.',
  'fast', {'valueSet': VS('mixed-loinc-answers-nullflavor', [inc(LOINC, F('answers-for', '=', '72166-2')), inc('http://terminology.hl7.org/CodeSystem/v3-NullFlavor', concepts=['UNK', 'ASKU', 'NI'])])}, count=1000)
E('mixed-rxnorm-ndc', 'Acetaminophen 325 mg tablet in RxNorm and NDC', 'mixed-providers',
  'RxNorm enumerated + NDC enumerated (package and product codes, plus one malformed code)',
  'Fast.',
  'fast', {'valueSet': VS('mixed-rxnorm-ndc', [inc(RX, concepts=['313782', '209387']), inc('http://hl7.org/fhir/sid/ndc', concepts=['0781-1852-20', '0781-1852', '0000-0000-00'])])}, count=1000)
E('mixed-sct-country-lang', 'SNOMED nationality findings + ISO 3166 countries + BCP-47 languages', 'mixed-providers',
  'internal providers (country, lang) next to SNOMED',
  'Fast; BCP-47 is a grammar, so only enumerated codes.',
  'fast', {'valueSet': VS('mixed-sct-country-lang', [inc(SCT, concepts=['186034007']), inc('urn:iso:std:iso:3166', concepts=['US', 'NL', 'UZ']), inc('urn:ietf:bcp:47', concepts=['en-US', 'nl-NL', 'uz'])])}, count=1000)
E('mixed-cdcrec-sct', 'CDC race codes + SNOMED ethnic group subtree', 'mixed-providers',
  'CDCREC CodeSystem resource (hierarchical) + SNOMED is-a',
  'Fast.',
  'fast', {'valueSet': VS('mixed-cdcrec-sct', [inc('urn:oid:2.16.840.1.113883.6.238', F('concept', 'is-a', '1000-9')), inc(SCT, F('concept', 'is-a', '372148003'))])}, count=1000)
E('mixed-actcode-loinc', 'v3 ActCode encounter codes + LOINC visit note types', 'mixed-providers',
  'THO v3 CodeSystem with is-a filter + LOINC property filters',
  'Fast.',
  'fast', {'valueSet': VS('mixed-actcode-loinc', [inc('http://terminology.hl7.org/CodeSystem/v3-ActCode', F('concept', 'is-a', '_ActEncounterCode')), inc(LOINC, concepts=['11506-3', '18842-5', '34117-2'])])}, count=1000)
CUSTOM_CS = {'resourceType': 'CodeSystem', 'url': 'urn:fhirsmith:catalog:cs:clinic-flags', 'version': '1', 'status': 'active', 'content': 'complete',
             'hierarchyMeaning': 'is-a',
             'concept': [{'code': 'risk', 'display': 'Risk flags', 'concept': [{'code': 'falls', 'display': 'Falls risk'}, {'code': 'bleed', 'display': 'Bleeding risk'}]}, {'code': 'admin', 'display': 'Administrative'}]}
E('mixed-txresource-codesystem-sct', 'Request-supplied CodeSystem (tx-resource) + SNOMED', 'mixed-providers',
  'a complete CodeSystem passed as tx-resource, is-a filter on it, next to SNOMED',
  'Fast; the request CodeSystem lives in main\'s FHIR CodeSystem provider (or an in-memory layer).',
  'fast', {'valueSet': VS('mixed-txresource-codesystem-sct', [inc(CUSTOM_CS['url'], F('concept', 'is-a', 'risk')), inc(SCT, concepts=['129839007'])]), 'txResources': [CUSTOM_CS]}, count=1000)

# ---------------------------------------------------------------- limits & paging
E('sct-whole-system-deep', 'All of SNOMED (whole system) with deep paging', 'limits-paging',
  'whole-system include; offsets far beyond main\'s cap',
  'Fast on the engine (all/active range); main stops at its cap or returns too-costly.',
  'fast', {'valueSet': VS('sct-whole-system-deep', [inc(SCT)])}, ALL_PATTERNS, 50, 400000)
E('rxnorm-whole-system', 'All of RxNorm (whole system)', 'limits-paging',
  'whole RxNorm, first page and last page',
  'Fast on the engine.',
  'fast', {'valueSet': VS('rxnorm-whole-system', [inc(RX)])}, ['first-page', 'first-then-deep', 'last-with-total'], 50, 200000)
E('sct-large-no-count', 'Clinical findings without count (default paging)', 'limits-paging',
  'no count parameter: server default limit / 1,000-code cap / too-costly',
  'Fast to compute; records how main limits an unpaged large expansion.',
  'fast', {'valueSet': VS('sct-large-no-count', [inc(SCT, F('concept', 'is-a', '404684003'))])}, ['first-page'], None)
E('loinc-whole-system-last-page', 'All of LOINC: last page with total', 'limits-paging',
  'whole LOINC including parts and answers; last page needs the total',
  'Fast on the engine; main needs the total first.',
  'fast', {'valueSet': VS('loinc-whole-system-last-page', [inc(LOINC)])}, ['first-page', 'last-with-total', 'deep-jump'], 50, 200000)
E('sct-union-findings-procedures-deep', 'Clinical findings OR procedures, deep offset 150000', 'limits-paging',
  'union of two large sets, offset in the second half',
  'Fast: OR of two stored sets; main must materialise 150k codes.',
  'fast', {'valueSet': VS('sct-union-findings-procedures-deep', [inc(SCT, F('concept', 'is-a', '404684003')), inc(SCT, F('concept', 'is-a', '71388002'))])}, ['first-page', 'deep-jump', 'last-with-total'], 50, 150000)
E('sct-count-zero-total', 'Clinical findings with count=0 (total only)', 'limits-paging',
  'count=0: total without contains',
  'Fast: card of a stored set.',
  'fast', {'valueSet': VS('sct-count-zero-total', [inc(SCT, F('concept', 'is-a', '404684003'))])}, ['first-page'], 0)

# ---------------------------------------------------------------- validate / lookup / subsumes
def V(id_, title, vsreq, system, code, display=None, why='Fast: one has() on the value set bitmap.', exercises=None, expect='fast', extra=None, version=None):
    params = {'system': system, 'code': code}
    if version: params['version'] = version
    if display: params['display'] = display
    if extra: params.update(extra)
    E(id_, title, 'validate-lookup-subsumes', exercises or ('$validate-code ' + system.split('/')[-1] + '|' + code + ' against ' + title), why, expect,
      {'operation': 'validate-code', **vsreq, 'parameters': params})
VS_DM = VS('sct-isa-diabetes', [inc(SCT, F('concept', 'is-a', '73211009'))])
V('validate-sct-member', 'T2DM in diabetes is-a value set (member)', {'valueSet': VS_DM}, SCT, '44054006', 'Type 2 diabetes mellitus', exercises='membership true with correct display')
V('validate-sct-not-member', 'Hypertension in diabetes value set (not a member)', {'valueSet': VS_DM}, SCT, '38341003', exercises='membership false')
V('validate-sct-wrong-display', 'T2DM with a wrong display', {'valueSet': VS_DM}, SCT, '44054006', 'Diabetes type II wrong', exercises='display mismatch issue')
V('validate-sct-inactive-activeonly', 'Inactive code 15771004 with activeOnly', {'valueSet': VS('v-inact', [inc(SCT, concepts=INACTIVE_LIST)], inactive=True)}, SCT, '15771004', extra={'activeOnly': True}, exercises='inactive code rejected when activeOnly')
V('validate-sct-ecl-attr', 'Myocardial infarction in finding-site-of-heart ECL set', {'valueSet': VS('v-ecl', [ecl('< 404684003 : 363698007 = << 80891009 |Heart structure|')])}, SCT, '22298006',
  why='Fast: membership in an ECL refinement; main must evaluate the whole ECL.', exercises='membership in a refinement ECL value set')
V('validate-loinc-classtype', '2345-7 in CLASSTYPE=1 laboratory set', {'valueSet': VS('v-lab', [inc(LOINC, F('CLASSTYPE', '=', '1'))])}, LOINC, '2345-7', 'Glucose [Mass/volume] in Serum or Plasma')
V('validate-rxnorm-scd', 'acetaminophen 325 mg tablet in TTY=SCD', {'valueSet': VS('v-scd', [inc(RX, F('TTY', '=', 'SCD'))])}, RX, '313782')
V('validate-mixed-gender', 'administrative-gender female in the mixed SNOMED+gender set', {'valueSet': VS('v-mixed', [inc(SCT, concepts=['248153007', '248152002']), inc('http://hl7.org/fhir/administrative-gender')])},
  'http://hl7.org/fhir/administrative-gender', 'female', why='Fast; the non-SNOMED half must be answered by main\'s provider.')
V('validate-us-code-in-intl', 'US-only code against the Intl diabetes set', {'valueSet': VS('v-us', [inc(SCT, F('concept', 'is-a', '46635009'), version=INTL)])}, SCT, '721111000124107',
  exercises='edition-specific code not in the requested edition')
V('validate-us-code-in-us', 'US-only code against the US diabetes set', {'valueSet': VS('v-us2', [inc(SCT, F('concept', 'is-a', '46635009'), version=US)])}, SCT, '721111000124107', version=US,
  exercises='edition-specific code in its edition')
V('validate-implicit-refset', 'Code in the US ICD-10-CM map refset implicit VS', {'valueSetUrl': 'http://snomed.info/sct/731000124108?fhir_vs=refset/6011000124106'}, SCT, '44054006', version=US)
V('validate-codesystem-only', 'SNOMED code validated against the code system (no value set)', {}, SCT, '22298006', 'Myocardial infarction', exercises='CodeSystem/$validate-code')
def L(id_, title, params, why, exercises):
    E(id_, title, 'validate-lookup-subsumes', exercises, why, 'fast', {'operation': 'lookup', 'parameters': params})
L('lookup-sct-mi', '$lookup SNOMED 22298006 with properties', {'system': SCT, 'code': '22298006', 'property': ['parent', 'child', 'inactive', '363698007']},
  'Fast: row reads; child is answered from an inverse prop set.', 'lookup with parent/child/attribute properties')
L('lookup-loinc-glucose', '$lookup LOINC 2345-7 with parts', {'system': LOINC, 'code': '2345-7', 'property': ['COMPONENT', 'SCALE_TYP', 'CLASS', 'STATUS']},
  'Fast: row reads.', 'lookup with LOINC part properties')
L('lookup-rxnorm-161', '$lookup RxNorm 161 acetaminophen', {'system': RX, 'code': '161'}, 'Fast: row reads.', 'lookup of an RxNorm ingredient')
def S(id_, title, system, a, b, version=None):
    params = {'system': system, 'codeA': a, 'codeB': b}
    if version: params['version'] = version
    E(id_, title, 'validate-lookup-subsumes', '$subsumes ' + a + ' vs ' + b, 'Fast: one has() on a descendants set.', 'fast', {'operation': 'subsumes', 'parameters': params})
S('subsumes-sct-dm-t2dm', 'Diabetes subsumes T2DM', SCT, '73211009', '44054006')
S('subsumes-sct-not', 'Diabetes vs hypertension (not subsumed)', SCT, '73211009', '38341003')
S('subsumes-loinc-part-term', 'LOINC part Glucose vs term 2345-7', LOINC, 'LP14635-4', '2345-7')

# ---------------------------------------------------------------- languages & supplements
LANG_LIST = ['2345-7', '2339-0', '718-7', '4548-4', '2160-0', '2093-3', '6690-2', '789-8', '777-3', '8480-6']
VS_LANG = VS('loinc-lang-list', [inc(LOINC, concepts=LANG_LIST)])
UZ_URL = 'https://terminology.dhp.uz/fhir/CodeSystem/loinc-supplement-uz'
def LS(id_, title, exercises, why, expect, req, **kw):
    E(id_, title, 'languages-supplements', exercises, why, expect, req, **kw)
LS('loinc-display-language-nl', 'LOINC glucose terms with displayLanguage=nl-NL', 'displayLanguage picks the nl-NL release translation',
  'Fast: designation rows for the page only.', 'fast', {'valueSet': VS('loinc-display-language-nl', [inc(LOINC, F('COMPONENT', '=', 'LP14635-4'), F('SCALE_TYP', '=', 'LP7753-9'))]), 'parameters': {'displayLanguage': 'nl-NL'}}, count=100)
LS('loinc-display-language-zh-designations', 'LOINC list with displayLanguage=zh-CN and includeDesignations', 'zh-CN display plus all designations',
  'Fast: page rows only, but many designations per code.', 'fast', {'valueSet': VS_LANG, 'parameters': {'displayLanguage': 'zh-CN', 'includeDesignations': True}}, count=1000, order=True)
LS('loinc-designation-param-de', 'LOINC list with includeDesignations restricted to de-DE (designation param)', 'designation parameter restricts which designations are returned',
  'Fast.', 'fast', {'valueSet': VS_LANG, 'parameters': {'includeDesignations': True, 'designation': 'de-DE'}}, count=1000, order=True)
LS('loinc-text-filter-german', 'LOINC glucose terms filtered by German text "Glukose" (displayLanguage de-DE)', 'text search in a non-English language',
  'Mixed: FTS over designations, not just English displays; servers may only search displays.', 'mixed',
  {'valueSet': VS('loinc-text-filter-german', [inc(LOINC, F('COMPONENT', '=', 'LP14635-4'))]), 'parameters': {'filter': 'Glukose', 'displayLanguage': 'de-DE'}}, count=1000)
LS('validate-loinc-dutch-display', '$validate-code 2345-7 with the Dutch display', 'validate a translated display with displayLanguage nl-NL',
  'Fast: designation lookup for one code.', 'fast',
  {'operation': 'validate-code', 'valueSet': VS_LANG, 'parameters': {'system': LOINC, 'code': '2345-7', 'display': 'glucose in serum of plasma', 'displayLanguage': 'nl-NL'}})
LS('sct-display-language-unavailable', 'SNOMED Intl expansion with displayLanguage=de (no German in Intl)', 'requested language that the edition lacks',
  'Fast; records fallback behaviour (English display or warning).', 'fast',
  {'valueSet': VS('sct-display-language-unavailable', [inc(SCT, F('concept', 'is-a', '46635009'))]), 'parameters': {'displayLanguage': 'de'}}, count=1000)

# Uzbek supplement: server-known and per request
uz = json.load(open(UZ))['entry'][0]['resource']
uz_by = {c['code']: c for c in uz['concept']}
SUPP_EXT = 'http://hl7.org/fhir/StructureDefinition/valueset-supplement'
LS('uz-supplement-usesupplement-display', 'LOINC list in Uzbek via server-known supplement (useSupplement)', 'server-known lang-pack supplement selected by useSupplement, displayLanguage=uz',
  'Fast: supplement designations as a layer over page rows.', 'fast',
  {'valueSet': VS_LANG, 'parameters': {'useSupplement': UZ_URL, 'displayLanguage': 'uz'}}, count=1000, order=True)
LS('uz-supplement-extension-designations', 'Glucose terms with the VS supplement extension and includeDesignations', 'ValueSet supplement extension + includeDesignations',
  'Fast: page rows plus supplement layer.', 'fast',
  {'valueSet': VS('uz-supplement-extension-designations', [inc(LOINC, F('COMPONENT', '=', 'LP14635-4'), F('SCALE_TYP', '=', 'LP7753-9'))], extension=[{'url': SUPP_EXT, 'valueCanonical': UZ_URL}]),
   'parameters': {'includeDesignations': True, 'displayLanguage': 'uz'}}, count=100)
uz_subset = copy.deepcopy({k: v for k, v in uz.items() if k not in ('text', 'concept', 'id', 'meta')})
uz_subset['version'] = '2.82-catalog-subset'
glucose_codes = [c for c in uz['concept'] if 'lucose' in c['display']][:60]
uz_subset['concept'] = [uz_by[c] for c in LANG_LIST if c in uz_by] + [c for c in glucose_codes if c['code'] not in LANG_LIST]
uz_subset['count'] = len(uz_subset['concept'])
LS('uz-supplement-tx-resource', 'LOINC list in Uzbek via a supplement passed as tx-resource', 'request-supplied supplement (subset of the real one, own version) pinned by useSupplement url|version',
  'Fast: supplement parsed into an in-memory layer keyed by content hash.', 'fast',
  {'valueSet': VS_LANG, 'txResources': [uz_subset], 'parameters': {'useSupplement': UZ_URL + '|2.82-catalog-subset', 'displayLanguage': 'uz'}}, count=1000, order=True,
  notes='The real supplement has 24,650 concepts (4.6 MB); the tx-resource copy keeps the 10 list codes and up to 60 glucose terms.')
LS('uz-supplement-text-search', 'Glucose terms filtered by Uzbek text "glyukoza"', 'text filter matching supplement designations',
  'Mixed: does the text filter see supplement designations at all?', 'mixed',
  {'valueSet': VS('uz-supplement-text-search', [inc(LOINC, F('COMPONENT', '=', 'LP14635-4'))]), 'parameters': {'filter': 'glyukoza', 'useSupplement': UZ_URL, 'displayLanguage': 'uz'}}, count=1000)
LS('uz-supplement-validate-display', '$validate-code 2345-7 with its Uzbek display', 'validate a display that only a supplement provides',
  'Fast.', 'fast',
  {'operation': 'validate-code', 'valueSet': VS_LANG, 'parameters': {'system': LOINC, 'code': '2345-7', 'display': 'Zardob yoki plazmada glyukoza miqdori', 'displayLanguage': 'uz', 'useSupplement': UZ_URL}})
LS('uz-supplement-lookup', '$lookup 2345-7 with the Uzbek supplement', 'lookup showing a supplement designation',
  'Fast.', 'fast', {'operation': 'lookup', 'parameters': {'system': LOINC, 'code': '2345-7', 'useSupplement': UZ_URL, 'displayLanguage': 'uz'}})

PROP_SUPP_LOINC = {'resourceType': 'CodeSystem', 'url': 'urn:fhirsmith:catalog:supplement:loinc-panel-group', 'version': '1', 'status': 'active', 'content': 'supplement',
  'supplements': LOINC, 'property': [{'code': 'catalog-group', 'uri': 'urn:fhirsmith:catalog:property:catalog-group', 'type': 'code'}],
  'concept': [{'code': c, 'property': [{'code': 'catalog-group', 'valueCode': g}]} for c, g in
              [('2345-7', 'renal-diabetes'), ('4548-4', 'renal-diabetes'), ('2160-0', 'renal-diabetes'), ('2339-0', 'renal-diabetes'), ('718-7', 'anaemia'), ('99999-9', 'renal-diabetes')]]}
PROP_SUPP_SCT = {'resourceType': 'CodeSystem', 'url': 'urn:fhirsmith:catalog:supplement:sct-panel-group', 'version': '1', 'status': 'active', 'content': 'supplement',
  'supplements': SCT, 'property': [{'code': 'catalog-group', 'uri': 'urn:fhirsmith:catalog:property:catalog-group', 'type': 'code'}],
  'concept': [{'code': c, 'property': [{'code': 'catalog-group', 'valueCode': 'renal-diabetes'}]} for c in ['44054006', '46635009', '90708001', '127013003', '38341003']]}
PROP_VS = lambda id_, supps: VS(id_, [inc(LOINC, F('catalog-group', '=', 'renal-diabetes'), F('SCALE_TYP', '=', 'LP7753-9')),
                                      inc(SCT, F('catalog-group', '=', 'renal-diabetes'), F('concept', 'is-a', '64572001'))],
                                extension=[{'url': SUPP_EXT, 'valueCanonical': s['url'] + '|' + s['version']} for s in supps])
LS('supplement-added-property-filter', 'Filter on a property that a request supplement adds (LOINC + SNOMED)', 'synthetic supplements add property catalog-group; VS filters on it AND base filters; one supplement code (99999-9) is not in LOINC',
  'Mixed: supplement properties need an in-memory prop set ANDed with stored sets; tx.fhir.org may reject filters on supplement properties.', 'mixed',
  {'valueSet': PROP_VS('supplement-added-property-filter', [PROP_SUPP_LOINC, PROP_SUPP_SCT]), 'txResources': [PROP_SUPP_LOINC, PROP_SUPP_SCT],
   'parameters': {'useSupplement': [PROP_SUPP_LOINC['url'] + '|1', PROP_SUPP_SCT['url'] + '|1']}}, count=1000)
PROP_SUPP_PINNED = copy.deepcopy(PROP_SUPP_LOINC)
PROP_SUPP_PINNED['url'] = 'urn:fhirsmith:catalog:supplement:loinc-panel-group-280'
PROP_SUPP_PINNED['supplements'] = LOINC + '|2.80'
LS('supplement-pinned-base-version-mismatch', 'Required supplement that pins LOINC 2.80 (server has 2.83)', 'supplement whose supplements= names a base version the server lacks; required via useSupplement',
  'Fast; must not apply, and must error because it is required.', 'fast',
  {'valueSet': VS('supplement-pinned-base-version-mismatch', [inc(LOINC, concepts=['2345-7', '4548-4', '718-7'])]), 'txResources': [PROP_SUPP_PINNED],
   'parameters': {'useSupplement': PROP_SUPP_PINNED['url'] + '|1', 'property': 'catalog-group'}}, count=1000)
LS('supplement-unknown-code-lookup', '$lookup of a code that only exists in a supplement (99999-9)', 'supplement concept not in the base code system',
  'Fast; records how the server treats unknown supplement codes.', 'fast',
  {'operation': 'lookup', 'txResources': [PROP_SUPP_LOINC], 'parameters': {'system': LOINC, 'code': '99999-9', 'useSupplement': PROP_SUPP_LOINC['url'] + '|1'}})
LS('supplement-property-lookup', '$lookup 2345-7 showing the supplement-added property', 'property from a request supplement in $lookup',
  'Fast.', 'fast',
  {'operation': 'lookup', 'txResources': [PROP_SUPP_LOINC], 'parameters': {'system': LOINC, 'code': '2345-7', 'useSupplement': PROP_SUPP_LOINC['url'] + '|1', 'property': 'catalog-group'}})

# ---------------------------------------------------------------- real value sets
pkgs = {}
for pkg in sorted(os.listdir(RAW)):
    d = os.path.join(RAW, pkg, 'package')
    for f in os.listdir(d):
        if f.startswith('ValueSet-') and f.endswith('.json'):
            try: vs = json.load(open(os.path.join(d, f)))
            except Exception: continue
            if vs.get('url'): pkgs[vs['url']] = (pkg, f, vs)

DROP_VERSION = {LOINC, RX, ICD10CM, 'http://hl7.org/fhir/sid/cvx', 'http://hl7.org/fhir/sid/icd-9-cm', 'http://www.ama-assn.org/go/cpt',
                'http://www.cms.gov/Medicare/Coding/HCPCSReleaseCodeSets', 'http://www.cms.gov/Medicare/Coding/ICD10', 'http://www.nlm.nih.gov/research/umls'}
def adapt(compose, notes):
    c = copy.deepcopy(compose)
    for part in ('include', 'exclude'):
        for i in c.get(part, []):
            v = i.get('version')
            if not v: continue
            if i.get('system') == SCT:
                nv = US if '731000124108' in v else INTL
                if nv != v: i['version'] = nv; notes.add(f'SNOMED version {v} -> {nv}')
            elif i.get('system') in DROP_VERSION:
                del i['version']; notes.add(f'{i["system"].split("/")[-1]} version {v} dropped (server default)')
            for k in ('valueSet',):
                pass
    return c
def strip_vs(vs, notes, keep_url=True):
    out = {'resourceType': 'ValueSet', 'url': vs['url']}
    if vs.get('version'): out['version'] = vs['version']
    if vs.get('name'): out['name'] = vs['name']
    out['status'] = 'active'
    out['compose'] = adapt(vs['compose'], notes)
    for part in ('include', 'exclude'):
        for i in out['compose'].get(part, []):
            if len(i.get('concept', [])) > 1000:
                i['concept'] = [{'code': c['code']} for c in i['concept']]
                notes.add('concept displays dropped from enumerated includes over 1,000 codes (request size)')
    return out
def helpers_for(vs, notes, seen):
    res = []
    for part in ('include', 'exclude'):
        for i in vs['compose'].get(part, []):
            for ref in i.get('valueSet', []):
                u = ref.split('|')[0]
                if u in seen: continue
                seen.add(u)
                if u in pkgs:
                    child = pkgs[u][2]
                    res.append(strip_vs(child, notes))
                    res += helpers_for(child, notes, seen)
                else:
                    notes.add('referenced value set not in the packages, left to the server: ' + u)
    return res
def drop_systems(compose, systems, notes):
    for part in ('include', 'exclude'):
        keep = []
        for i in compose.get(part, []):
            if i.get('system') in systems: notes.add('include of ' + i['system'] + ' removed (no provider on tx.fhir.org or locally)'); continue
            keep.append(i)
        compose[part] = keep
    if not compose.get('exclude'): compose.pop('exclude', None)

def R(id_, url, category, exercises, why, expect, patterns=None, count=UNSET, deep=None, order=False, drop=None, params=None):
    pkg, f, vs = pkgs[url]
    notes = set()
    v = strip_vs(vs, notes)
    seen = {url}
    helpers = helpers_for(vs, notes, seen)
    if drop:
        drop_systems(v['compose'], drop, notes)
        for h in helpers: drop_systems(h['compose'], drop, notes)
        helpers = [h for h in helpers if h['compose'].get('include')]
        # remove references to helpers that became empty
        live = {h['url'] for h in helpers}
        for i in v['compose']['include']:
            if 'valueSet' in i: i['valueSet'] = [x for x in i['valueSet'] if x.split('|')[0] in live or x.split('|')[0] not in pkgs]
        v['compose']['include'] = [i for i in v['compose']['include'] if i.get('system') or i.get('valueSet')]
    kind = 'vsac' if pkg.startswith('us.nlm.vsac') else 'us-core' if 'us.core' in pkg else 'ips'
    exp = vs.get('expansion') or {}
    source = {'kind': kind, 'package': pkg, 'file': f, 'url': url, 'title': vs.get('title') or vs.get('name')}
    if exp: source['packageExpansionTotal'] = exp.get('total', len(exp.get('contains', [])))
    if notes: source['adaptations'] = sorted(notes)
    req = {'valueSet': v}
    if helpers: req['txResources'] = helpers
    if params: req['parameters'] = params
    title = (vs.get('title') or vs.get('name')) + ' (' + {'vsac': 'VSAC', 'us-core': 'US Core', 'ips': 'IPS'}[kind] + ')'
    E(id_, title, category, exercises, why, expect, req, patterns, count, deep, order, source)

V_ = 'http://cts.nlm.nih.gov/fhir/ValueSet/'
UC = 'http://hl7.org/fhir/us/core/ValueSet/'
IPS = 'http://hl7.org/fhir/uv/ips/ValueSet/'
PG_BIG = ['first-page', 'pages-1-3', 'first-then-deep', 'last-with-total']
R('vsac-clinical-brand-drug', V_ + '2.16.840.1.113762.1.4.1010.5', 'properties-attributes', 'six RxNorm includes with lower-case "tty" filters (SBD, SBDF, SBDG, BPCK, ...)',
  'Fast: OR of six prop sets; records whether "tty" (lower case) is accepted.', 'fast', PG_BIG, 50, 20000)
R('vsac-clinical-drug-ingredient', V_ + '2.16.840.1.113762.1.4.1010.7', 'properties-attributes', 'RxNorm IN/PIN/MIN/BN by tty filters',
  'Fast: OR of four prop sets.', 'fast', ['first-page', 'last-with-total'], 50)
R('vsac-substance-other-than-drug', V_ + '2.16.840.1.113762.1.4.1010.9', 'hierarchy', 'US Edition descendent-of substance plus several is-a includes',
  'Fast: OR of stored sets on the US file.', 'fast', ['first-page', 'first-then-deep', 'last-with-total'], 50, 15000)
R('vsac-drowsiness', V_ + '2.16.840.1.113762.1.4.1078.767', 'hierarchy', 'three is-a filters in ONE include (AND), plus one is-a include',
  'Fast: AND of three descendants sets; a filter shape that is easy to get wrong.', 'fast', count=1000)
R('vsac-blood-potassium', V_ + '2.16.840.1.113762.1.4.1078.197', 'enumerated-nested', 'LOINC "concept in" filters instead of concept lists',
  'Fast: id lookups.', 'fast', count=1000)
R('vsac-diabetes-medications', V_ + '2.16.840.1.113762.1.4.1190.58', 'enumerated-nested', 'RxNorm "concept in" filters, ~975 codes',
  'Fast: id lookups; large in-lists.', 'fast', count=1000)
R('vsac-common-loinc-lab-codes', V_ + '2.16.840.1.113762.1.4.1267.17', 'enumerated-nested', 'an 18,566-code enumerated LOINC list; ordered paging',
  'Mixed: the list must be parsed and resolved per request (no stored set); order defined by the list.', 'mixed', ['first-page', 'first-then-deep', 'last-with-total'], 50, 15000, order=True)
R('vsac-cancer-sct', V_ + '2.16.840.1.113883.3.526.2.1079', 'enumerated-nested', '6,245-code enumerated SNOMED list (US Edition version)',
  'Mixed: large enumerated include; resolution cost grows with the list.', 'mixed', ['first-page', 'pages-1-3', 'last-with-total'], 100, order=True)
R('vsac-problem', V_ + '2.16.840.1.113883.3.88.12.3221.7.4', 'limits-paging', 'C-CDA Problem: two descendent-of includes (133k)',
  'Fast: OR of two stored sets; deep paging beyond main\'s cap.', 'fast', ALL_PATTERNS, 50, 120000)
R('vsac-major-surgical-procedure', V_ + '2.16.840.1.113883.3.666.5.1250', 'hierarchy', 'dozens of is-a includes (6k)',
  'Fast: OR of many stored sets.', 'fast', ['first-page', 'last-with-total'], 100)
R('vsac-ckd-type-or-cause', V_ + '2.16.840.1.113762.1.4.1222.4', 'hierarchy', 'many small is-a includes (132)',
  'Fast.', 'fast', count=1000)
R('vsac-organism-from-loinc-answers', V_ + '2.16.840.1.113762.1.4.1237.13', 'hierarchy', 'many is-a includes on organisms (1.3k)',
  'Fast.', 'fast', ['first-page', 'last-with-total'], 500)
R('vsac-fracture-icd10cm', V_ + '2.16.840.1.113762.1.4.1219.138', 'mixed-providers', 'ICD-10-CM only: is-a includes (17k), served by main',
  'Not on the engine: shows main\'s ICD-10-CM provider unchanged.', 'mixed', ['first-page', 'last-with-total'], 50)
R('vsac-external-cause-icd10cm', V_ + '2.16.840.1.113762.1.4.1099.33', 'mixed-providers', 'ICD-10-CM descendent-of (10.6k)',
  'Not on the engine.', 'mixed', ['first-page', 'last-with-total'], 50)
R('vsac-cvx-vaccines', V_ + '2.16.840.1.113762.1.4.1010.6', 'mixed-providers', 'CVX enumerated list (235)',
  'Not on the engine; CVX availability differs between servers.', 'fast', count=1000, order=True)
R('vsac-antineoplastic-agents', V_ + '2.16.840.1.113762.1.4.1260.182', 'enumerated-nested', '4,290-code enumerated RxNorm list',
  'Mixed: large enumerated list.', 'mixed', ['first-page', 'last-with-total'], 100, order=True)
R('vsac-cardiomyopathy-grouping', V_ + '2.16.840.1.113762.1.4.1235.100', 'mixed-providers', 'grouping VS importing SNOMED, LOINC, ICD-10-CM (and ICD-9-CM) children via tx-resource',
  'Fast on the SQLite children; ICD-9-CM child is left in to record the missing-system behaviour.', 'mixed', count=1000)
R('vsac-anxiety-grouping', V_ + '2.16.840.1.113762.1.4.1235.436', 'mixed-providers', 'grouping VS: SNOMED + LOINC + ICD-10-CM children (ICD-9-CM child removed)',
  'Fast on the SQLite children; the rest through main.', 'mixed', count=1000, drop={'http://hl7.org/fhir/sid/icd-9-cm'})
R('vsac-immunocompromising-grouping', V_ + '2.16.840.1.113762.1.4.1235.211', 'mixed-providers', 'large grouping VS (1.6k): SNOMED + ICD-10-CM (ICD-9-CM, ICD-10-PCS removed)',
  'Mixed.', 'mixed', ['first-page', 'last-with-total'], 500, drop={'http://hl7.org/fhir/sid/icd-9-cm', 'http://www.cms.gov/Medicare/Coding/ICD10'})
R('vsac-environmental-hazards', V_ + '2.16.840.1.113762.1.4.1222.1075', 'exclusion-inactive', 'LOINC "concept in" includes with an exclude',
  'Fast.', 'fast', count=1000)
R('vsac-1222-1434', V_ + '2.16.840.1.113762.1.4.1222.1434', 'hierarchy', 'spike corpus case with SNOMED is-a includes (79 codes)',
  'Fast (spike: 52 index rows stored vs 5,057 identity).', 'fast', count=1000)
# US Core
R('uscore-condition-code', UC + 'us-core-condition-code', 'mixed-providers', 'SNOMED is-a over findings/situations/events + whole ICD-10-CM + whole ICD-9-CM',
  'Mixed: large SNOMED union plus whole-system includes on main\'s providers; tests too-costly.', 'mixed', ['first-page', 'first-then-deep', 'last-with-total'], 50, 100000)
R('uscore-goal-description', UC + 'us-core-goal-description', 'limits-paging', 'whole LOINC + whole SNOMED (790k)',
  'Fast on the engine (two ranges; spike 0.3 ms); main 78 ms and capped.', 'fast', ALL_PATTERNS, 50, 500000)
R('uscore-laboratory-test-codes', UC + 'us-core-laboratory-test-codes', 'properties-attributes', 'LOINC CLASSTYPE = 1 (70k)',
  'Fast: literal prop set.', 'fast', BIG, 50, 50000)
R('uscore-report-and-note-codes', UC + 'us-core-diagnosticreport-report-and-note-codes', 'properties-attributes', 'LOINC CLASSTYPE filter',
  'Fast.', 'fast', ['first-page', 'last-with-total'], 50)
R('uscore-documentreference-type', UC + 'us-core-documentreference-type', 'mixed-providers', 'LOINC SCALE_TYP = Doc + v3 NullFlavor UNK',
  'Fast on the LOINC half.', 'fast', ['first-page', 'last-with-total'], 50)
R('uscore-procedure-code', UC + 'us-core-procedure-code', 'mixed-providers', 'SNOMED is-a procedure + whole LOINC + CPT, CDT, HCPCS, ICD-10-PCS',
  'Mixed: several systems that tx.fhir.org only partly has; records per-system outcomes.', 'mixed', ['first-page', 'last-with-total'], 50)
R('uscore-servicerequest-category', UC + 'us-core-servicerequest-category', 'enumerated-nested', 'US Core CodeSystem + SNOMED concepts + imported core VS',
  'Fast.', 'fast', count=1000)
R('uscore-clinical-note-type', UC + 'us-core-clinical-note-type', 'enumerated-nested', 'ten enumerated LOINC document codes',
  'Fast; order defined.', 'fast', count=1000, order=True)
# IPS
R('ips-problems', IPS + 'problems-uv-ips', 'hierarchy', 'several descendent-of includes plus an is-a',
  'Fast: OR of stored sets (~130k).', 'fast', ['first-page', 'first-then-deep', 'last-with-total'], 50, 100000)
R('ips-allergies-intolerances', IPS + 'allergies-intolerances-uv-ips', 'hierarchy', 'three descendent-of + is-a over substances/products/findings',
  'Fast.', 'fast', ['first-page', 'last-with-total'], 50)
R('ips-medication', IPS + 'medication-uv-ips', 'exclusion-inactive', 'descendent-of medicinal product + is-a, exclude vaccines',
  'Fast: OR then AND-NOT.', 'fast', ['first-page', 'last-with-total'], 50)
R('ips-procedures', IPS + 'procedures-uv-ips', 'exclusion-inactive', 'descendent-of procedure with eight exclude subtrees',
  'Fast: AND-NOT of an OR of eight sets.', 'fast', ['first-page', 'first-then-deep', 'last-with-total'], 50, 40000)
R('ips-results-lab-observations', IPS + 'results-laboratory-pathology-observations-uv-ips', 'properties-attributes', 'LOINC STATUS=ACTIVE AND CLASSTYPE=1, with exclude includes',
  'Fast.', 'fast', ['first-page', 'last-with-total'], 50)
R('ips-results-radiology-observations', IPS + 'results-radiology-observations-uv-ips', 'properties-attributes', 'LOINC STATUS AND CLASS filter',
  'Fast; CLASS value form matters.', 'fast', ['first-page', 'last-with-total'], 50)
R('ips-medication-example', IPS + 'medication-example-uv-ips', 'mixed-providers', 'NDC + SNOMED + RxNorm enumerated',
  'Fast; NDC through main.', 'fast', count=1000, order=True)
R('ips-vaccines', IPS + 'vaccines-uv-ips', 'hierarchy', 'descendent-of vaccine product + is-a',
  'Fast.', 'fast', count=1000)
R('ips-results-coded-values', IPS + 'results-coded-values-laboratory-pathology-uv-ips', 'enumerated-nested', 'four imported IPS value sets (one versioned import), as tx-resources',
  'Fast: OR of imported sets.', 'fast', ['first-page', 'last-with-total'], 100)
R('ips-target-diseases', IPS + 'target-diseases-uv-ips', 'enumerated-nested', '50 enumerated SNOMED codes',
  'Fast; order defined.', 'fast', count=1000, order=True)
R('ips-results-microorganism', IPS + 'results-microorganism-uv-ips', 'hierarchy', 'many descendent-of includes over organisms',
  'Fast.', 'fast', ['first-page', 'last-with-total'], 50)

# real VS reused for validate-code
def RV(id_, url, system, code, title):
    pkg, f, vs = pkgs[url]
    notes = set(); v = strip_vs(vs, notes); helpers = helpers_for(vs, notes, {url})
    src = {'kind': 'vsac' if 'vsac' in pkg else 'us-core' if 'us.core' in pkg else 'ips', 'package': pkg, 'file': f, 'url': url}
    if notes: src['adaptations'] = sorted(notes)
    req = {'operation': 'validate-code', 'valueSet': v, 'parameters': {'system': system, 'code': code}}
    if helpers: req['txResources'] = helpers
    E(id_, title, 'validate-lookup-subsumes', '$validate-code against a real value set', 'Fast: one has() after building the set.', 'fast', req, source=src)
RV('validate-ips-problems', IPS + 'problems-uv-ips', SCT, '22298006', 'MI in IPS problems')
RV('validate-uscore-condition-icd10', UC + 'us-core-condition-code', ICD10CM, 'E11.9', 'ICD-10-CM E11.9 in US Core condition codes')



# ---------------------------------------------------------------- main-expressible variants
by_id = {e['id']: e for e in entries}
def variant(id_, of, title, exercises, request, *pos, **kw):
    base = by_id[of]
    E(id_, title, base['category'], exercises,
      'Main-expressible form of ' + of + ', so the engine answer can be checked against a real tx.fhir.org expansion.',
      base['expect'], request, *pos, **kw)
    entries[-1]['variantOf'] = of
    base.setdefault('equivalentEntries', []).append(id_)
variant('rxnorm-sbd-by-brand-includes', 'rxnorm-sbd-by-brand-in-list', 'SBDs of acetaminophen brands: one include per brand (has_ingredient =)',
  '80 includes, each TTY = SBD AND has_ingredient = CUI:<BN>',
  {'valueSet': VS('rxnorm-sbd-by-brand-includes', [inc(RX, F('TTY', '=', 'SBD'), F('has_ingredient', '=', 'CUI:' + b)) for b in BNS])}, count=1000)
variant('sct-descendent-leaf-diabetes-ecl', 'sct-descendent-leaf-diabetes', 'Leaf descendants of diabetes as ECL (< X MINUS > < X)',
  'leaves expressed as descendants minus ancestors-of-descendants',
  {'valueSet': VS('sct-descendent-leaf-diabetes-ecl', [ecl('< 73211009 |Diabetes mellitus| MINUS > (< 73211009 |Diabetes mellitus|)')])}, count=1000)
dm = pkgs[V_ + '2.16.840.1.113762.1.4.1190.58'][2]
dm_codes = [c.strip() for i in dm['compose']['include'] for f in i.get('filter', []) if f['op'] == 'in' for c in f['value'].split(',')]
variant('vsac-diabetes-medications-enumerated', 'vsac-diabetes-medications', 'Diabetes Medications (VSAC) with concept lists instead of "concept in"',
  'the VSAC value set rewritten as one enumerated RxNorm include',
  {'valueSet': VS('vsac-diabetes-medications-enumerated', [inc(RX, concepts=dm_codes)])}, count=1000)
variant('sct-implicit-ecl-inline', 'sct-implicit-ecl', 'Same ECL as an inline compose filter (constraint =)',
  'ECL given in compose instead of ?fhir_vs=ecl/',
  {'valueSet': VS('sct-implicit-ecl-inline', [ecl('<< 73211009 MINUS << 44054006')])}, count=1000)
variant('sct-refset-icd10cm-map-ecl', 'sct-implicit-refset-icd10cm-map', 'US ICD-10-CM map refset members as ECL ^ on the US Edition',
  'member-of a complex map refset via ECL instead of ?fhir_vs=refset/',
  {'valueSet': VS('sct-refset-icd10cm-map-ecl', [ecl('^ 6011000124106', version=US)])}, ['first-page', 'last-with-total'], 50)
variant('validate-refset-icd10cm-map-ecl', 'validate-implicit-refset', 'T2DM in the US ICD-10-CM map refset (ECL ^)',
  '$validate-code against the ECL form of the refset value set',
  {'operation': 'validate-code', 'valueSet': VS('v-refset-ecl', [ecl('^ 6011000124106', version=US)]), 'parameters': {'system': SCT, 'code': '44054006', 'version': US}})
by_id['sct-is-not-a'].setdefault('equivalentEntries', []).append('sct-findings-minus-disease-exclude')
by_id['rxnorm-sbd-by-brand-in-list'].setdefault('equivalentEntries', []).append('rxnorm-trace-helper-includes')

# ---------------------------------------------------------------- known differences (each with a written reason)
by_id = {e['id']: e for e in entries}
GAP, UNSUP, BEHAV = 'reference data gap', 'reference does not support', 'reference behaviour'
def known(id_, aspects, kind, reason):
    by_id[id_].setdefault('expectedDifferences', [])
    for a in aspects: by_id[id_]['expectedDifferences'].append({'aspect': a, 'kind': kind, 'reason': reason})
known('loinc-display-language-zh-designations', ['displays', 'designations'], GAP,
      'tx.fhir.org has no zh-CN (nor it-IT, el-GR, ru-RU, es-ES, et-EE, pl-PL, tr-TR, fr-BE) LOINC designations, so it falls back to English displays; our LOINC 2.83 import includes the release\'s linguistic variants, e.g. zh-CN 96,518 designations. tx.fhir.org also adds the server-known Uzbek lang-pack supplement unasked when includeDesignations is set.')
known('loinc-text-filter-german', ['codes', 'total'], GAP,
      'tx.fhir.org text filters match English displays only (0 results for "Glukose"); the engine may also search the de-DE designations that LOINC 2.83 ships.')
known('uz-supplement-text-search', ['codes', 'total'], GAP,
      'tx.fhir.org text filters do not search supplement designations (0 results for "glyukoza"); an engine that indexes supplement designations returns the glucose terms.')
for i, why in [('sct-descendent-leaf-diabetes', 'main\'s SNOMED provider has no descendent-leaf filter (500 "Unsupported filter operation"); see the ECL variant.'),
               ('sct-is-not-a', 'main\'s SNOMED provider has no is-not-a filter (500); the compose.exclude form is sct-findings-minus-disease-exclude.'),
               ('sct-regex-display-tumour', 'main\'s SNOMED provider has no display filter (500 "Unsupported filter property: display"); no main-expressible equivalent.'),
               ('sct-regex-within-isa', 'main\'s SNOMED provider has no display filter (500); no main-expressible equivalent.'),
               ('sct-regex-display-common', 'main\'s SNOMED provider has no display filter (500); no main-expressible equivalent.'),
               ('rxnorm-sbd-by-brand-in-list', 'main\'s RxNorm provider supports relationship filters with = only (500 "Unknown filter"); see the one-include-per-brand variant.'),
               ('vsac-diabetes-medications', 'main\'s RxNorm provider has no "concept in" filter (500), so this published VSAC value set fails on tx.fhir.org; see the enumerated variant.'),
               ('sct-us-minus-intl-whole', 'tx.fhir.org fails with 500 "Must override" on a whole-system include/exclude across editions; no smaller main-expressible equivalent of the same set.'),
               ('supplement-added-property-filter', 'main cannot filter on supplement-added properties (500 "not supported for LOINC"); no equivalent.'),
               ('sct-ecl-concrete-value', 'main\'s ECL does not support concrete values (400); no equivalent.'),
               ('sct-ecl-description-filter', 'main\'s ECL parser has no description filters (400); the $expand filter parameter (sct-text-filter-heart-attack) is the nearest, but not the same, form.'),
               ('sct-implicit-ecl', 'tx.fhir.org does not resolve ?fhir_vs=ecl/ implicit value sets (422 not-found); see the inline variant.'),
               ('sct-implicit-refset-icd10cm-map', 'tx.fhir.org does not resolve ?fhir_vs=refset/ for the US complex-map refset (422 not-found; simple International refsets resolve); see the ECL ^ variant.'),
               ('validate-implicit-refset', 'tx.fhir.org does not resolve the implicit refset value set (422); see the ECL ^ variant.')]:
    known(i, ['status', 'codes', 'total', 'result'], UNSUP, why)
for i in ['sct-refset-icd10cm-map-ecl', 'validate-refset-icd10cm-map-ecl']:
    known(i, ['codes', 'total', 'result'], GAP,
          'tx.fhir.org returns 0 members for ^ 6011000124106 on the US Edition (its SNOMED cache does not expose this complex-map refset as a member set); our US import keeps all refsets, 138,383 members.')
known('supplement-pinned-base-version-mismatch', ['status', 'codes', 'total', 'displays'], BEHAV,
      'the supplement pins http://loinc.org|2.80 and the server has 2.83; supplement applicability is yes/no, so a required supplement that does not apply should give an error, but tx.fhir.org applies it and reports it as used.')
known('validate-sct-inactive-activeonly', ['result'], BEHAV,
      'with activeOnly=true an inactive code is not in the expansion, so membership should be false; tx.fhir.org returns result=true with an inactive-status warning.')

import re
_inner = re.compile(r'\{\n\s*((?:"[^"\n]*": (?:"(?:[^"\\\n]|\\.)*"|[-\w.]+),?\n\s*){1,3})\}')
def compact(text):
    # put innermost small objects (codes, filters, params) on one line
    return _inner.sub(lambda m: '{' + ' '.join(x.strip() for x in m.group(1).strip().split('\n')) + '}', text)
DROP = set(['loinc-order-obs-order', 'loinc-component-glucose', 'rxnorm-tty-in', 'sct-ecl-concrete-range', 'rxnorm-rel-rn-acetaminophen', 'loinc-class-chem', 'loinc-classtype-clinical', 'sct-isa-procedure', 'vsac-1222-1434', 'loinc-discouraged-activeonly', 'enumerated-filter-exclude-mix', 'loinc-enumerated-ordered', 'sct-ecl-or', 'sct-implicit-refset-list', 'loinc-implicit-part-vs', 'sct-us-edition-isa-t1dm', 'mixed-actcode-loinc', 'mixed-loinc-answers-nullflavor', 'vsac-external-cause-icd10cm', 'validate-rxnorm-scd', 'subsumes-sct-not', 'validate-us-code-in-us', 'loinc-descendants-chem', 'sct-us-only-code-in-intl', 'vsac-clinical-drug-ingredient', 'ips-results-microorganism', 'ips-vaccines', 'sct-ecl-ancestors-and-parents', 'sct-not-in', 'rxnorm-text-filter-acetaminophen', 'loinc-rad-modality-exists', 'validate-sct-not-member', 'lookup-rxnorm-161', 'sct-inactive-filter-true', 'vsac-ckd-type-or-cause', 'vsac-blood-potassium', 'uscore-report-and-note-codes', 'loinc-designation-param-de'])
missing = DROP - {e['id'] for e in entries}
assert not missing, missing
entries = [e for e in entries if e['id'] not in DROP]
os.makedirs(OUT, exist_ok=True)
for f in os.listdir(OUT):
    if f.endswith('.json'): os.remove(os.path.join(OUT, f))
ids = set()
for e in entries:
    assert e['id'] not in ids, e['id']; ids.add(e['id'])
    with open(os.path.join(OUT, e['id'] + '.json'), 'w') as fh:
        fh.write(compact(json.dumps(e, indent=2, ensure_ascii=False)) + '\n')
import collections
print(len(entries), collections.Counter(e['category'] for e in entries))
print(collections.Counter(e['source']['kind'] for e in entries))
