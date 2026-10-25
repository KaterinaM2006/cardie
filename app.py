"""Flask API + static page.

The precomputed sweep is loaded into memory at startup, so /api/run is
instant and the slider never waits on a simulation. /api/trace is the one
route that hits Tiger Data, which keeps the database on the live path
without putting it on the critical path.
"""
import json
import math
import os

from dotenv import load_dotenv
from flask import Flask, jsonify, request, send_from_directory

load_dotenv()

import classifier
import explain as explain_mod
import tiger
from drug_info import DRUG_INFO

ROOT = os.path.dirname(os.path.abspath(__file__))
SWEEP_PATH = os.environ.get('CARDIE_SWEEP',
                            os.path.join(ROOT, 'data', 'sweep.json'))

app = Flask(__name__, static_folder=os.path.join(ROOT, 'static'))

with open(SWEEP_PATH) as f:
    SWEEP = json.load(f)
VALIDATION = classifier.build(SWEEP)
QNET = VALIDATION['qnet']
DRUG_NAMES = sorted(SWEEP['drugs'])

MODEL_INFO = {
    'cell_model': "O'Hara–Rudy ORd-CiPA v1.0 (Dutta et al. 2017)",
    'protocol': 'Endocardial, cycle length 2000 ms, 400 pre-paced beats, '
                'one analysed beat.',
    'binding_model': 'Li et al. 2017 dynamic hERG Markov binding model, '
                      'FDA-fitted per-compound parameters (CiPA).',
    'other_channels': 'INa, INaL, Ito, IKs, IK1, ICaL blocked by a static '
                       'Hill equation fitted to Li et al. 2017 IC50s.',
    'metric': ('qNet = ∫(INaL + ICaL + Ito + IKr + IKs + IK1) dt over '
               'the beat, µC/µF, averaged over 1–4× '
               'Cmax.'),
    'scope': '12 compounds, not 28 — the fitted dynamic hERG binding '
             'parameters exist only for the CiPA training set.',
    'sources': ['https://github.com/FDA/CiPA', 'https://github.com/myokit/models'],
}


def risk_for(qnet_mean):
    return classifier.classify(qnet_mean, QNET['t_high'], QNET['t_low'], True)


def _lerp(a, b, f):
    return a + (b - a) * f


def dose_entry(drug, dose):
    """The simulated run at `dose`, or a labelled interpolation between the
    two neighbouring simulated doses. Nothing is extrapolated."""
    d = SWEEP['drugs'][drug]
    dose = max(0.0, min(4.0, float(dose)))
    control = SWEEP['control']

    def at(mult):
        if mult == 0:
            return {'mult': 0, 'conc_nM': 0.0, 'qNet': control['qNet'],
                    'APD90': control['APD90'], 'dAPD90': 0.0,
                    'repol_failure': False, 'peak_bound': 0.0,
                    'block': {k: 0.0 for k in d['doses'][0]['block']},
                    'frames': control['frames']}
        return d['doses'][int(mult) - 1]

    lo_i, hi_i = math.floor(dose), math.ceil(dose)
    lo, hi = at(lo_i), at(hi_i)
    if lo_i == hi_i:
        return {**lo, 'interpolated': False}

    f = dose - lo_i
    frames = {k: [_lerp(a, b, f) for a, b in zip(lo['frames'][k], hi['frames'][k])]
              for k in lo['frames'] if k != 't'}
    frames['t'] = lo['frames']['t']
    out = {
        'mult': dose,
        'conc_nM': dose * d['cmax'],
        'qNet': _lerp(lo['qNet'], hi['qNet'], f),
        'repol_failure': hi['repol_failure'],
        'peak_bound': _lerp(lo['peak_bound'], hi['peak_bound'], f),
        'block': {k: _lerp(lo['block'][k], hi['block'][k], f)
                  for k in lo['block']},
        'frames': frames,
        'interpolated': True,
        'between': [lo_i, hi_i],
    }
    if hi['repol_failure'] or lo['APD90'] is None or hi['APD90'] is None:
        out['APD90'], out['dAPD90'] = None, None
    else:
        out['APD90'] = _lerp(lo['APD90'], hi['APD90'], f)
        out['dAPD90'] = _lerp(lo['dAPD90'], hi['dAPD90'], f)
    return out


@app.get('/api/drugs')
def api_drugs():
    return jsonify([
        {'name': n, 'cmax_nM': SWEEP['drugs'][n]['cmax'],
         'fda_label': SWEEP['drugs'][n]['label'],
         'qnet_mean': SWEEP['drugs'][n]['qnet_mean'],
         'predicted': risk_for(SWEEP['drugs'][n]['qnet_mean'])}
        for n in DRUG_NAMES])


@app.get('/api/sweep')
def api_sweep():
    """The whole precomputed bundle. The page fetches this once and then
    does every redraw client-side with no further backend call."""
    return jsonify({**SWEEP, 'validation': VALIDATION,
                    'drug_info': DRUG_INFO,
                    'model_info': MODEL_INFO,
                    'integrations': {'tiger': tiger.available(),
                                     'gemini': explain_mod.available()}})


