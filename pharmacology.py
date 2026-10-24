"""Module 1: the pharmacology adapter.

Everything downstream of this module is identical regardless of where the
IC50s came from. That is the whole point of the interface, and it is what
lets the UI show "measured" and "nearest analogue" side by side without a
second pipeline.

Two implementations:

  MeasuredPharmacology   direct lookup in Li2017_IC50.csv + pars.txt.
                         The 12 CiPA training compounds. This is Tier 1.

  AnaloguePharmacology   RDKit Morgan fingerprint -> Tanimoto nearest
                         neighbour among the compounds that have a complete
                         measured parameter set; borrow that neighbour's
                         IC50s and report both it and the similarity score.

A third option — a trained hERG classifier — is deliberately not implemented.
The popular public hERG models (ADMET-AI's head, TDC's hERG_Karim) are binary
blocker/non-blocker classifiers, and the simulator needs an IC50 in nM per
channel. Turning a probability into a pseudo-IC50 would inject a fabricated
number into an otherwise mechanistic pipeline, and it would be indefensible
precisely where this project is strongest. Nearest measured analogue is
weaker on paper and honest about what it is.
"""
from dataclasses import dataclass, field
from typing import Optional

from engine import CHAN, hill_block, load_ground_truth

# SMILES for the 12 CiPA training compounds. Only these 12 have both a
# complete Li2017 IC50 row and fitted dynamic hERG binding parameters, so
# only these 12 can serve as an analogue: borrowing from a compound whose
# own parameters we do not have would be borrowing nothing.
#
# MW_CHECK guards against a transcription error in the SMILES above it —
# a wrong structure here would silently return the wrong neighbour.
SMILES = {
    'quinidine':      'COc1ccc2nccc([C@@H](O)[C@H]3C[C@@H]4CCN3C[C@@H]4C=C)c2c1',
    'bepridil':       'CC(C)COCC(CN(Cc1ccccc1)c1ccccc1)N1CCCC1',
    'dofetilide':     'CS(=O)(=O)Nc1ccc(CCN(C)CCOc2ccc(NS(C)(=O)=O)cc2)cc1',
    'sotalol':        'CC(C)NCC(O)c1ccc(NS(C)(=O)=O)cc1',
    'chlorpromazine': 'CN(C)CCCN1c2ccccc2Sc2ccc(Cl)cc21',
    'cisapride':      'COc1cc(C(=O)NC2CCN(CCCOc3ccc(F)cc3)CC2OC)c(N)cc1Cl',
    'terfenadine':    'CC(C)(C)c1ccc(C(O)CCCN2CCC(C(O)(c3ccccc3)c3ccccc3)CC2)cc1',
    'ondansetron':    'Cc1nccn1CC1CCc2c(c3ccccc3n2C)C1=O',
    'diltiazem':      'COc1ccc(C2Sc3ccccc3N(CCN(C)C)C(=O)C2OC(C)=O)cc1',
    'mexiletine':     'CC(N)COc1c(C)cccc1C',
    'ranolazine':     'COc1ccccc1OCC(O)CN1CCN(CC(=O)Nc2c(C)cccc2C)CC1',
    'verapamil':      'COc1ccc(CCN(C)CCCC(C#N)(C(C)C)c2ccc(OC)c(OC)c2)cc1OC',
}

MW_CHECK = {
    'quinidine': 324.4, 'bepridil': 366.5, 'dofetilide': 441.6,
    'sotalol': 272.4, 'chlorpromazine': 318.9, 'cisapride': 466.0,
    'terfenadine': 471.7, 'ondansetron': 293.4, 'diltiazem': 414.5,
    'mexiletine': 179.3, 'ranolazine': 427.5, 'verapamil': 454.6,
}


@dataclass
class ChannelPharmacology:
    """What the engine needs, and where it came from."""
    name: str
    ic50_row: dict                       # {<CH>_IC50, <CH>_h} in nM
    herg_pars: dict                      # {Kmax, Ku, n, halfmax, Vhalf}
    cmax_nM: Optional[float] = None
    provenance: str = 'measured'         # measured | nearest-analogue
    source_drug: Optional[str] = None
    similarity: Optional[float] = None
    note: str = ''
    channels: dict = field(default_factory=dict)

    def block_at(self, conc_nM):
        return hill_block(self.ic50_row, conc_nM)

    def summary(self):
        return {'name': self.name, 'provenance': self.provenance,
                'source_drug': self.source_drug, 'similarity': self.similarity,
                'cmax_nM': self.cmax_nM, 'note': self.note,
                'ic50_nM': {ch: self.ic50_row.get(f'{ch}_IC50')
                            for ch in CHAN},
                'herg': self.herg_pars}


