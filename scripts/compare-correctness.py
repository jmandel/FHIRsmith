#!/usr/bin/env python3
"""Compare IR vs Legacy expansion results from JSON files."""
import json, sys

def walk_codes(contains):
    codes = set()
    for c in (contains or []):
        codes.add(c['code'])
        codes |= walk_codes(c.get('contains'))
    return codes

def walk_pairs(contains):
    pairs = []
    for c in (contains or []):
        pairs.append((c['code'], c.get('display', '')))
        pairs.extend(walk_pairs(c.get('contains')))
    return sorted(pairs)

ir = json.load(open('/tmp/_ir.json'))
leg = json.load(open('/tmp/_leg.json'))

ir_exp = ir.get('expansion', {})
leg_exp = leg.get('expansion', {})

ir_total = ir_exp.get('total', '?')
leg_total = leg_exp.get('total', '?')

ir_codes = walk_codes(ir_exp.get('contains'))
leg_codes = walk_codes(leg_exp.get('contains'))

ir_pairs = walk_pairs(ir_exp.get('contains'))
leg_pairs = walk_pairs(leg_exp.get('contains'))

ir_top = len(ir_exp.get('contains', []))
leg_top = len(leg_exp.get('contains', []))

only_ir = ir_codes - leg_codes
only_leg = leg_codes - ir_codes

codes_match = ir_codes == leg_codes
totals_match = ir_total == leg_total
# Legacy may omit total for large sets — treat as known difference, not failure
totals_compatible = totals_match or leg_total == '?'
displays_match = ir_pairs == leg_pairs

ok = '\u2713'
no = '\u2717'

status = 'PASS' if (codes_match and totals_compatible) else 'FAIL'
print(status)
total_note = ok if totals_match else ('~ (legacy omits total)' if leg_total == '?' else no)
print(f'  total:    IR={ir_total}  Legacy={leg_total}  {total_note}')
print(f'  codes:    IR={len(ir_codes)}  Legacy={len(leg_codes)}  top-level: IR={ir_top} Legacy={leg_top}  {ok if codes_match else no}')
print(f'  displays: {ok + " match" if displays_match else no + " differ"}')
if only_ir:
    print(f'  only in IR ({len(only_ir)}): {sorted(only_ir)[:5]}')
if only_leg:
    print(f'  only in Legacy ({len(only_leg)}): {sorted(only_leg)[:5]}')

ir_ucs = [p.get('valueUri', '') for p in ir_exp.get('parameter', []) if p.get('name') == 'used-codesystem']
leg_ucs = [p.get('valueUri', '') for p in leg_exp.get('parameter', []) if p.get('name') == 'used-codesystem']
if ir_ucs or leg_ucs:
    ucs_match = set(ir_ucs) == set(leg_ucs)
    print(f'  used-cs:  IR={ir_ucs}  Legacy={leg_ucs}  {ok if ucs_match else "~"}')
