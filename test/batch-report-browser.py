from pathlib import Path
from urllib.parse import urlparse
import ipaddress
import os
from playwright.sync_api import sync_playwright

BASE = os.environ['TEKSER_TEST_URL']
assert urlparse(BASE).scheme == 'http' and not ipaddress.ip_address(urlparse(BASE).hostname).is_loopback
photo = str(Path(__file__).with_name('variant25-page1.jpg'))
reference = {'title':'СОР','prompt':'1. Найди 2²','answer':'1. 4','descriptors':['Сохраняет знак степени','Верно определяет знак ответа']}
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox','--no-proxy-server'])
    for lang in ('ru','kk'):
        page = browser.new_page(viewport={'width':375,'height':900}); errors=[]; requests=[]
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.on('console', lambda m: errors.append(m.text) if m.type=='error' else None)
        page.route('**/api/status', lambda r:r.fulfill(json={'live':True,'model':'test','limitPerHour':5,'batchLimitPerHour':30}))
        def respond(route):
            body = route.request.post_data_json; requests.append(body); i=len(requests)
            task = {**reference, 'title':f'Вариант {i}', 'prompt':f'1. Найди {i+1}²','answer':f'1. {(i+1)**2}'}
            result = {'readable':True,'variant':'','transcript':'Решение','descriptors':[{'id':'D1','met':i<3,'comment':'Ошибка знака' if i==3 else ''},{'id':'D2','met':i==1,'comment':'Потеря знака' if i>1 else ''}],'first_error':None if i==1 else {'part':'1','text':'Потеря знака'},'hint':f'Подсказка {i}: проверь знак','error_tags':[]}
            route.fulfill(json={'task':task,'result':result,'referenceTask':reference})
        page.route('**/api/batch-check',respond)
        page.goto(BASE,wait_until='networkidle'); assert page.evaluate('isSecureContext') is False
        page.locator(f'[data-l="{lang}"]').click();page.locator('#newBatch').click()
        page.locator('#batchFiles').set_input_files([photo]*6);page.locator('#batchStart').click()
        page.wait_for_function('document.querySelectorAll("#batchRows [data-review]").length===3')
        assert 'referenceTask' not in requests[0]
        assert all(r.get('referenceTask')==reference for r in requests[1:]),'Scale not reused'
        assert page.locator('#batchHistogram .bar').count()==5
        assert '50%' in page.locator('#batchStats').inner_text()
        assert page.locator('#batchTopErrors li').count()==1
        assert '2' in page.locator('#batchTopErrors').inner_text() and '3' in page.locator('#batchTopErrors').inner_text()
        assert 'Подсказка' in page.locator('#batchLessonTips').inner_text()
        assert page.locator('#batchTableRows tr').count()==3
        page.locator('#batchRows [data-review]').nth(2).click()
        page.locator('#descs input').nth(0).check();page.locator('#descs input').nth(1).check()
        page.locator('#hint').fill('Исправление учителя');page.locator('#approve').click();page.locator('#backBatch').click()
        assert ('83,3%' in page.locator('#batchStats').inner_text() or '83.3%' in page.locator('#batchStats').inner_text()), page.locator('#batchStats').inner_text()
        page.locator('#batchApproveAll').click()
        approvals=page.evaluate('store.get().filter(x=>x.batchId===batch.id)')
        assert len(approvals)==3
        changed=next(x for x in approvals if x['student']=='У-03')
        assert changed['hint']=='Исправление учителя' and changed['edited'] is True
        assert '67%' in page.locator('#batchAgreement').inner_text()
        page.locator('#batchOpenMap').click()
        assert page.evaluate('mine().length')==3
        assert '67%' in page.locator('#agreement').inner_text()
        assert page.locator('#bars .bar').count()==1
        page.locator('#backBatch').click()
        page.evaluate('window.print=()=>{window.__printed=true}')
        page.locator('#batchPrint').click();assert page.evaluate('window.__printed')
        page.emulate_media(media='print')
        assert page.locator('#batchReport').is_visible()
        assert page.locator('button:visible').count()==0
        assert page.locator('img:visible').count()==0
        assert page.locator('#batchStats').is_visible()
        assert not page.locator('#batchConfig').is_visible()
        page.evaluate('dispatchEvent(new Event("afterprint"))');page.emulate_media(media='screen')
        assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
        assert not errors,errors
        print(f'PASS HTTP IP {lang} 375px: fixed scale, summary/histogram/error groups/hints, table, approve-all preserves edits, class map, print')
        page.close()
    page=browser.new_page(viewport={'width':375,'height':900}); extra=[]; queued=[]; extra_errors=[]
    page.on('pageerror',lambda e:extra_errors.append(str(e)))
    page.route('**/api/status',lambda r:r.fulfill(json={'live':True,'model':'test','limitPerHour':5,'batchLimitPerHour':30}))
    all_met={'readable':True,'variant':'','transcript':'4','descriptors':[{'id':'D1','met':True,'comment':''},{'id':'D2','met':True,'comment':''}],'first_error':None,'hint':'OK','error_tags':[]}
    def queued_check(route):
        queued.append(route.request.post_data_json)
        if len(queued)==1:route.fulfill(status=502,json={'error':'Не удалось прочитать первую работу'})
        else:route.fulfill(json={'task':reference,'result':all_met,'referenceTask':reference})
    page.route('**/api/batch-check',queued_check)
    def extra_check(route):
        extra.append(route.request.post_data_json);route.fulfill(json=all_met)
    page.route('**/api/check',extra_check)
    page.goto(BASE,wait_until='networkidle');page.locator('#newBatch').click();page.locator('#batchFiles').set_input_files([photo]*4);page.locator('#batchStart').click()
    page.wait_for_function('!batchBusy')
    assert len(queued)==1 and page.locator('#batchApproveAll').is_disabled(),'Unreadable first task did not stop reference creation'
    page.locator('#batchStart').click()
    page.wait_for_function('document.querySelectorAll("#batchRows [data-review]").length===2')
    assert 'referenceTask' not in queued[1] and queued[2]['referenceTask']==reference
    page.locator('#batchRows [data-review]').nth(1).click();page.locator('#file').set_input_files([photo])
    page.wait_for_function('!document.getElementById("approve").disabled')
    assert extra[0]['student']=='У-03','Unapproved batch pupil code was reused'
    page.locator('#approve').click();page.locator('#backBatch').click();page.locator('#batchApproveAll').click()
    saved=page.evaluate('store.get().filter(x=>x.batchId===batch.id)')
    assert len(saved)==3 and len({x['student'] for x in saved})==3
    assert not extra_errors,extra_errors
    print('PASS first-reference failure/resume; extra upload reserves all unapproved pupil codes before approve-all')
    page.close()
    browser.close()