class MeasuredPharmacology:
    def __init__(self):
        self.drugs, self.ic50, self.herg = load_ground_truth()

    def names(self):
        return sorted(self.drugs)

    def get(self, name):
        if name not in self.drugs:
            raise KeyError(f'no measured data for {name!r}')
        return ChannelPharmacology(
            name=name, ic50_row=self.ic50[name], herg_pars=self.herg[name],
            cmax_nM=self.drugs[name]['cmax'], provenance='measured',
            source_drug=name, similarity=1.0,
            note='Measured patch-clamp IC50s (Li et al. 2017) and FDA-fitted '
                 'dynamic hERG binding parameters.')


class AnaloguePharmacology:
    """Nearest measured analogue by Morgan fingerprint Tanimoto similarity."""

    def __init__(self, radius=2, n_bits=2048):
        from rdkit import Chem, RDLogger
        from rdkit.Chem import rdFingerprintGenerator
        RDLogger.DisableLog('rdApp.*')
        self._Chem = Chem
        self.measured = MeasuredPharmacology()
        self.gen = rdFingerprintGenerator.GetMorganGenerator(
            radius=radius, fpSize=n_bits)
        self.library = {}
        for name, smi in SMILES.items():
            mol = Chem.MolFromSmiles(smi)
            if mol is None:
                raise ValueError(f'bad SMILES for {name}')
            self.library[name] = self.gen.GetFingerprint(mol)

    def verify_structures(self, tol=1.5):
        """Catch a mistyped SMILES before it silently returns the wrong
        neighbour. Returns the list of compounds whose molecular weight
        disagrees with the published value."""
        from rdkit.Chem import Descriptors
        bad = []
        for name, smi in SMILES.items():
            mw = Descriptors.MolWt(self._Chem.MolFromSmiles(smi))
            if abs(mw - MW_CHECK[name]) > tol:
                bad.append((name, round(mw, 1), MW_CHECK[name]))
        return bad

    def rank(self, smiles, top=3):
        from rdkit import DataStructs
        mol = self._Chem.MolFromSmiles(smiles)
        if mol is None:
            raise ValueError('could not parse SMILES')
        fp = self.gen.GetFingerprint(mol)
        scored = [(name, DataStructs.TanimotoSimilarity(fp, ref))
                  for name, ref in self.library.items()]
        scored.sort(key=lambda kv: -kv[1])
        return scored[:top]

    def get(self, smiles, label=None):
        ranked = self.rank(smiles)
        best, sim = ranked[0]
        base = self.measured.get(best)
        exact = sim >= 0.999
        return ChannelPharmacology(
            name=label or (best if exact else f'query ({smiles[:28]})'),
            ic50_row=base.ic50_row, herg_pars=base.herg_pars,
            cmax_nM=base.cmax_nM,
            provenance='measured' if exact else 'nearest-analogue',
            source_drug=best, similarity=round(sim, 3),
            note=('Exact structural match to a measured compound.' if exact else
                  f'No measured data for this compound. Using nearest '
                  f'measured analogue: {best}, Tanimoto {sim:.2f}. '
                  f'The channel block below is {best}’s, not this '
                  f'compound’s.'),
            channels={'ranked': [{'drug': n, 'tanimoto': round(s, 3)}
                                 for n, s in ranked]})


if __name__ == '__main__':
    ap = AnaloguePharmacology()
    bad = ap.verify_structures()
    print('structure check:', 'all 12 OK' if not bad else f'MISMATCH {bad}')
    for smi, lab in [(SMILES['terfenadine'], 'terfenadine (exact)'),
                     ('CC(C)(C)c1ccc(C(O)CCCN2CCC(C(=O)O)CC2)cc1',
                      'fexofenadine-like fragment'),
                     ('CC(=O)Oc1ccccc1C(=O)O', 'aspirin')]:
        p = ap.get(smi)
        print(f'{lab:34s} -> {p.source_drug:15s} T={p.similarity:.3f}  '
              f'{p.provenance}')
