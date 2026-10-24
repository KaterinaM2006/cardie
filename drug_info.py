"""Clinical reference data for the 12 CiPA training compounds.

Static and hand-curated — unlike everything else in the pipeline, nothing
here comes out of a simulation. This exists because the rest of the app
answers "how much does this molecule block which channels" but never answers
the much more basic question a person asks first: what is this drug, and
why would anyone take it. The numerical path in engine.py/pharmacology.py
is untouched by any of this.

Sources: FDA drug labels / DailyMed for indication and regulatory status;
Colatsky et al. 2016 and Li et al. 2017 (the CiPA papers) for why several of
these compounds are the field's standard teaching cases.
"""

DRUG_INFO = {
    'dofetilide': {
        'drug_class': 'Class III antiarrhythmic',
        'use': 'Cardioversion and maintenance of sinus rhythm in atrial '
               'fibrillation/flutter.',
        'mechanism': 'Selective IKr (hERG) blocker — this is its intended '
                      'mechanism of action, not a side effect.',
        'status': 'FDA-approved. Carries a black-box QT warning; requires '
                   'in-hospital initiation with continuous ECG monitoring.',
    },
    'quinidine': {
        'drug_class': 'Class Ia antiarrhythmic',
        'use': 'Historically used for atrial fibrillation and ventricular '
               'arrhythmias.',
        'mechanism': 'Blocks fast INa and IKr together — the combination '
                      'that makes it the textbook example of drug-induced '
                      'torsade.',
        'status': 'Largely superseded by safer agents due to its '
                   'proarrhythmic risk; rarely first-line today.',
    },
    'bepridil': {
        'drug_class': 'Calcium channel blocker',
        'use': 'Formerly used for chronic stable angina.',
        'mechanism': 'Blocks L-type calcium current alongside hERG.',
        'status': 'Withdrawn from most markets after post-marketing reports '
                   'of QT prolongation and torsade de pointes.',
    },
    'sotalol': {
        'drug_class': 'Class III antiarrhythmic (with Class II / '
                       'beta-blocking activity)',
        'use': 'Ventricular arrhythmias and maintenance of sinus rhythm in '
               'atrial fibrillation.',
        'mechanism': 'Blocks IKr; the beta-blockade is a separate, '
                      'unrelated action of the same molecule.',
        'status': 'FDA-approved. Requires dose-adjusted initiation with ECG '
                   'monitoring for the same reason as dofetilide.',
    },
    'chlorpromazine': {
        'drug_class': 'Typical (first-generation) antipsychotic, '
                       'phenothiazine class',
        'use': 'Schizophrenia and other psychotic disorders; historically '
               'also used for severe nausea.',
        'mechanism': 'Primarily a dopamine D2 antagonist; hERG block is an '
                      'off-target effect unrelated to its intended action.',
        'status': 'FDA-approved, still in use. QT prolongation is a known, '
                   'monitored risk rather than a reason for withdrawal.',
    },
    'cisapride': {
        'drug_class': 'Gastroprokinetic agent',
        'use': 'Formerly used for GERD and gastroparesis.',
        'mechanism': '5-HT4 receptor agonist for its intended effect; '
                      'potent off-target hERG block turned out to be the '
                      'problem.',
        'status': 'Withdrawn from most markets in 1999–2000 after fatal '
                   'arrhythmias; one of the drugs that motivated the CiPA '
                   'initiative itself.',
    },
    'terfenadine': {
        'drug_class': 'Second-generation antihistamine (H1 antagonist)',
        'use': 'Was used for seasonal allergies; its active metabolite, '
               'fexofenadine, is still sold (as Allegra) and does not '
               'block hERG.',
        'mechanism': 'The parent compound is a potent hERG blocker, but is '
                      'normally cleared so fast by CYP3A4 that little '
                      'reaches the heart.',
        'status': 'Withdrawn in 1998 after torsade cases in patients taking '
                   'CYP3A4 inhibitors (e.g. ketoconazole, grapefruit juice) '
                   'that let the parent drug accumulate — a textbook '
                   'drug-interaction case, not a dosing error.',
    },
    'ondansetron': {
        'drug_class': '5-HT3 receptor antagonist',
        'use': 'Antiemetic for chemotherapy- and surgery-induced nausea.',
        'mechanism': 'Blocks serotonin receptors in the gut and brainstem '
                      'for its intended effect; hERG block is off-target.',
        'status': 'FDA-approved, widely used. Carries a labeled warning '
                   'against high-dose IV use because of QT prolongation.',
    },
    'diltiazem': {
        'drug_class': 'Calcium channel blocker (benzothiazepine)',
        'use': 'Hypertension, angina, and some supraventricular '
               'arrhythmias.',
        'mechanism': 'Blocks L-type calcium current (ICaL); minimal direct '
                      'hERG block.',
        'status': 'FDA-approved, widely used. Low torsade risk in clinical '
                   'practice.',
    },
    'mexiletine': {
        'drug_class': 'Class Ib antiarrhythmic',
        'use': 'Ventricular arrhythmias, and as an adjunct treatment in '
               'congenital long-QT syndrome type 3.',
        'mechanism': 'Blocks sodium current (INa); this is why, unusually, '
                      'it can shorten rather than prolong the action '
                      'potential.',
        'status': 'FDA-approved. Low torsade risk — one reason it is used '
                   '*to treat* a different kind of long-QT syndrome.',
    },
    'ranolazine': {
        'drug_class': 'Anti-anginal',
        'use': 'Chronic stable angina.',
        'mechanism': 'Inhibits the late sodium current (INaL) as its '
                      'intended effect, while also blocking IKr off-target '
                      '— the two actions partly cancel in their effect on '
                      'repolarisation.',
        'status': 'FDA-approved. Known CiPA outlier: it measurably '
                   'prolongs QT without the torsade risk that ΔAPD90 alone '
                   'would predict, which is why qNet (not ΔAPD90) is the '
                   'metric this project leads with.',
    },
    'verapamil': {
        'drug_class': 'Calcium channel blocker (phenylalkylamine)',
        'use': 'Hypertension, angina, and supraventricular arrhythmias.',
        'mechanism': 'Blocks both ICaL and hERG at similar concentrations; '
                      'the calcium block offsets the potassium block.',
        'status': 'FDA-approved, widely used. The other classic CiPA '
                   'outlier: it blocks hERG yet carries low torsade risk '
                   'in practice, for the same reason as above.',
    },
}


def get(name):
    return DRUG_INFO.get(name)
