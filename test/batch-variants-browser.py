from pathlib import Path
from urllib.parse import urlparse
import ipaddress
import os
from playwright.sync_api import sync_playwright

BASE=os.environ['TEKSER_TEST_URL']
assert urlparse(BASE).scheme=='http' and not ipaddress.ip_address(urlparse(BASE).hostname).is_loopback
photo=str(Path(__file__).with_name('variant25-page1.jpg'))
reference={'title':'Вариант 22','prompt':'1. Задание 2. Задание','answer':'1. Ответ 2. Ответ','descriptors':['Строит график','Обосновывает вывод']}
with sync_playwright() as p:
    browser=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox','--no-proxy-server'])
    for lang in ('ru','kk'):
        page=browser.new_page(viewport={'width':375,'height':900},accept_downloads=True);errors=[];requests=[]
        page.on('pageerror',lambda e:errors.append(str(e)))
        page.on('console',lambda m:errors.append(m.text) if m.type=='error' else None)
        page.route('**/api/status',lambda r:r.fulfill(json={'live':True,'model':'test','limitPerHour':5,'batchLimitPerHour':30}))
        def respond(route):
            requests.append(route.request.post_data_json);i=len(requests);separate=i==4
            task={**reference,'title':f'Вариант {[22,21,25,99,21][i-1]}','answer':f'Ответ {i}'}
            if separate:task['descriptors']=['Доказывает утверждение','Выбирает метод','Записывает вывод']
            result={'readable':True,'variant':'','transcript':'Решение','descriptors':[{'id':f'D{n+1}','met':False,'comment':''} for n in range(len(task['descriptors']))],'first_error':{'part':'1','text':'Проверь решение'},'hint':'Повтори шаг','error_tags':[]}
            route.fulfill(json={'task':task,'result':result,'referenceTask':reference,'differentScale':separate})
        page.route('**/api/batch-check',respond)
        page.goto(BASE,wait_until='networkidle');assert page.evaluate('isSecureContext') is False
        page.locator(f'[data-l="{lang}"]').click();page.locator('#newBatch').click()
        page.locator('#batchFiles').set_input_files([photo]*10);page.locator('#batchStart').click()
        page.wait_for_function('!batchBusy')
        assert page.locator('#batchRows [data-review]').count()==5,'Different structure was rejected'
        assert len(requests)==5 and all(r.get('referenceTask')==reference for r in requests[1:]),'Fallback replaced main scale'
        assert page.locator('#batchRows .different-scale').count()==1
        rows=page.locator('#batchTableRows tr')
        assert all('0 / 2' in rows.nth(i).inner_text() for i in [0,1,2,4])
        assert '0 / 3' in rows.nth(3).inner_text()
        rows.nth(3).click();assert page.locator('#reviewScaleNote').is_visible()
        assert page.locator('#max').inner_text()=='3'
        page.locator('#backBatch').click();page.locator('#batchApproveAll').click()
        approvals=page.evaluate('store.get()')
        common=page.evaluate('batch.id')
        assert sum(x.get('batchId')==common for x in approvals)==4
        assert sum(x.get('batchId')!=common for x in approvals)==1
        page.locator('#batchOpenMap').click();assert page.evaluate('mine().length')==4
        page.locator('#backBatch').click()
        with page.expect_download() as event:page.locator('#batchCSV').click()
        text=Path(event.value.path()).read_text(encoding='utf-8-sig')
        assert ('Другая шкала' if lang=='ru' else 'Басқа шкала') in text
        assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
        assert not errors,errors
        print(f'PASS HTTP IP {lang}: 22/21/25 share scale; new structure flagged, graded, isolated; main scale retained afterward; console clean')
        page.close()
    browser.close()
