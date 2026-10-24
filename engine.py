"""Electrophysiology engine: ORd-CiPA v1.0 human ventricular myocyte.

Verified against the reference table in the build brief (§3) with
myokit 1.39.2 + sundials 6.4.1.

The four traps documented in §9 are handled here:
  9.1  Simulation.pre() mutates the default state -> pristine S0 is restored
       before every run.
  9.2  ikr.D is declared [mM] but the FDA parameters are fitted in nM -> D is
       set as a plain number in nM.
  9.3  ikr.Kt defaults to 0 in the .mmt -> set to 3.5e-5 on every drug run.
  9.4  qNet integrates the Ca-carried component ical.ICaLCa, never ICaL_tot.

Every signal the renderer animates comes out of here. Nothing in the
animation is hand-tuned: membrane colour is membrane.V, contraction is
calcium.Ca_i, and the drug molecules plugging hERG are the Markov model's own
bound-state occupancies.
"""
import csv
import os

import numpy as np
import myokit

ROOT = os.path.dirname(os.path.abspath(__file__))
EXTERNAL = os.environ.get('CARDIE_EXTERNAL', os.path.join(ROOT, 'external'))

MMT = os.path.join(EXTERNAL, 'myokit-models', 'c', 'ohara-cipa-v1-2017.mmt')
CIPA = os.path.join(EXTERNAL, 'CiPA')

# Alternative engines, model-disagreement view only.
MMT_ALT = {
    'ord-cipa': MMT,
    'torord': os.path.join(EXTERNAL, 'myokit-models', 'c', 'tomek-2020.mmt'),
    'ord-2011': os.path.join(EXTERNAL, 'myokit-models', 'c', 'ohara-2011.mmt'),
}

# Six channels blocked by a static Hill equation. hERG is handled separately,
# by the dynamic Markov binding model built into the .mmt.
CHAN = {'INa': 'ina.gNa',   'INaL': 'inal.gNaL', 'Ito':  'ito.gto',
        'IKs': 'iks.gKs',   'IK1':  'ik1.gK1',   'ICaL': 'ical.PCa_base'}

# TRAP 9.4: the Ca-carried component only, never ical.ICaL_tot
QCUR = ['inal.INaL', 'ical.ICaLCa', 'ikr.IKr', 'iks.IKs', 'ik1.IK1', 'ito.Ito']

# Animation-only signals: fast sodium, the calcium transient that drives
# contraction, and the hERG Markov occupancies.
ANIM = ['ina.INa', 'calcium.Ca_i', 'ikr.O', 'ikr.Obound', 'ikr.IObound',
        'ikr.Cbound']

# Drug-free defaults for the hERG binding block
IKR_OFF = dict(Kmax=0.0, Ku=0.0, n=1.0, halfmax=1.0, Vhalf=1.0, Kt=0.0, D=0.0)

HERG_KEYS = ('Kmax', 'Ku', 'n', 'halfmax', 'Vhalf')

CIPA_LABEL = {2: 'HIGH', 1: 'INTERMEDIATE', 0: 'LOW'}

# [cell] mode in the .mmt: "The type of cell. Endo = 0, Epi = 1, Mid = 2".
# A plain literal constant (cell.mode = 1 in the file), so it is settable via
# set_constant() like any drug-block parameter -- no recompile needed to
# switch cell type. CiPA v1.0 itself validates on endocardial (0) only;
# modes 1/2 are an additive view of transmural heterogeneity, not a
# replacement for the validated single-cell classification.
MODE_LABEL = {0: 'Endocardial', 1: 'Epicardial', 2: 'Mid-myocardial (M cell)'}

# Signals written per frame, in the order the Tiger Data loader expects.
FRAME_KEYS = ('V', 'Ca_i', 'INa', 'INaL', 'ICaL', 'Ito', 'IKr', 'IKs', 'IK1',
              'hERG_open', 'hERG_bound')

_SRC = {'V': 'membrane.V', 'Ca_i': 'calcium.Ca_i', 'INa': 'ina.INa',
        'INaL': 'inal.INaL', 'ICaL': 'ical.ICaLCa', 'Ito': 'ito.Ito',
        'IKr': 'ikr.IKr', 'IKs': 'iks.IKs', 'IK1': 'ik1.IK1',
        'hERG_open': 'ikr.O'}


def load_ground_truth():
    """The FDA's own labels, IC50s and fitted hERG binding parameters."""
    drugs = {r['drug']: {'cmax': float(r['therapeutic']), 'cipa': int(r['CiPA'])}
             for r in csv.DictReader(
                 open(os.path.join(CIPA, 'AP_simulation', 'data',
                                   'CiPA_training_drugs.csv')))}
    ic50 = {r['drug']: r for r in csv.DictReader(
                 open(os.path.join(CIPA, 'Hill_fitting', 'data',
                                   'Li2017_IC50.csv')))}
    herg = {d: {k: float(v) for k, v in
                (l.split() for l in
                 open(os.path.join(CIPA, 'hERG_fitting', 'results', d,
                                   'pars.txt')))
                if k in HERG_KEYS} for d in drugs}
    return drugs, ic50, herg