@app.get('/api/run')
def api_run():
    drug = request.args.get('drug', '')
    if drug not in SWEEP['drugs']:
        return jsonify({'error': f'unknown drug {drug!r}',
                        'drugs': DRUG_NAMES}), 404
    e = dose_entry(drug, request.args.get('dose', 1))
    d = SWEEP['drugs'][drug]
    return jsonify({
        'drug': drug, 'cmax_nM': d['cmax'], 'fda_label': d['label'],
        'dose_mult': e['mult'], 'conc_nM': e['conc_nM'],
        'qNet': e['qNet'], 'qnet_mean_1_4x': d['qnet_mean'],
        'APD90': e['APD90'], 'dAPD90': e['dAPD90'],
        'repol_failure': e['repol_failure'],
        'risk': risk_for(d['qnet_mean']),
        'block': e['block'], 'peak_bound': e['peak_bound'],
        'interpolated': e.get('interpolated', False),
        'frames': e['frames'],
        'control': {'qNet': SWEEP['control']['qNet'],
                    'APD90': SWEEP['control']['APD90']},
    })


@app.post('/api/explain')
def api_explain():
    body = request.get_json(force=True, silent=True) or {}
    drug = body.get('drug', '')
    if drug not in SWEEP['drugs']:
        return jsonify({'error': f'unknown drug {drug!r}'}), 404
    e = dose_entry(drug, body.get('dose', 1))
    d = SWEEP['drugs'][drug]
    out = explain_mod.explain(
        drug=drug, dose_mult=round(float(e['mult']), 2), conc_nM=e['conc_nM'],
        block=e['block'], bound=e['peak_bound'], qnet=e['qNet'],
        dapd90=e['dAPD90'], risk=risk_for(d['qnet_mean']),
        repol_failure=e['repol_failure'])
    return jsonify(out)


@app.post('/api/context')
def api_context():
    """Two sentences orienting the viewer in the current view -- what
    they're looking at, scaled from whole heart down to a single myocyte
    (and which transmural layer, once that's selected), plus what's
    currently chosen. Narrates the VIEW; /api/explain narrates the VERDICT.
    """
    body = request.get_json(force=True, silent=True) or {}
    drug = body.get('drug', '')
    if drug not in SWEEP['drugs']:
        return jsonify({'error': f'unknown drug {drug!r}'}), 404
    stage = body.get('stage', 'heart')
    mode_label = body.get('mode_label')
    e = dose_entry(drug, body.get('dose', 1))
    d = SWEEP['drugs'][drug]
    out = explain_mod.explain_context(
        drug=drug, dose_mult=round(float(e['mult']), 2), conc_nM=e['conc_nM'],
        fda_label=d['label'], risk=risk_for(d['qnet_mean']), stage=stage,
        mode_label=mode_label)
    return jsonify(out)


@app.post('/api/narrate')
def api_narrate():
    """Gemini reads the already-computed verdict explanation aloud.

    Same hard rule as /api/explain: handed a finished sentence of English
    text and computes nothing else -- it cannot change a single number on
    the page, and generating the audio is strictly downstream of the
    simulation, never upstream of it.
    """
    body = request.get_json(force=True, silent=True) or {}
    drug = body.get('drug', '')
    if drug not in SWEEP['drugs']:
        return jsonify({'error': f'unknown drug {drug!r}'}), 404
    if not explain_mod.available():
        return jsonify({'error': 'GEMINI_API_KEY not configured'}), 503
    e = dose_entry(drug, body.get('dose', 1))
    d = SWEEP['drugs'][drug]
    text = explain_mod.explain(
        drug=drug, dose_mult=round(float(e['mult']), 2), conc_nM=e['conc_nM'],
        block=e['block'], bound=e['peak_bound'], qnet=e['qNet'],
        dapd90=e['dAPD90'], risk=risk_for(d['qnet_mean']),
        repol_failure=e['repol_failure'])['text']
    audio = explain_mod.speak(text)
    if audio is None:
        return jsonify({'error': 'narration unavailable'}), 502
    return app.response_class(audio, mimetype='audio/wav')


@app.post('/api/ask')
def api_ask():
    body = request.get_json(force=True, silent=True) or {}
    q = body.get('question', '')
    parsed = explain_mod.parse_query(q, DRUG_NAMES)
    if not parsed.get('drug'):
        return jsonify({'error': 'no compound recognised in the question',
                        'drugs': DRUG_NAMES, 'parsed': parsed}), 422
    e = dose_entry(parsed['drug'], parsed['dose_mult'])
    d = SWEEP['drugs'][parsed['drug']]
    return jsonify({
        'parsed': parsed, 'drug': parsed['drug'],
        'dose_mult': parsed['dose_mult'], 'conc_nM': e['conc_nM'],
        'qNet': e['qNet'], 'dAPD90': e['dAPD90'],
        'repol_failure': e['repol_failure'],
        'risk': risk_for(d['qnet_mean']), 'fda_label': d['label'],
    })


