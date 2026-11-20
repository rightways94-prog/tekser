from pathlib import Path
import os
from playwright.sync_api import sync_playwright
import csv
BASE=os.environ.get('TEKSER_TEST_URL','http://127.0.0.1:3000')
photo=str(Path(__file__).with_name('variant25-page1.jpg'))
with sync_playwright() as p:
 b=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
 page=b.new_page(viewport={'width':375,'height':900},accept_downloads=True);errors=[];console=[];calls=[]
 page.on('pageerror',lambda e:errors.append(str(e)))
 page.on('console',lambda m:console.append(m.text) if m.type=='error' else None)
 page.route('**/api/status',lambda r:r.fulfill(json={'live':True,'model':'test','limitPerHour':5,'batchLimitPerHour':30}))
 data={'task':{'title':'=SUM(1,2)','prompt':'2'*150,'answer':'4','descriptors':['Получает <b>4</b>']},'result':{'readable':True,'variant':'','transcript':'4','descriptors':[{'id':'D1','met':True,'comment':''}],'first_error':None,'hint':'OK','error_tags':[]}}
 def respond(r):
  calls.append(r.request.post_data_json)
  if len(calls)==1:r.fulfill(status=502,json={'error':'Тестовая ошибка проверки'})
  else:r.fulfill(json=data)
 page.route('**/api/batch-check',respond)
 page.goto(BASE,wait_until='networkidle');page.locator('#newBatch').click()
 page.locator('#batchFiles').set_input_files([photo]*5)
 page.select_option('#batchPages','1')
 for i in range(5):page.locator(f'[data-page="{i}"]').fill('1');page.locator(f'[data-page="{i}"]').press('Tab')
 assert page.locator('#batchStart').is_disabled(),'Five pages allowed for one pupil'
 page.locator('[data-page="4"]').fill('2');page.locator('[data-page="4"]').press('Tab')
 assert not page.locator('#batchStart').is_disabled()
 page.locator('#batchStart').click()
 page.wait_for_function('document.querySelectorAll("#batchRows [data-review]").length===1 && !document.getElementById("batchStart").disabled')
 assert len(calls)==2 and [len(c['images']) for c in calls]==[4,1]
 assert '0 /' not in page.locator('#batchRows article').first.inner_text()
 with page.expect_download() as event:page.locator('#batchCSV').click()
 rows=list(csv.reader(open(event.value.path(),encoding='utf-8-sig'),delimiter=';'))
 assert rows[1][3]=='' and rows[2][2].startswith("'")
 assert page.locator('#batchRows [data-replace]').count()>=1,'Cannot replace failed work photos'
 page.locator('#batchRows [data-replace]').first.set_input_files([str(Path(__file__).with_name('variant25-page2.jpg'))]*4)
 page.locator('#batchStart').click()
 page.wait_for_function('document.querySelectorAll("#batchRows [data-review]").length===2')
 assert len(calls)==3 and len(calls[-1]['images'])==4,'Successful row repeated during retry'
 assert calls[-1]['images'][0]!=calls[0]['images'][0],'Retry used stale photos'
 assert page.evaluate('document.documentElement.scrollWidth<=innerWidth'),'Long task text overflows'
 page.locator('#batchRows [data-review]').first.click()
 assert page.locator('#pageNav').is_visible()
 for _ in range(3):page.locator('#nextPage').click()
 assert page.locator('#nextPage').is_disabled()
 assert '4' in page.locator('#pageCount').inner_text()
 page.locator('#backBatch').click()
 before=len(console)
 page.locator('#batchReset').click();page.locator('[data-l="kk"]').click();page.wait_for_timeout(300)
 assert len(console)==before,console
 page.locator('#batchFiles').set_input_files([photo]*121)
 assert page.locator('#batchStart').is_disabled()
 assert page.locator('#batchGrouping [data-page]').count()==0
 assert not errors,errors
 print('PASS grouping edits/limits, partial errors and retry, CSV empty failed score/formula escaping, long text, reset image URLs')
 page.close()
 page=b.new_page(viewport={'width':375,'height':900});page.route('**/api/status',lambda r:r.fulfill(json={'live':False,'model':None,'limitPerHour':5,'batchLimitPerHour':30}));page.goto(BASE,wait_until='networkidle')
 page.locator('[data-l="kk"]').click();page.locator('#newBatch').click();page.locator('#batchFiles').set_input_files([photo]*2);page.locator('#batchStart').click()
 assert 'кілт' in page.locator('#batchNotice').inner_text()
 assert page.locator('#batchRows [data-review]').count()==0
 print('PASS batch no-key explanation in Kazakh, no fake results')
 page.close();b.close()
