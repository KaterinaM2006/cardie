// Shared scenario defaults. No DOM, network or scientific calculations.
export const DEMO = {
  start: { drug: 'dofetilide', dose: 1 },
  combined: { id: 'dofetilide-verapamil-2x-illustration', source: 'illustrative_combination',
    // Bounded artistic timing, not an estimate of the pair's pharmacology.
    recoveryFraction: 0.42, label: 'Illustrative combined scenario — not a validated drug-interaction prediction.' },
};