@app.get('/api/validation')
def api_validation():
    return jsonify(VALIDATION)


_analogue = None


def analogue():
    """RDKit is only imported if someone actually pastes a structure."""
    global _analogue
    if _analogue is None:
        from pharmacology import AnaloguePharmacology
        _analogue = AnaloguePharmacology()
    return _analogue


@app.get('/api/analogue')
def api_analogue():
    """SMILES -> nearest measured analogue -> that compound's own curve.

    The response states plainly that the numbers belong to the neighbour,
    not to the query structure. The UI must keep saying so.
    """
    smiles = request.args.get('smiles', '').strip()
    if not smiles:
        return jsonify({'error': 'no smiles given'}), 400
    try:
        p = analogue().get(smiles)
    except ValueError as e:
        return jsonify({'error': str(e)}), 422
    except ImportError:
        return jsonify({'error': 'rdkit not installed'}), 503
    d = SWEEP['drugs'][p.source_drug]
    return jsonify({
        **p.summary(),
        'ranked': p.channels.get('ranked', []),
        'drug': p.source_drug,
        'fda_label': d['label'],
        'risk': risk_for(d['qnet_mean']),
        'qnet_mean': d['qnet_mean'],
    })


@app.get('/api/trace')
def api_trace():
    """Display-resolution trace out of the Tiger Data continuous aggregate."""
    if not tiger.available():
        return jsonify({'error': 'TIGER_DSN not configured',
                        'hint': 'the page runs from the cached sweep without it'}), 503
    drug = request.args.get('drug', 'control')
    dose = float(request.args.get('dose', 1))
    res = request.args.get('res', 'display')
    try:
        return jsonify(tiger.Loader().trace(drug, dose, res))
    except Exception as e:                           # noqa: BLE001
        return jsonify({'error': str(e)}), 502


def _interp_at(ts, vs, t_ms):
    """Linear interpolation at one point, for the cached fallback below.
    frames['t'] is sorted and starts at 0, same grid for every drug."""
    t_ms = max(ts[0], min(ts[-1], t_ms))
    for i in range(1, len(ts)):
        if ts[i] >= t_ms:
            t0, t1, v0, v1 = ts[i - 1], ts[i], vs[i - 1], vs[i]
            f = 0.0 if t1 == t0 else (t_ms - t0) / (t1 - t0)
            return v0 + f * (v1 - v0)
    return vs[-1]


def _cross_drug_cached(t_ms, dose_mult):
    """Same shape as tiger.Loader.cross_drug_at, computed from the
    in-memory sweep instead of a live query. This is what the comparison
    panel shows with no TIGER_DSN configured — same feature, slower source."""
    out = []
    for name in DRUG_NAMES:
        e = dose_entry(name, dose_mult)
        out.append({'drug': name, 'dose_mult': dose_mult,
                    'V': round(_interp_at(e['frames']['t'], e['frames']['V'],
                                          t_ms), 3)})
    return out


@app.get('/api/tiger/cross-drug')
def api_cross_drug():
    """Every compound's membrane potential at one instant: the query a
    relational-blob design makes painful, run live against the hypertable.
    Falls back to the identical shape computed from the cached sweep when
    Tiger Data isn't configured, or when the requested dose/time has no
    matching run loaded — same feature either way, the UI just says which
    source answered."""
    t = float(request.args.get('t', 300))
    dose = float(request.args.get('dose', 4))
    if tiger.available():
        try:
            rows = tiger.Loader().cross_drug_at(t, dose)
        except Exception as e:                       # noqa: BLE001
            rows = None
        if rows:
            return jsonify({'source': 'tiger', 't': t, 'dose_mult': dose,
                            'drugs': rows})
    return jsonify({'source': 'cache', 't': t, 'dose_mult': dose,
                    'drugs': _cross_drug_cached(t, dose)})


@app.get('/')
def index():
    return send_from_directory(app.static_folder, 'index.html')


@app.get('/<path:path>')
def static_files(path):
    return send_from_directory(app.static_folder, path)


if __name__ == '__main__':
    print(f'sweep: {SWEEP_PATH}  '
          f'({len(SWEEP["drugs"])} compounds, '
          f'{SWEEP["meta"]["prepace_beats"]} pre-paced beats)')
    print(f'qNet classifier: {QNET["correct"]}/{QNET["n"]}  '
          f'thresholds {QNET["t_high"]:.4f} / {QNET["t_low"]:.4f} uC/uF')
    print(f'tiger: {"connected" if tiger.available() else "not configured"}   '
          f'gemini: {"enabled" if explain_mod.available() else "template fallback"}')
    app.run(host='0.0.0.0', port=int(os.environ.get('PORT', 5000)),
            debug=False, threaded=True)
