"""Tests for the layers above the engine: sweep output, classifier, chemistry.

These run against the committed sweep.json and need no simulation, so they
are fast enough to run on every change.
"""
import json
import os
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import classifier  # noqa: E402
from sweep import REFERENCE  # noqa: E402

SWEEP_PATH = os.path.join(ROOT, 'data', 'sweep.json')
pytestmark = pytest.mark.skipif(not os.path.exists(SWEEP_PATH),
                                reason='run sweep.py first')


@pytest.fixture(scope='module')
def sweep():
    with open(SWEEP_PATH) as f:
        return json.load(f)


@pytest.fixture(scope='module')
def validation(sweep):
    return classifier.build(sweep)


def test_control_matches_reference(sweep):
    assert round(sweep['control']['qNet'], 4) == 0.0781
    assert round(sweep['control']['APD90'], 1) == 277.2


@pytest.mark.parametrize('drug', sorted(REFERENCE))
def test_sweep_row_matches_reference(sweep, drug):
    """Every row of §3, reproduced. This is the correctness test for the
    whole pipeline, not just for one drug."""
    ref_qnet, ref_d1, ref_d4 = REFERENCE[drug]
    e = sweep['drugs'][drug]
    assert e['qnet_mean'] == pytest.approx(ref_qnet, abs=5e-4)
    assert e['doses'][0]['dAPD90'] == pytest.approx(ref_d1, abs=0.5)
    if ref_d4 is None:
        assert e['doses'][3]['repol_failure'], 'expected repolarisation failure'
        assert e['doses'][3]['dAPD90'] is None
    else:
        assert e['doses'][3]['dAPD90'] == pytest.approx(ref_d4, abs=0.5)


def test_qnet_classifier_separates_all_twelve(validation):
    q = validation['qnet']
    assert (q['correct'], q['n']) == (12, 12)
    assert round(q['t_high'], 4) == 0.0663
    assert round(q['t_low'], 4) == 0.0784


def test_dapd90_is_the_weaker_classifier(validation):
    """10/12 is the honest number, and showing where dAPD90 fails is the
    argument for building the classifier on qNet instead."""
    d = validation['dapd90']
    assert d['correct'] == 10
    assert round(d['t_high'], 1) == 80.1
    assert round(d['t_low'], 1) == 31.9
    missed = {x['name'] for x in validation['drugs']
              if x['pred_dapd90'] != x['true']}
    assert missed == {'ranolazine', 'verapamil'}


def test_frames_are_complete(sweep):
    expected = {'t', 'V', 'Ca_i', 'INa', 'INaL', 'ICaL', 'Ito', 'IKr', 'IKs',
                'IK1', 'hERG_open', 'hERG_bound'}
    for name, drug in sweep['drugs'].items():
        for dose in drug['doses']:
            f = dose['frames']
            assert expected <= set(f), f'{name} {dose["mult"]}x missing signals'
            assert all(len(f[k]) == len(f['t']) for k in expected)


def test_drug_free_channels_are_never_bound(sweep):
    assert max(sweep['control']['frames']['hERG_bound']) == 0.0


def test_dofetilide_bound_fraction_is_the_demo_number(sweep):
    """Over half the hERG channels occupied at 4x Cmax — the claim made on
    stage, so it is worth a test."""
    assert sweep['drugs']['dofetilide']['doses'][3]['peak_bound'] == \
        pytest.approx(0.530, abs=5e-3)


def test_signal_ranges_match_the_renderer_bounds(sweep):
    """The renderer hard-codes these normalisation bounds. If a run falls
    outside them the colour ramp silently clips."""
    vmin, vmax, camin, camax = 1e9, -1e9, 1e9, -1e9
    for drug in sweep['drugs'].values():
        for dose in drug['doses']:
            f = dose['frames']
            vmin, vmax = min(vmin, min(f['V'])), max(vmax, max(f['V']))
            camin = min(camin, min(f['Ca_i']))
            camax = max(camax, max(f['Ca_i']))
    assert vmin >= -92 and vmax <= 50
    assert camin >= 5e-5 and camax <= 2.6e-4


@pytest.fixture(scope='module')
def analogue():
    pytest.importorskip('rdkit')
    from pharmacology import AnaloguePharmacology
    return AnaloguePharmacology()


class TestChemistry:
    def test_every_structure_is_the_right_compound(self, analogue):
        """A mistyped SMILES would silently return the wrong neighbour."""
        assert analogue.verify_structures() == []

    def test_pasting_a_known_compound_recovers_its_own_curve(self, analogue):
        from pharmacology import SMILES
        for name, smi in SMILES.items():
            p = analogue.get(smi)
            assert p.source_drug == name
            assert p.similarity == 1.0
            assert p.provenance == 'measured'

    def test_an_unrelated_molecule_is_labelled_as_an_analogue(self, analogue):
        p = analogue.get('CC(=O)Oc1ccccc1C(=O)O')       # aspirin
        assert p.provenance == 'nearest-analogue'
        assert p.similarity < 0.5
        assert 'nearest measured analogue' in p.note