def hill_block(ic50_row, conc_nM):
    """Fraction of each channel's conductance blocked at this concentration.

    Same Hill equation the simulation applies, exposed separately so the UI
    can show the per-channel block profile without re-running anything.
    """
    out = {}
    for ch in CHAN:
        v50, h = ic50_row[f'{ch}_IC50'], ic50_row[f'{ch}_h']
        if v50 not in ('NA', '') and h not in ('NA', '') and conc_nM > 0:
            out[ch] = 1.0 - 1.0 / (1.0 + (conc_nM / float(v50)) ** float(h))
        else:
            out[ch] = 0.0
    # hERG is dynamic, not Hill — reported from the simulated bound fraction.
    return out


class Engine:
    """Compile once, then vary parameters with set_constant(). Recompiling per
    drug is the difference between a 7-minute sweep and an unusable one."""

    def __init__(self, mmt=MMT, cl=2000.0):
        m = myokit.load_model(mmt)
        m.get('cell.mode').set_rhs(0)              # endocardial, as in CiPA v1.0
        self.cl = cl
        self.base_g = {v: m.get(v).eval() for v in CHAN.values()}
        self.sim = myokit.Simulation(
            m, myokit.pacing.blocktrain(period=cl, duration=0.5, offset=0))
        # TRAP 9.1: pre() overwrites the default state. Keep a pristine copy.
        self.S0 = list(self.sim.state())

    def _reset(self, mode=0):
        self.sim.set_default_state(self.S0)
        self.sim.set_state(self.S0)
        self.sim.set_time(0)
        self.sim.set_constant('cell.mode', mode)
        for var, g in self.base_g.items():
            self.sim.set_constant(var, g)
        for k, v in IKR_OFF.items():
            self.sim.set_constant('ikr.' + k, v)

    def run(self, ic50_row=None, herg_pars=None, conc_nM=0.0, prepace=400,
            frames=300, mode=0):
        """Run one analysed beat after `prepace` pre-paced beats.

        frames=300 returns a browser-sized animation bundle on a uniform grid.
        frames=None keeps myokit's native adaptive steps (~600-750 samples),
        which is what gets written to the Tiger Data hypertable.

        mode: 0 (endocardial, the CiPA v1.0 default and the only mode the
        qNet classifier is validated against), 1 (epicardial) or 2
        (mid-myocardial / M cell). Each starts prepacing from the same
        pristine S0 and converges to its own periodic steady state, the same
        way different drugs already do.
        """
        self._reset(mode)
        if herg_pars is not None and conc_nM > 0:
            for k, v in herg_pars.items():
                self.sim.set_constant('ikr.' + k, v)
            self.sim.set_constant('ikr.Kt', 3.5e-5)   # TRAP 9.3: zero in the .mmt
            self.sim.set_constant('ikr.D', conc_nM)   # TRAP 9.2: nM, despite the [mM] label
            for ch, var in CHAN.items():
                v50, h = ic50_row[f'{ch}_IC50'], ic50_row[f'{ch}_h']
                if v50 not in ('NA', '') and h not in ('NA', ''):
                    # FDA get_pars.R applies this as a DIVISOR
                    fc = 1.0 + (conc_nM / float(v50)) ** float(h)
                    self.sim.set_constant(var, self.base_g[var] / fc)

        self.sim.pre(self.cl * prepace)
        d, apds = self.sim.run(self.cl,
                               log=['engine.time', 'membrane.V'] + QCUR + ANIM,
                               apd_variable='membrane.V', apd_threshold=-60)

        t = np.asarray(d['engine.time'])
        net = sum(np.asarray(d[c]) for c in QCUR)
        # A/F * ms -> uC/uF
        qnet = float(np.trapezoid(net, t) / 1000.0)
        # NaN means repolarisation failure. Render it, do not crash on it.
        apd = float(apds['duration'][0]) if len(apds['duration']) else float('nan')

        # Every drug-occupied hERG state: open-bound, inactivated-bound, and
        # the closed/trapped state that gives the high-risk compounds their
        # characteristic accumulation.
        bound = (np.asarray(d['ikr.Obound']) + np.asarray(d['ikr.IObound'])
                 + np.asarray(d['ikr.Cbound']))

        if frames:
            grid = np.linspace(t[0], t[-1], frames)
            def res(src):
                return np.interp(grid, t, np.asarray(d[src])).round(5).tolist()
            bundle = {k: res(_SRC[k]) for k in FRAME_KEYS if k in _SRC}
            bundle['hERG_bound'] = np.interp(grid, t, bound).round(5).tolist()
            bundle['t'] = (grid - grid[0]).round(2).tolist()
        else:
            bundle = {k: np.asarray(d[src]) for k, src in _SRC.items()}
            bundle['hERG_bound'] = bound
            bundle['t'] = t - t[0]

        return {'qNet': qnet, 'APD90': apd, 'frames': bundle}


if __name__ == '__main__':
    drugs, ic50, herg = load_ground_truth()
    eng = Engine()
    c = eng.run()
    print(f"control qNet={c['qNet']:.4f} APD90={c['APD90']:.1f}")
    #   control qNet=0.0781 APD90=277.2
    d = eng.run(ic50['dofetilide'], herg['dofetilide'], 8.0)     # 4x Cmax
    print(f"dofetilide 4x dAPD90={d['APD90'] - c['APD90']:+.1f} "
          f"bound={max(d['frames']['hERG_bound']):.3f}")
    #   dofetilide 4x dAPD90=+126.5 bound=0.530
