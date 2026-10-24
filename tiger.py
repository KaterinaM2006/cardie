"""Tiger Data (TimescaleDB) loader for the simulated traces.

The core data here genuinely is time-series: millisecond-resolution membrane
potential, calcium and seven ionic currents, per drug, per dose. Simulation
time is an integer offset within the beat rather than a wall clock, so the
hypertable uses an integer time column natively instead of faking timestamps.

Raw native-resolution samples go into the hypertable (~600-750 per run); the
300-frame bundle is for the browser only. That is what makes the compression
ratio worth quoting.

Everything here degrades to a no-op when TIGER_DSN is unset, so the demo
never depends on the database being reachable.
"""
import io
import os

SCHEMA = """
CREATE TABLE IF NOT EXISTS sim_run (
    run_id     SERIAL PRIMARY KEY,
    drug       TEXT NOT NULL,
    dose_mult  REAL NOT NULL,
    conc_nm    REAL NOT NULL,
    model      TEXT NOT NULL DEFAULT 'ord-cipa-v1',
    qnet       DOUBLE PRECISION,
    apd90      DOUBLE PRECISION,
    fda_label  SMALLINT,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ap_sample (
    t_us        BIGINT NOT NULL,          -- microseconds since beat start
    run_id      INTEGER NOT NULL REFERENCES sim_run(run_id),
    v           REAL,  ca_i       REAL,
    i_na        REAL,  i_nal      REAL,  i_cal  REAL,
    i_to        REAL,  i_kr       REAL,  i_ks   REAL,  i_k1 REAL,
    herg_open   REAL,  herg_bound REAL
);

SELECT create_hypertable('ap_sample', by_range('t_us', 100000),
                         if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS ap_sample_run_t ON ap_sample (run_id, t_us DESC);
"""

CAGG = """
CREATE MATERIALIZED VIEW IF NOT EXISTS ap_display
WITH (timescaledb.continuous) AS
SELECT run_id,
       time_bucket(10000, t_us) AS bucket,     -- 10 ms buckets
       avg(v) AS v, avg(ca_i) AS ca_i,
       avg(herg_open) AS herg_open, avg(herg_bound) AS herg_bound,
       min(v) AS v_min, max(v) AS v_max
FROM ap_sample GROUP BY run_id, bucket;
"""

COMPRESS = """
ALTER TABLE ap_sample SET (timescaledb.compress,
                           timescaledb.compress_segmentby = 'run_id',
                           timescaledb.compress_orderby   = 't_us');
"""

COLUMNS = ('t_us', 'run_id', 'v', 'ca_i', 'i_na', 'i_nal', 'i_cal', 'i_to',
           'i_kr', 'i_ks', 'i_k1', 'herg_open', 'herg_bound')

# Frame-bundle key per database column, in COPY order after t_us/run_id.
SIGNALS = ('V', 'Ca_i', 'INa', 'INaL', 'ICaL', 'Ito', 'IKr', 'IKs', 'IK1',
           'hERG_open', 'hERG_bound')

# The demo query: every compound's membrane potential at one instant. One
# clean statement against the hypertable, and exactly the query a
# relational-blob design makes painful.
CROSS_DRUG_AT_T = """
SELECT r.drug, r.dose_mult, s.v
FROM ap_sample s JOIN sim_run r USING (run_id)
WHERE s.t_us BETWEEN %(t_us)s - 2000 AND %(t_us)s + 2000
  AND r.dose_mult = %(dose)s
ORDER BY s.v;
"""


def dsn():
    return os.environ.get('TIGER_DSN')


def available():
    if not dsn():
        return False
    try:
        import psycopg2  # noqa: F401
    except ImportError:
        return False
    return True


