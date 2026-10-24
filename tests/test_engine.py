"""Regression tests for the engine.

test_state_isolation catches trap 8.1, which is otherwise invisible: pre()
overwrites the simulation's default state, so without an explicit restore the
runs contaminate each other and a sweep reports numbers that depend on
execution order.
"""
import math
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from engine import Engine, load_ground_truth  # noqa: E402


@pytest.fixture(scope='module')
def ground_truth():
    return load_ground_truth()


@pytest.fixture(scope='module')
def eng():
    return Engine()


def test_state_isolation(eng, ground_truth):
    _, ic50, herg = ground_truth
    a = eng.run(prepace=100)['qNet']
    eng.run(ic50['quinidine'], herg['quinidine'], 3237.0, prepace=100)
    b = eng.run(prepace=100)['qNet']
    assert abs(a - b) < 1e-9, f'state leaked between runs: {a} vs {b}'


def test_control_beat(eng):
    """The reference numbers from §3. If these drift, the pipeline is wrong."""
    ctrl = eng.run()
    assert round(ctrl['qNet'], 4) == 0.0781
    assert round(ctrl['APD90'], 1) == 277.2


def test_dofetilide_is_wired_to_herg(eng, ground_truth):
    """Dofetilide is the sharpest test: a pure hERG blocker, so a broken
    dynamic-binding wiring (traps 8.2 / 8.3) shows here and nowhere else."""
    _, ic50, herg = ground_truth
    ctrl = eng.run()
    r = eng.run(ic50['dofetilide'], herg['dofetilide'], 2.0)
    assert round(r['APD90'] - ctrl['APD90'], 1) == 34.9


def test_repolarisation_failure_is_nan_not_a_crash(eng, ground_truth):
    """Quinidine at 4x Cmax fails to repolarise. That is the model being
    correct, not a bug — but it must surface as NaN, not an exception."""
    _, ic50, herg = ground_truth
    r = eng.run(ic50['quinidine'], herg['quinidine'], 4 * 3237.0)
    assert math.isnan(r['APD90'])
