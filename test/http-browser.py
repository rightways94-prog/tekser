"""Regression check on a real insecure HTTP origin, with no OpenAI requests."""
from pathlib import Path
from urllib.parse import urlparse
import ipaddress
import os
from playwright.sync_api import sync_playwright

base = os.environ['TEKSER_TEST_URL']
url = urlparse(base)
address = ipaddress.ip_address(url.hostname)
assert url.scheme == 'http' and not address.is_loopback, 'Use http://<machine-IP>:port'

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox', '--no-proxy-server'])
    for lang in ('ru', 'kk'):
        page = browser.new_page(viewport={'width': 375, 'height': 900})
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
        page.goto(base, wait_until='networkidle')
        assert page.evaluate('isSecureContext') is False
        assert page.evaluate('typeof window.crypto.randomUUID') == 'undefined'
        assert not errors, errors
        assert page.locator('[data-lesson]').count() == 5
        page.locator(f'[data-l="{lang}"]').click()
        page.locator('[data-lesson="2"]').click()
        page.locator('#startAssessment').click()
        for letter in ('A', 'B', 'C'):
            page.locator(f'[data-w="{letter}"]').click()
            page.locator('#approve').click()
        assert '100%' in page.locator('#agreement').inner_text()
        page.locator('#backSchedule').click()
        page.locator('#newCustom').click()
        for field, text in [('customTitle', 'Своё задание'), ('customPrompt', 'Найдите 2²'), ('customAnswer', '4'), ('customDescriptors', 'Получает ответ 4')]:
            page.locator('#' + field).fill(text)
        page.locator('#saveCustom').click()
        assert page.locator('#taskSel').input_value().startswith('custom-')
        page.locator('#backSchedule').click()
        page.locator('#newBatch').click()
        initial = page.evaluate('batch.id')
        page.locator('#batchFiles').set_input_files([str(Path(__file__).with_name('variant25-page1.jpg'))] * 2)
        assert page.locator('#batchGrouping [data-page]').count() == 2
        page.locator('#batchReset').click()
        assert page.evaluate('batch.id') != initial
        assert page.locator('#batchGrouping [data-page]').count() == 0
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        assert not errors, errors
        print(f'PASS HTTP IP, insecure context, missing randomUUID, {lang}, 375px: startup, ABC, custom save, batch reset; console clean')
        page.close()
    browser.close()
