from pathlib import Path
import os
from playwright.sync_api import sync_playwright
BASE=os.environ.get('TEKSER_TEST_URL','http://127.0.0.1:3000')
photo=str(Path(__file__).with_name('variant25-page1.jpg'))
def payload(i):
 return {'task':{'title':f'Вариант {i}','prompt':f'Печатное условие {i}','answer':f'Ответ {i}','descriptors':['Шаг','Ответ']},'result':{'readable':True,'variant':'','transcript':'Решение','descriptors':[{'id':'D1','met':True,'comment':''},{'id':'D2','met':False,'comment':'Ошибка'}],'first_error':{'part':'1','text':'Проверь ответ'},'hint':'Пересчитай','error_tags':['D2']}}
with sync_playwright() as p:
 b=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox','--no-proxy-server'])
 for lang in ('ru','kk'):
  page=b.new_page(viewport={'width':375,'height':900},accept_downloads=True);errors=[];requests=[];held=[]
  page.on('pageerror',lambda e:errors.append(str(e)))
  page.on('console',lambda m:errors.append(m.text) if m.type=='error' else None)
  page.route('**/api/status',lambda r:r.fulfill(json={'live':True,'model':'test','limitPerHour':5,'batchLimitPerHour':30}))
  def respond(r):
   requests.append(r.request.post_data_json)
   if len(requests)==1:held.append(r)
   else:r.fulfill(json=payload(len(requests)))
  page.route('**/api/batch-check',respond)
  page.goto(BASE,wait_until='networkidle');page.locator(f'[data-l="{lang}"]').click()
  assert page.locator('#newBatch').count()==1,'Batch entry missing'
  page.locator('#newBatch').click();page.locator('#batchFiles').set_input_files([photo]*10)
  assert page.locator('#batchGrouping [data-page]').count()==10
  page.locator('#batchStart').click();page.wait_for_function('document.querySelector("#batchStop").disabled===false')
  for _ in range(100):
   if held:break
   page.wait_for_timeout(50)
  assert len(held)==1
  page.locator('#batchStop').click();held[0].fulfill(json=payload(1))
  page.wait_for_function('!document.querySelector("#batchStart").disabled')
  assert len(requests)==1,'Stop did not stop scheduling'
  assert page.locator('#batchRows [data-review]').count()==1
  page.locator('#batchStart').click()
  page.wait_for_function('document.querySelectorAll("#batchRows [data-review]").length===5')
  assert len(requests)==5 and all(len(x['images'])==2 for x in requests)
  assert all(x['lang']==lang for x in requests)
  assert page.locator('#batchRows').inner_text().count('1 / 2')==5
  with page.expect_download() as event:page.locator('#batchCSV').click()
  path=event.value.path();csv=open(path,encoding='utf-8-sig').read()
  assert len(csv.splitlines())==6
  page.locator('#batchRows [data-review]').first.click()
  assert page.locator('#score').inner_text()=='1'
  assert page.locator('#pageNav').is_visible(),'Cannot inspect second page'
  first=page.locator('#prev').get_attribute('src')
  page.locator('#hint').fill('Подсказка учителя')
  page.locator('#nextPage').click()
  assert page.locator('#prev').get_attribute('src')!=first
  assert page.locator('#hint').input_value()=='Подсказка учителя'
  assert page.locator('#nextPage').is_disabled()
  page.locator('#descs input').nth(1).check();page.locator('#approve').click()
  page.locator('#backBatch').click()
  assert ' 0%' in page.locator('#batchAgreement').inner_text()
  assert '2 / 2' in page.locator('#batchRows').inner_text()
  page.locator('#backSchedule').click();page.locator('[data-lesson="2"]').click();page.locator('#startAssessment').click()
  assert page.locator('#demoBtns button').count()==3
  assert not page.locator('#trustStats').is_visible()
  assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
  stored=page.request.get(BASE+'/api/tasks').json()[0]
  normal={'readable':True,'variant':'','transcript':'Решение','descriptors':[{'id':d['id'],'met':True,'comment':''} for d in stored['descriptors']],'first_error':None,'hint':'OK','error_tags':[]}
  page.route('**/api/check',lambda r:r.fulfill(json=normal))
  page.locator('#file').set_input_files([photo]*2)
  page.wait_for_function('!document.getElementById("approve").disabled')
  assert page.locator('#openPage').get_attribute('href').startswith('blob:'),'Full-size photo link uses blocked data URL'
  with page.expect_popup() as popup_info:page.locator('#openPage').click()
  popup=popup_info.value;popup.wait_for_load_state();assert popup.locator('img').is_visible();popup.close()
  assert not errors,errors
  print(f'PASS {lang} 375px: 10 photos -> 5 works, stop/resume, report/CSV, teacher approval/trust, task isolation, console')
  page.close()
 b.close()
