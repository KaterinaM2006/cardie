#!/usr/bin/env bash
# Torsade — environment setup. Safe to re-run; it skips what is already done.
#
# SUNDIALS FIRST. Myokit installs fine without it and then fails at the first
# simulation with "fatal error: sundials/sundials_config.h: No such file or
# directory". This is the single most likely thing to cost you an hour.
set -euo pipefail
cd "$(dirname "$0")"

VENV=.venv
PY="$VENV/bin/python"

echo "== 1. SUNDIALS =="
if command -v apt-get >/dev/null; then
  sudo apt-get update -qq && sudo apt-get install -y -qq libsundials-dev python3-venv
elif command -v brew >/dev/null; then
  brew install sundials
else
  echo "install SUNDIALS yourself: conda install -c conda-forge sundials" >&2
fi

echo "== 2. Python packages (into $VENV) =="
# A virtualenv rather than a bare pip install: current Debian/Ubuntu refuse
# to install into the system interpreter (PEP 668 externally-managed).
[ -d "$VENV" ] || python3 -m venv "$VENV"
"$PY" -m pip install -q --upgrade pip
"$PY" -m pip install -q -r requirements.txt

echo "== 3. Verify BEFORE going further. Must print a version, not None. =="
"$PY" -c "import myokit; print('sundials', myokit.Sundials.version())"

echo "== 4. Data + models (public, no auth) =="
mkdir -p external
[ -d external/CiPA ] || \
  git clone --depth 1 -q https://github.com/FDA/CiPA.git external/CiPA
[ -d external/myokit-models ] || \
  git clone --depth 1 -q https://github.com/myokit/models.git external/myokit-models

echo "== 5. Control beat — must print qNet=0.0781 APD90=277.2 =="
"$PY" engine.py

cat <<EOF

Ready.

  $PY app.py            ->  http://localhost:5000

The sweep is already committed, so the app runs with no simulation. To
regenerate it (~7 min) or run the tests:

  $PY sweep.py
  $PY -m pytest tests/ -q
EOF
