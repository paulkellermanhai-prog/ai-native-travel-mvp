const tripLabels = {destination:'目的地', dates:'日期', companions:'同行人', budget:'预算', preferences:'偏好'};
const travelerGroups = [
 ['adults','成人','13 岁及以上',1],
 ['children','儿童','2–12 岁',0],
 ['infants','婴儿','未满 2 岁',0],
 ['pets','宠物','',0]
];
const budgetLevels = [
 ['any','不限预算',''],
 ['economy','经济实惠','$'],
 ['moderate','价格适中','$$'],
 ['upscale','品质之选','$$$'],
 ['luxury','奢华体验','$$$$']
];
let openTripField = '';
let tripDraft, savedTripValue, monthPage;

function dateKey(date) {
 return [date.getFullYear(),date.getMonth()+1,date.getDate()].map(n=>String(n).padStart(2,'0')).join('-');
}
function monthDate(page) {
 return new Date(Math.floor(page/12),page%12,1);
}
function monthIndex(date) {
 return date.getFullYear()*12+date.getMonth();
}
function dateMonth(value) {
 const [year,month] = value.split('-').map(Number);
 return year*12+month-1;
}
function formatDate(value) {
 const [,month,day] = value.split('-').map(Number);
 return month+' 月 '+day+' 日';
}
function travelerCount(value) {
 return value.adults+value.children+value.infants;
}
function tripSummary(field,value) {
 if (field === 'destination') return state.active ? '埃及' : '';
 if (typeof value === 'string') return value;
 if (!value) return '';
 if (field === 'dates') {
  if (value.mode === 'fixed') {
   const start = formatDate(value.start), end = formatDate(value.end);
   if (value.start === value.end) return start;
   if (value.start.slice(0,7) === value.end.slice(0,7)) return start+'–'+Number(value.end.slice(-2))+' 日';
   return start+'–'+end;
  }
  return [value.month ? Number(value.month.slice(-2))+' 月' : '',value.days+' 天'].filter(Boolean).join(' · ');
 }
 if (field === 'companions') return travelerCount(value)+' 位旅客';
 if (field === 'budget') return budgetLevels.find(([id])=>id===value.level)?.[2] || '不限预算';
 return value.length ? value.length+' 项偏好' : '';
}
function renderTripPill() {
 for (const button of document.querySelectorAll('.trip-pill button')) {
  const field = button.dataset.act.split(':')[1];
  const label = tripLabels[field];
  const value = tripSummary(field,state.tripDetails[field]);
  button.hidden = field === 'preferences' && !state.active;
  button.textContent = field === 'preferences' ? label : value || label;
  button.classList.toggle('is-set', Boolean(value));
  button.setAttribute('aria-label', value ? label+'，'+value : label);
  button.setAttribute('aria-expanded', String(field === openTripField));
  button.title = value || label;
 }
}
function tripButton(label,action,extra='') {
 return `<button type="button" data-trip="${action}" ${extra}>${label}</button>`;
}
function counter(label, key, value, min) {
 return `<div class="trip-counter">
  ${tripButton('−','step:'+key+':-1',`aria-label="减少${label}" ${value<=min?'disabled':''}`)}
  <output>${value}</output>
  ${tripButton('＋','step:'+key+':1',`aria-label="增加${label}"`)}
 </div>`;
}
function calendar(page) {
 const month = monthDate(page), year = month.getFullYear(), index = month.getMonth();
 const title = year+' 年 '+(index+1)+' 月';
 const {start,end} = tripDraft.fixed;
 const today = dateKey(new Date());
 const days = new Date(year,index+1,0).getDate();
 let cells = '<span></span>'.repeat(month.getDay());
 for (let day=1;day<=days;day++) {
  const value = dateKey(new Date(year,index,day));
  const edge = value===start || value===end;
  const between = end && value>start && value<end;
  cells += tripButton(`<span>${day}</span>`,'day:'+value,
   `aria-label="${year} 年 ${formatDate(value)}" aria-pressed="${edge}" class="${edge?'calendar-edge':between?'calendar-range':''}" ${value<today?'disabled':''}`);
 }
 return `<section aria-label="${title}"><h3>${title}</h3>
  <div class="trip-calendar-grid">${['日','一','二','三','四','五','六'].map(day=>`<b>${day}</b>`).join('')}${cells}</div>
 </section>`;
}
function dateBody() {
 if (tripDraft.mode === 'fixed') {
  const min = monthIndex(new Date());
  const {start,end}=tripDraft.fixed;
  return `<div class="trip-calendars">
   ${tripButton('‹','month:-1',`class="trip-month-arrow prev" aria-label="上个月" ${monthPage<=min?'disabled':''}`)}
   ${calendar(monthPage)}${calendar(monthPage+1)}
   ${tripButton('›','month:1','class="trip-month-arrow next" aria-label="下个月"')}
  </div><p class="trip-date-hint quiet">${start&&!end?'再选一天作为结束日期。':'选择出发日期和结束日期。'}</p>`;
 }
 const current = monthIndex(new Date());
 const months = Array.from({length:12},(_,offset)=>{
  const month = monthDate(current+offset), value = dateKey(month).slice(0,7);
  return tripButton(`<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="6" width="16" height="14" rx="2"/><path d="M8 3v6m8-6v6M4 11h16"/></svg><strong>${month.getMonth()+1} 月</strong><small>${month.getFullYear()} 年</small>`,
   'flex-month:'+value,`aria-pressed="${tripDraft.flexible.month===value}"`);
 }).join('');
 return `<div class="trip-flex"><h3>想去几天？</h3>${counter('旅行天数','days',tripDraft.flexible.days,1)}
  <h3>想在哪个月出发？</h3>
  ${tripButton('不限月份','flex-month:',`class="trip-any-month" aria-pressed="${!tripDraft.flexible.month}"`)}
  <div class="trip-month-carousel">
   ${tripButton('‹','month-scroll:-1','aria-label="向前浏览月份"')}
   <div class="trip-month-list" aria-label="可选月份">${months}</div>
   ${tripButton('›','month-scroll:1','aria-label="向后浏览月份"')}
  </div>
 </div>`;
}
function preferenceBody() {
 const items = tripDraft.map((item,index)=>`<li><span>${escapeHtml(item)}</span>${tripButton('×','remove:'+index,`aria-label="移除偏好 ${escapeHtml(item)}"`)}</li>`).join('');
 return `<p class="quiet">用自己的话写下这趟旅行里你在意的事，可以逐条添加。</p>
  <ul class="trip-preference-list">${items}</ul>
  <div class="trip-preference-entry"><input id="trip-preference-input" maxlength="160" aria-label="填写旅行偏好" placeholder="例如 想多看古迹，节奏慢一点">
   ${tripButton('＋ 添加','add','class="subtle"')}
  </div>`;
}
function renderTripDialog() {
 const body = $('trip-field-body'), context = $('trip-field-context');
 const focus = document.activeElement?.dataset.trip;
 const strip = body.querySelector('.trip-month-list');
 const left = strip?.scrollLeft || 0;
 $('trip-field-label').textContent = openTripField === 'preferences' ? '旅行偏好' : tripLabels[openTripField];
 $('trip-field-panel').dataset.field = openTripField;
 $('trip-field-clear').hidden = openTripField !== 'dates' || tripDraft.mode !== 'fixed';
 $('trip-field-submit').textContent = openTripField === 'destination' ? (state.active ? '查看埃及' : '选择埃及') : '保存';
 $('trip-field-submit').disabled = false;
 context.innerHTML = '';
 switch (openTripField) {
 case 'dates':
  context.innerHTML = `<div class="trip-date-tabs" role="group" aria-label="日期类型">
   ${tripButton('固定日期','mode:fixed',`aria-pressed="${tripDraft.mode==='fixed'}"`)}
   ${tripButton('灵活日期','mode:flexible',`aria-pressed="${tripDraft.mode==='flexible'}"`)}
  </div>`;
  body.innerHTML = dateBody();
  $('trip-field-submit').disabled = tripDraft.mode==='fixed' && Boolean(tripDraft.fixed.start&&!tripDraft.fixed.end);
  break;
 case 'companions':
  context.textContent = travelerCount(tripDraft)+' 位旅客'+(tripDraft.pets ? ' · '+tripDraft.pets+' 只宠物' : '');
  body.innerHTML = travelerGroups.map(([key,label,age,min])=>`<div class="trip-traveler-row">
   <div><strong>${label}</strong>${age?`<small>${age}</small>`:''}</div>
   ${counter(label,key,tripDraft[key],min)}
  </div>`).join('');
  break;
 case 'budget':
  context.textContent = '选择这趟旅行的预算档位';
  body.innerHTML = budgetLevels.map(([id,label,symbol])=>`<label class="trip-budget-option">
   <input type="radio" name="budget-level" value="${id}" ${tripDraft.level===id?'checked':''}>
   <span>${symbol?`<b>${symbol}</b> `:''}${label}</span>
  </label>`).join('');
  break;
 case 'preferences':
  body.innerHTML = preferenceBody();
  break;
 default:
  body.innerHTML = '<div class="trip-destination-card"><img src="assets/giza.webp" alt=""><div><strong>埃及</strong><small>目的地探索</small></div></div>';
 }
 if (typeof savedTripValue==='string' && savedTripValue && ['dates','companions','budget'].includes(openTripField)) {
  body.insertAdjacentHTML('afterbegin',`<p class="trip-legacy quiet">已记录 ${escapeHtml(savedTripValue)}</p>`);
 }
 const newStrip = body.querySelector('.trip-month-list');
 if (newStrip) newStrip.scrollLeft = left;
 if (focus) {
  const replacement = [...$('trip-field-panel').querySelectorAll('[data-trip]')].find(button=>button.dataset.trip===focus);
  if (replacement && !replacement.disabled) replacement.focus({preventScroll:true});
 }
}
function openTripDialog(field) {
 openTripField = field;
 savedTripValue = state.tripDetails[field];
 const value = savedTripValue;
 switch (field) {
 case 'dates':
  tripDraft = {
   mode:value?.mode || 'fixed',
   fixed:value?.mode==='fixed' ? {start:value.start,end:value.end} : {start:'',end:''},
   flexible:value?.mode==='flexible' ? {month:value.month,days:value.days} : {month:'',days:7}
  };
  monthPage = tripDraft.fixed.start ? dateMonth(tripDraft.fixed.start) : monthIndex(new Date());
  break;
 case 'companions': {
  const adults = typeof value==='string' && value.match(/^(\d+)\s*位?\s*成人$/);
  tripDraft = typeof value==='object' && value ? {...value} : {adults:adults ? Math.max(1,Number(adults[1])) : 1,children:0,infants:0,pets:0};
  break;
 }
 case 'budget':
  tripDraft = typeof value==='object' && value ? {...value} : {level:'any'};
  break;
 case 'preferences':
  tripDraft = Array.isArray(value) ? [...value] : value ? [value] : [];
  break;
 }
 renderTripPill();
 renderTripDialog();
 $('trip-field-panel').showModal();
}
function closeTripDialog() {
 const field = openTripField;
 openTripField = '';
 $('trip-field-panel').close();
 renderTripPill();
 document.querySelector(`[data-act="trip-field:${field}"]`)?.focus();
}
function addTripPreference() {
 const input = $('trip-preference-input');
 const value = input.value.trim();
 if (value) tripDraft.push(value);
 return value;
}

