#!/usr/bin/env python3
"""Browser check of the optional sign-in (PHYSIOS_AUTH_TOKEN).

Start a gateway with a token, for example next to the devstack:
    cd physios/backend && PHYSIOS_PORT=8710 PHYSIOS_AUTH_TOKEN=lab-operator-2026 python3 -m physios_gateway
then:  python3 auth_e2e.py http://127.0.0.1:8710 lab-operator-2026 [shots_dir]
"""
import sys
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

BASE, TOKEN = sys.argv[1], sys.argv[2]
SHOTS = Path(sys.argv[3]) if len(sys.argv) > 3 else None
steps = []
with sync_playwright() as pw:
    b = pw.chromium.launch()
    pg = b.new_page(viewport={'width': 1600, 'height': 900})
    st = pg.request.get(BASE + '/api/v1/health').status
    assert st == 401, st
    steps.append('API refuses requests without a session (401)')
    pg.goto(BASE + '/')
    pg.wait_for_selector('[data-testid="login"]')
    if SHOTS:
        SHOTS.mkdir(parents=True, exist_ok=True)
        pg.screenshot(path=str(SHOTS / 'sign-in.png'))
    steps.append('login screen shown')
    pg.fill('[data-field="token"]', 'wrong-token')
    pg.click('[data-action="sign-in"]')
    expect(pg.get_by_text('That access token is not correct.')).to_be_visible()
    steps.append('wrong token refused')
    pg.fill('[data-field="token"]', TOKEN)
    pg.click('[data-action="sign-in"]')
    pg.wait_for_selector('[data-robot]', timeout=15000)
    steps.append('signed in; Home loads with live data')
    pg.goto(BASE + '/settings')
    pg.click('[data-action="sign-out"]')
    pg.wait_for_selector('[data-testid="login"]')
    steps.append('signed out from Settings')
    b.close()
for i, s in enumerate(steps, 1):
    print('%02d %s' % (i, s))
print('OK')
