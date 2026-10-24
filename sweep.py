"""Precompute the whole 12-drug x 4-dose sweep to JSON.

The live demo must never wait on a simulation it could have cached. This is
the only compute-heavy step in the project (~7 min on 4 CPU cores), which is
what makes it the honest candidate for the Vultr track.

    python sweep.py                        # full sweep -> data/sweep.json
    python sweep.py --prepace 100          # fast, for wiring up the UI
    python sweep.py --tiger                # also load the Tiger Data hypertable

Acceptance: the printed table matches §3 of the brief, row for row.
"""
import argparse
import json
import math
import os
import sys
import time

import engine
from engine import CIPA_LABEL, Engine, MODE_LABEL, hill_block, load_ground_truth

ROOT = os.path.dirname(os.path.abspath(__file__))
DOSES = (1, 2, 3, 4)

# Modes 1/2 (Epi, Mid) are additive: a transmural-heterogeneity view on top
# of the validated endocardial (0) classification, not a replacement for it.
TRANSMURAL_MODES = (1, 2)

# §3 of the brief. The sweep checks itself against these.
REFERENCE = {
    'quinidine':      (-0.0115,  351.7, None),
    'bepridil':       (0.0527,    73.4, 186.7),
    'dofetilide':     (0.0605,    34.9, 126.5),
    'sotalol':        (0.0644,    39.8, 102.1),
    'chlorpromazine': (0.0742,    11.9,  39.0),
    'cisapride':      (0.0687,    19.5,  62.3),
    'terfenadine':    (0.0683,    28.3,  65.4),
    'ondansetron':    (0.0704,    22.4,  74.6),
    'diltiazem':      (0.0993,   -21.8, -36.2),
    'mexiletine':     (0.1001,     3.9,  24.8),
    'ranolazine':     (0.0827,    24.2,  85.7),
    'verapamil':      (0.0825,     9.2,  56.6),
}


def jsonable(x):
    """NaN is not valid JSON. Repolarisation failure travels as null."""
    return None if x is None or (isinstance(x, float) and math.isnan(x)) else x