document.addEventListener('DOMContentLoaded',()=>{
 const dialog = $('trip-field-panel');
 dialog.addEventListener('cancel',e=>{e.preventDefault();closeTripDialog();});
 dialog.addEventListener('click',e=>{
  if (e.target===dialog) {closeTripDialog();return;}
  const action = e.target.closest('[data-trip]')?.dataset.trip;
  if (!action) return;
  const [kind,key,delta] = action.split(':');
  switch (kind) {
  case 'close':closeTripDialog();return;
  case 'clear':
   savedTripValue = '';
   tripDraft.fixed = {start:'',end:''};
   monthPage = monthIndex(new Date());
   break;
  case 'mode':tripDraft.mode=key;break;
  case 'month':monthPage+=Number(key);break;
  case 'month-scroll': {
   const list = dialog.querySelector('.trip-month-list');
   list.scrollBy({left:Number(key)*list.clientWidth});
   return;
  }
  case 'day': {
   const {start,end} = tripDraft.fixed;
   tripDraft.fixed = !start || end ? {start:key,end:''} :
    key<start ? {start:key,end:start} : {start,end:key};
   savedTripValue = '';
   break;
  }
  case 'step': {
   const values = key==='days' ? tripDraft.flexible : tripDraft;
   values[key]+=Number(delta);
   savedTripValue = '';
   break;
  }
  case 'flex-month':tripDraft.flexible.month=key;savedTripValue='';break;
  case 'add':
   if (!addTripPreference()) return;
   renderTripDialog();
   $('trip-preference-input').focus();
   return;
  case 'remove': {
   const input = $('trip-preference-input');
   const value = input.value;
   tripDraft.splice(Number(key),1);
   renderTripDialog();
   $('trip-preference-input').value = value;
   $('trip-preference-input').focus();
   return;
  }
  }
  renderTripDialog();
 });
 dialog.addEventListener('change',e=>{
  if (e.target.name==='budget-level') {tripDraft.level=e.target.value;savedTripValue='';}
 });
 dialog.addEventListener('keydown',e=>{
  if (e.target.id==='trip-preference-input' && e.key==='Enter' && !e.isComposing) {
   e.preventDefault();
   dialog.querySelector('[data-trip=add]').click();
  }
 });
 $('trip-field-form').addEventListener('submit',e=>{
  e.preventDefault();
  const field = openTripField;
  if (field==='destination') {
   closeTripDialog();
   if (state.active) interact('home');
   else send('我想去埃及');
   return;
  }
  if (field==='preferences') addTripPreference();
  let value = tripDraft;
  if (field==='dates') {
   value = tripDraft.mode==='flexible' ? {mode:'flexible',...tripDraft.flexible} :
    tripDraft.fixed.end ? {mode:'fixed',...tripDraft.fixed} : '';
  }
  if (typeof savedTripValue==='string' && savedTripValue && ['dates','companions','budget'].includes(field) && !(field==='dates' && tripDraft.mode==='flexible')) {
   value = savedTripValue;
  }
  state.tripDetails[field]=value;
  if(field==='dates')state.discovery.conditions={};
  save();
  closeTripDialog();
  if(field==='dates' && state.active){remember();render();}
  if(field==='companions' && open && activeTransport()){remember();renderResults();}
 });
});