class Loader:
    def __init__(self, conn_str=None):
        import psycopg2
        self.conn = psycopg2.connect(conn_str or dsn())

    def ensure_schema(self):
        with self.conn, self.conn.cursor() as cur:
            cur.execute(SCHEMA)

        # CREATE MATERIALIZED VIEW ... WITH (timescaledb.continuous) and
        # compression DDL both refuse to run inside a transaction block.
        # autocommit, restored after, is the correct way to run them --
        # not a license-tier failure, the earlier bare `with self.conn` was
        # just the wrong transaction scope for DDL that can't be batched.
        prev_autocommit = self.conn.autocommit
        self.conn.autocommit = True
        try:
            try:
                with self.conn.cursor() as cur:
                    cur.execute(CAGG)
            except Exception as e:                   # noqa: BLE001
                # Integer-time hypertables need a registered "now" function
                # for continuous aggregates; this schema's time column is
                # per-run relative time, not a global clock, so there isn't
                # a sensible one to register. The raw hypertable (and every
                # query this app actually makes) works fine without it.
                print(f'tiger: continuous aggregate skipped ({e})')
            try:
                with self.conn.cursor() as cur:
                    cur.execute(COMPRESS)
            except Exception as e:                   # noqa: BLE001
                print(f'tiger: compression skipped ({e})')
        finally:
            self.conn.autocommit = prev_autocommit

    def load_run(self, drug, dose_mult, conc_nM, run, qnet=None, apd90=None,
                 fda_label=None):
        """COPY one run's native-resolution samples into the hypertable.

        Bulk COPY, never row-by-row inserts: a sweep is hundreds of thousands
        of rows and execute() in a loop takes longer than the simulation did.
        """
        import math
        f = run['frames']
        with self.conn, self.conn.cursor() as cur:
            cur.execute(
                'INSERT INTO sim_run (drug, dose_mult, conc_nm, qnet, apd90,'
                ' fda_label) VALUES (%s,%s,%s,%s,%s,%s) RETURNING run_id',
                (drug, dose_mult, conc_nM, qnet,
                 None if apd90 is None or math.isnan(apd90) else apd90,
                 fda_label))
            run_id = cur.fetchone()[0]

            buf = io.StringIO()
            for i, t in enumerate(f['t']):
                buf.write('\t'.join(str(x) for x in (
                    int(round(t * 1000)), run_id,
                    *(f[s][i] for s in SIGNALS))) + '\n')
            buf.seek(0)
            cur.copy_from(buf, 'ap_sample', columns=COLUMNS)
        return run_id

    def compress_all(self):
        """Compress every chunk and return the stats worth screenshotting."""
        with self.conn, self.conn.cursor() as cur:
            cur.execute('SELECT compress_chunk(c, if_not_compressed => TRUE)'
                        ' FROM show_chunks(\'ap_sample\') c;')
            cur.execute('SELECT * FROM hypertable_compression_stats'
                        '(\'ap_sample\');')
            cols = [d[0] for d in cur.description]
            return [dict(zip(cols, row)) for row in cur.fetchall()]

    def trace(self, drug, dose_mult, resolution='display'):
        """Display-resolution trace from the continuous aggregate."""
        view = 'ap_display' if resolution == 'display' else None
        with self.conn, self.conn.cursor() as cur:
            if view:
                cur.execute(
                    'SELECT d.bucket, d.v, d.ca_i, d.herg_open, d.herg_bound '
                    'FROM ap_display d JOIN sim_run r USING (run_id) '
                    'WHERE r.drug = %s AND r.dose_mult = %s '
                    'ORDER BY d.bucket', (drug, dose_mult))
            else:
                cur.execute(
                    'SELECT s.t_us, s.v, s.ca_i, s.herg_open, s.herg_bound '
                    'FROM ap_sample s JOIN sim_run r USING (run_id) '
                    'WHERE r.drug = %s AND r.dose_mult = %s '
                    'ORDER BY s.t_us', (drug, dose_mult))
            rows = cur.fetchall()
        return {'t_ms': [r[0] / 1000.0 for r in rows],
                'V': [r[1] for r in rows], 'Ca_i': [r[2] for r in rows],
                'hERG_open': [r[3] for r in rows],
                'hERG_bound': [r[4] for r in rows],
                'source': f'tiger:{view or "ap_sample"}'}

    def cross_drug_at(self, t_ms, dose_mult=4):
        with self.conn, self.conn.cursor() as cur:
            cur.execute(CROSS_DRUG_AT_T,
                        {'t_us': int(t_ms * 1000), 'dose': dose_mult})
            return [{'drug': d, 'dose_mult': m, 'V': v}
                    for d, m, v in cur.fetchall()]
