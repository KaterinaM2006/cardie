"""One-off: load native-resolution runs into the Tiger Data hypertable.

Separate from sweep.py's --tiger flag so this doesn't re-pay the frames=300
UI-bundle cost (already cached in data/sweep.json) just to also get
frames=None rows into the database. Endocardial (mode 0) only, matching the
cross-drug comparison panel's own scope.
"""
import time

from dotenv import load_dotenv
load_dotenv()

from engine import Engine, load_ground_truth
import tiger

DOSES = (1, 2, 3, 4)


def main():
    drugs, ic50, herg = load_ground_truth()
    eng = Engine()
    loader = tiger.Loader()
    loader.ensure_schema()

    t0 = time.time()
    print('control...', flush=True)
    ctrl = eng.run(prepace=400, frames=None)
    loader.load_run('control', 0, 0.0, ctrl, qnet=ctrl['qNet'],
                     apd90=ctrl['APD90'])
    print(f'  qNet={ctrl["qNet"]:.4f} APD90={ctrl["APD90"]:.1f} '
          f'({time.time() - t0:.0f}s)', flush=True)

    for name in sorted(drugs, key=lambda d: -drugs[d]['cipa']):
        cmax = drugs[name]['cmax']
        for mult in DOSES:
            conc = mult * cmax
            r = eng.run(ic50[name], herg[name], conc, prepace=400, frames=None)
            loader.load_run(name, mult, conc, r, qnet=r['qNet'],
                             apd90=r['APD90'], fda_label=drugs[name]['cipa'])
            print(f'  {name:>15s} {mult}x  qNet={r["qNet"]:+.4f}  '
                  f'({time.time() - t0:.0f}s)', flush=True)

    print('compressing...', flush=True)
    stats = loader.compress_all()
    print(f'compressed {len(stats)} chunk(s)')
    print(f'done in {time.time() - t0:.0f}s total')


if __name__ == '__main__':
    main()
