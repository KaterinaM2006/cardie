"""Risk classifier: two thresholds on mean qNet over 1-4x Cmax.

qNet separates the three CiPA classes cleanly with no overlap, which is why
the classifier is built on it rather than on dAPD90. dAPD90 is kept as a
second, deliberately weaker classifier because it is the number a
non-specialist understands and because showing where it fails (ranolazine and
verapamil, both known CiPA outliers) is more honest than hiding it.

The thresholds are fitted on the same 12 compounds they are evaluated on.
That is a separability result, not held-out accuracy, and both this module
and the UI say so in those words.
"""
import json
import os
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
SWEEP = os.path.join(ROOT, 'data', 'sweep.json')

CLASSES = ('HIGH', 'INTERMEDIATE', 'LOW')
DISCLAIMER = ('Thresholds fitted on these same 12 compounds. This is a '
              'separability result, not held-out accuracy.')


def _candidates(values):
    """Midpoints between consecutive distinct values."""
    v = sorted(set(values))
    return [(a + b) / 2.0 for a, b in zip(v, v[1:])]


def classify(x, t_hi, t_lo, descending=True):
    """Map a score to a risk class.

    descending=True  (qNet):   below t_hi is HIGH, above t_lo is LOW.
    descending=False (dAPD90): above t_hi is HIGH, below t_lo is LOW.
    """
    if x is None:                       # repolarisation failure
        return 'HIGH'
    if descending:
        return 'HIGH' if x < t_hi else ('LOW' if x > t_lo else 'INTERMEDIATE')
    return 'HIGH' if x > t_hi else ('LOW' if x < t_lo else 'INTERMEDIATE')


def fit(scores, labels, descending=True):
    """Exhaustive search over threshold pairs, maximising training accuracy.

    Several threshold pairs can tie on accuracy. The tie is broken toward the
    pair that calls HIGH earliest — in a safety screen, the cost of flagging a
    safe compound is a follow-up assay, and the cost of missing an unsafe one
    is considerably worse. Candidates are midpoints between observed values,
    so a threshold always sits in the middle of the gap it occupies.
    """
    xs = [s for s in scores if s is not None]
    best = None
    for t_hi in _candidates(xs):
        for t_lo in _candidates(xs):
            if (t_lo <= t_hi) if descending else (t_lo >= t_hi):
                continue
            correct = sum(classify(s, t_hi, t_lo, descending) == y
                          for s, y in zip(scores, labels))
            # descending (qNet): HIGH is below t_hi, so a higher t_hi flags
            # sooner. ascending (dAPD90): HIGH is above t_hi, so a lower one does.
            conservative = t_hi if descending else -t_hi
            if best is None or (correct, conservative) > (best[0], best[1]):
                best = (correct, conservative, t_hi, t_lo)
    return {'t_high': best[2], 't_low': best[3],
            'correct': best[0], 'n': len(labels),
            'accuracy': best[0] / len(labels), 'descending': descending}


def confusion(scores, labels, model):
    """3x3 matrix, rows = true class, cols = predicted."""
    m = {a: {b: 0 for b in CLASSES} for a in CLASSES}
    rows = []
    for s, y in zip(scores, labels):
        p = classify(s, model['t_high'], model['t_low'], model['descending'])
        m[y][p] += 1
        rows.append(p)
    return m, rows


def build(sweep=None):
    """Fit both classifiers on the sweep and return everything the UI needs."""
    if sweep is None:
        with open(SWEEP) as f:
            sweep = json.load(f)

    drugs = sweep['drugs']
    names = sorted(drugs, key=lambda d: drugs[d]['qnet_mean'])
    labels = [drugs[d]['label'] for d in names]

    qnet = [drugs[d]['qnet_mean'] for d in names]
    # Repolarisation failure has no APD90. It is the most severe outcome in
    # the set, so it scores as the worst possible value rather than as missing.
    dapd = [drugs[d]['doses'][3]['dAPD90'] for d in names]
    dapd_scored = [1e9 if v is None else v for v in dapd]

    m_qnet = fit(qnet, labels, descending=True)
    m_dapd = fit(dapd_scored, labels, descending=False)

    cm_qnet, pred_qnet = confusion(qnet, labels, m_qnet)
    cm_dapd, pred_dapd = confusion(dapd_scored, labels, m_dapd)

    return {
        'disclaimer': DISCLAIMER,
        'qnet': {
            **m_qnet,
            'units': 'uC/uF',
            'confusion': cm_qnet,
            'control': sweep['control']['qNet'],
        },
        'dapd90': {
            **m_dapd,
            'units': 'ms',
            'confusion': cm_dapd,
        },
        'drugs': [
            {'name': n, 'true': l, 'qnet_mean': q,
             'pred_qnet': pq, 'dapd90_4x': d, 'pred_dapd90': pd,
             'cmax': drugs[n]['cmax']}
            for n, l, q, pq, d, pd in zip(names, labels, qnet, pred_qnet,
                                          dapd, pred_dapd)
        ],
    }


def _print_matrix(title, cm, model, unit):
    print(f'\n{title}: {model["correct"]}/{model["n"]} '
          f'({model["accuracy"]:.0%})   thresholds '
          f'{model["t_high"]:.4f} / {model["t_low"]:.4f} {unit}')
    print(f'{"true \\ pred":>14s}' + ''.join(f'{c:>14s}' for c in CLASSES))
    for a in CLASSES:
        print(f'{a:>14s}' + ''.join(f'{cm[a][b]:>14d}' for b in CLASSES))


if __name__ == '__main__':
    v = build()
    _print_matrix('qNet, mean over 1-4x Cmax', v['qnet']['confusion'],
                  v['qnet'], 'uC/uF')
    _print_matrix('dAPD90 at 4x Cmax', v['dapd90']['confusion'],
                  v['dapd90'], 'ms')
    print(f'\n{"drug":>15s} {"true":>13s} {"qNet":>9s} {"pred":>13s} '
          f'{"dAPD90@4x":>10s} {"pred":>13s}')
    for d in v['drugs']:
        apd = 'repol.fail' if d['dapd90_4x'] is None else f'{d["dapd90_4x"]:+10.1f}'
        flag = '' if d['pred_qnet'] == d['true'] else '   <- qNet miss'
        flag += '' if d['pred_dapd90'] == d['true'] else '   <- dAPD90 miss'
        print(f'{d["name"]:>15s} {d["true"]:>13s} {d["qnet_mean"]:+9.4f} '
              f'{d["pred_qnet"]:>13s} {apd:>10s} {d["pred_dapd90"]:>13s}{flag}')
    print(f'\n{DISCLAIMER}')
    sys.exit(0)