def run_mode(eng, mode, drugs, ic50, herg, prepace, frames):
    """Control + all 12 drugs x 4 doses at one cell mode.

    Same computation as the mode-0 (endocardial) sweep in main(), just
    parameterised over mode so modes 1 (Epi) and 2 (Mid) can be computed
    the same way without duplicating the acceptance-checked mode-0 path.
    """
    t0 = time.time()
    ctrl = eng.run(prepace=prepace, frames=frames, mode=mode)
    print(f'  control [{MODE_LABEL[mode]}] qNet={ctrl["qNet"]:.4f}  '
          f'APD90={ctrl["APD90"]:.1f}')

    doses_by_drug = {}
    for name in sorted(drugs, key=lambda d: -drugs[d]['cipa']):
        info = drugs[name]
        cmax = info['cmax']
        doses = []
        for mult in DOSES:
            conc = mult * cmax
            r = eng.run(ic50[name], herg[name], conc, prepace=prepace,
                        frames=frames, mode=mode)
            dapd = (r['APD90'] - ctrl['APD90']
                    if not math.isnan(r['APD90']) else float('nan'))
            doses.append({
                'mult': mult,
                'conc_nM': conc,
                'qNet': r['qNet'],
                'APD90': jsonable(r['APD90']),
                'dAPD90': jsonable(dapd),
                'repol_failure': math.isnan(r['APD90']),
                'block': hill_block(ic50[name], conc),
                'peak_bound': max(r['frames']['hERG_bound']),
                'frames': r['frames'],
            })
        doses_by_drug[name] = doses
        print(f'    {name:>15s} [{MODE_LABEL[mode]}]  4x APD90='
              f'{doses[3]["APD90"] if doses[3]["APD90"] is not None else float("nan"):.1f}',
              flush=True)

    print(f'  [{MODE_LABEL[mode]}] done in {time.time() - t0:.0f}s')
    return {'qNet': ctrl['qNet'], 'APD90': ctrl['APD90'],
            'frames': ctrl['frames']}, doses_by_drug


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--prepace', type=int, default=400)
    ap.add_argument('--out', default=os.path.join(ROOT, 'data', 'sweep.json'))
    ap.add_argument('--frames', type=int, default=300)
    ap.add_argument('--tiger', action='store_true',
                    help='also load every run into the Tiger Data hypertable')
    ap.add_argument('--no-transmural', action='store_true',
                    help='skip the Epi/Mid cell-mode passes (endocardial only, faster)')
    args = ap.parse_args()

    drugs, ic50, herg = load_ground_truth()
    eng = Engine()
    t0 = time.time()

    tiger = None
    if args.tiger:
        import tiger
        tiger = tiger.Loader()
        tiger.ensure_schema()

    print(f'control ... ', end='', flush=True)
    ctrl = eng.run(prepace=args.prepace, frames=args.frames)
    print(f"qNet={ctrl['qNet']:.4f}  APD90={ctrl['APD90']:.1f}  "
          f"({time.time() - t0:.0f}s)")
    if tiger:
        raw = eng.run(prepace=args.prepace, frames=None)
        tiger.load_run('control', 0, 0.0, raw)

    out = {
        'meta': {
            'model': 'ord-cipa-v1',
            'mmt': os.path.basename(engine.MMT),
            'cycle_length_ms': eng.cl,
            'prepace_beats': args.prepace,
            'frames': args.frames,
            'qnet_currents': engine.QCUR,
            'generated': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
            'note': ('qNet is the mean over 1-4x Cmax. Thresholds are fitted '
                     'on these same 12 compounds: this is a separability '
                     'result, not held-out accuracy.'),
        },
        'control': {'qNet': ctrl['qNet'], 'APD90': ctrl['APD90'],
                    'frames': ctrl['frames']},
        'drugs': {},
    }

    for name in sorted(drugs, key=lambda d: -drugs[d]['cipa']):
        info = drugs[name]
        cmax = info['cmax']
        entry = {'name': name, 'cmax': cmax, 'cipa': info['cipa'],
                 'label': CIPA_LABEL[info['cipa']], 'doses': []}
        qnets = []
        for mult in DOSES:
            conc = mult * cmax
            r = eng.run(ic50[name], herg[name], conc,
                        prepace=args.prepace, frames=args.frames)
            qnets.append(r['qNet'])
            dapd = (r['APD90'] - ctrl['APD90']
                    if not math.isnan(r['APD90']) else float('nan'))
            entry['doses'].append({
                'mult': mult,
                'conc_nM': conc,
                'qNet': r['qNet'],
                'APD90': jsonable(r['APD90']),
                'dAPD90': jsonable(dapd),
                'repol_failure': math.isnan(r['APD90']),
                'block': hill_block(ic50[name], conc),
                'peak_bound': max(r['frames']['hERG_bound']),
                'frames': r['frames'],
            })
            if tiger:
                raw = eng.run(ic50[name], herg[name], conc,
                              prepace=args.prepace, frames=None)
                tiger.load_run(name, mult, conc, raw, qnet=r['qNet'],
                               apd90=r['APD90'], fda_label=info['cipa'])
            print(f'  {name:>15s} {mult}x  qNet={r["qNet"]:+.4f}  '
                  f'dAPD90={dapd:+7.1f}  bound={max(r["frames"]["hERG_bound"]):.3f}'
                  f'{"  REPOL FAILURE" if math.isnan(r["APD90"]) else ""}',
                  flush=True)
        entry['qnet_mean'] = sum(qnets) / len(qnets)
        out['drugs'][name] = entry

    # Transmural heterogeneity: Epi (1) and Mid-myocardial (2), additive to
    # the validated endocardial (0) classification above. Mode 0 is stored
    # here too (duplicating `control`/`doses`) so the frontend can always
    # index by mode without a special case for the default.
    out['control_by_mode'] = {'0': out['control']}
    for name in out['drugs']:
        out['drugs'][name]['doses_by_mode'] = {'0': out['drugs'][name]['doses']}
    out['meta']['modes'] = MODE_LABEL

    if not args.no_transmural:
        for mode in TRANSMURAL_MODES:
            print(f'\ntransmural pass: mode {mode} ({MODE_LABEL[mode]})')
            mode_ctrl, mode_doses = run_mode(eng, mode, drugs, ic50, herg,
                                             args.prepace, args.frames)
            out['control_by_mode'][str(mode)] = mode_ctrl
            for name, doses in mode_doses.items():
                out['drugs'][name]['doses_by_mode'][str(mode)] = doses

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, 'w') as f:
        json.dump(out, f, separators=(',', ':'))

    size_mb = os.path.getsize(args.out) / 1e6
    print(f'\nwrote {args.out}  ({size_mb:.2f} MB, {time.time() - t0:.0f}s total)')

    # Acceptance check against §3.
    print(f'\n{"drug":>15s} {"label":>12s} {"qNet":>9s} {"ref":>9s} '
          f'{"dAPD1x":>8s} {"ref":>8s} {"dAPD4x":>8s} {"ref":>8s}')
    ok = True
    for name, e in sorted(out['drugs'].items(), key=lambda kv: -kv[1]['cipa']):
        ref_q, ref_1, ref_4 = REFERENCE[name]
        d1, d4 = e['doses'][0]['dAPD90'], e['doses'][3]['dAPD90']
        row_ok = (abs(e['qnet_mean'] - ref_q) < 5e-4
                  and abs(d1 - ref_1) < 0.5
                  and (ref_4 is None) == (d4 is None)
                  and (d4 is None or abs(d4 - ref_4) < 0.5))
        ok &= row_ok
        f4 = 'repol.fail' if d4 is None else f'{d4:+8.1f}'
        r4 = 'repol.fail' if ref_4 is None else f'{ref_4:+8.1f}'
        print(f'{name:>15s} {e["label"]:>12s} {e["qnet_mean"]:+9.4f} '
              f'{ref_q:+9.4f} {d1:+8.1f} {ref_1:+8.1f} {f4:>8s} {r4:>8s}'
              f'  {"ok" if row_ok else "MISMATCH"}')
    print(f'\n{"MATCHES REFERENCE TABLE" if ok else "DOES NOT MATCH §3 — STOP AND DEBUG"}')
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
