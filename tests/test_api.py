"""API-level tests, including the offline fallbacks.

The fallbacks matter more than they look: conference wifi and rate limits are
the two things most likely to break a live demo, and both of these paths are
what the demo falls back to.
"""
import os
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

pytestmark = pytest.mark.skipif(
    not os.path.exists(os.path.join(ROOT, 'data', 'sweep.json')),
    reason='run sweep.py first')


@pytest.fixture(scope='module')
def client():
    import app
    app.app.config['TESTING'] = True
    return app.app.test_client()


def test_drugs_listing(client):
    rows = client.get('/api/drugs').get_json()
    assert len(rows) == 12
    assert all(r['predicted'] == r['fda_label'] for r in rows)


def test_run_at_a_simulated_dose(client):
    j = client.get('/api/run?drug=dofetilide&dose=4').get_json()
    assert j['interpolated'] is False
    assert j['dAPD90'] == pytest.approx(126.5, abs=0.5)
    assert j['peak_bound'] == pytest.approx(0.530, abs=5e-3)
    assert j['risk'] == 'HIGH'


def test_intermediate_dose_is_labelled_as_interpolated(client):
    """The slider is continuous but only integer multiples were solved. An
    interpolated point must never be presented as a simulated one."""
    j = client.get('/api/run?drug=dofetilide&dose=2.4').get_json()
    assert j['interpolated'] is True
    lo = client.get('/api/run?drug=dofetilide&dose=2').get_json()
    hi = client.get('/api/run?drug=dofetilide&dose=3').get_json()
    assert lo['qNet'] >= j['qNet'] >= hi['qNet']


def test_dose_zero_is_the_control_run(client):
    j = client.get('/api/run?drug=quinidine&dose=0').get_json()
    assert j['qNet'] == pytest.approx(0.0781, abs=5e-4)
    assert max(j['frames']['hERG_bound']) == 0.0


def test_repolarisation_failure_travels_as_null_not_nan(client):
    """NaN is not valid JSON. If this regresses the page breaks on the single
    most dramatic compound in the set."""
    j = client.get('/api/run?drug=quinidine&dose=4').get_json()
    assert j['repol_failure'] is True
    assert j['APD90'] is None and j['dAPD90'] is None


def test_unknown_drug_is_a_404(client):
    assert client.get('/api/run?drug=paracetamol&dose=1').status_code == 404


def test_explanation_falls_back_without_an_api_key(client, monkeypatch):
    monkeypatch.delenv('GEMINI_API_KEY', raising=False)
    j = client.post('/api/explain',
                    json={'drug': 'quinidine', 'dose': 4}).get_json()
    assert j['source'] == 'template'
    assert 'hERG' in j['text'] and 'repolarise' in j['text']


def test_nl_query_regex_fallback_reads_the_multiplier(client):
    """'twice the normal dose' contains both 'twice' and 'normal'; the
    explicit multiplier has to win."""
    j = client.post('/api/ask', json={
        'question': 'is terfenadine safe at twice the normal dose?'}).get_json()
    assert j['drug'] == 'terfenadine'
    assert j['dose_mult'] == 2
    assert j['parsed']['source'] == 'regex'


@pytest.mark.parametrize('q,drug,dose', [
    ('how risky is quinidine at 4x cmax', 'quinidine', 4),
    ('dofetilide at three times the therapeutic concentration', 'dofetilide', 3),
    ('verapamil', 'verapamil', 1),
])
def test_nl_query_variants(client, q, drug, dose):
    j = client.post('/api/ask', json={'question': q}).get_json()
    assert (j['drug'], j['dose_mult']) == (drug, dose)


def test_question_with_no_compound_is_rejected(client):
    r = client.post('/api/ask', json={'question': 'what about ibuprofen?'})
    assert r.status_code == 422


def test_tiger_routes_degrade_without_a_dsn(client, monkeypatch):
    monkeypatch.delenv('TIGER_DSN', raising=False)
    assert client.get('/api/trace?drug=dofetilide&dose=1').status_code == 503


def test_analogue_lookup(client):
    pytest.importorskip('rdkit')
    j = client.get('/api/analogue?smiles=CC(=O)Oc1ccccc1C(=O)O').get_json()
    assert j['provenance'] == 'nearest-analogue'
    assert 'nearest measured analogue' in j['note']
    assert len(j['ranked']) == 3


def test_malformed_smiles_is_a_422(client):
    pytest.importorskip('rdkit')
    assert client.get('/api/analogue?smiles=not-a-molecule').status_code == 422


def test_validation_payload_matches_the_page_claims(client):
    v = client.get('/api/validation').get_json()
    assert v['qnet']['correct'] == 12
    assert v['dapd90']['correct'] == 10
    assert 'separability' in v['disclaimer']


def test_demo_environment_gate(monkeypatch):
    from app import app
    client = app.test_client()
    monkeypatch.delenv('TORSADE_DEMO_ENABLED', raising=False)
    assert client.get('/api/sweep').json['demo_enabled'] is False
    monkeypatch.setenv('TORSADE_DEMO_ENABLED', '1')
    assert client.get('/api/sweep').json['demo_enabled'] is True
