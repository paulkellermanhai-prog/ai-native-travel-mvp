const transportListIcons = {
 arrow:'<path d="M3 12h17m-6-6 6 6-6 6"/>',
 person:'<circle cx="12" cy="7" r="4"/><path d="M4 21a8 8 0 0 1 16 0Z"/>',
 start:'<circle cx="12" cy="12" r="7"/>',
 pin:'<path d="M18 9c0 5-6 11-6 11S6 14 6 9a6 6 0 1 1 12 0Z"/><circle cx="12" cy="9" r="2"/>',
 calendar:'<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v5m10-5v5M3 10h18"/>',
 sort:'<path d="M3 6h18M3 12h12M3 18h6"/>'
};
const transportTripOptions = {oneway:'单程',return:'往返',multi:'多城市'};
const transportCabinOptions = {economy:'经济舱',premium:'高端经济舱',business:'商务舱',first:'头等舱'};
const transportStopOptions = {any:'不限换乘次数',direct:'仅直达',one:'最多换乘 1 次'};
const transportSortOptions = {best:'优选',price:'价格',duration:'耗时',departure:'出发时间'};
const transportPassengerGroups = [
 ['adults','成人','13 岁及以上',1],
 ['children','儿童','2–12 岁',0],
 ['lap','怀抱婴儿','未满 2 岁',0],
 ['seat','占座婴儿','未满 2 岁',0]
];

function transportListIcon(name) {
 return `<svg class="transport-list-icon" viewBox="0 0 24 24" aria-hidden="true">${transportListIcons[name]}</svg>`;
}

function transportListMenu(key,label,content,icon='') {
 return `<details name="transport-list-menu" class="transport-list-menu" data-list-menu="${key}">
  <summary>${icon}<span data-menu-label>${label}</span><i aria-hidden="true"></i></summary>
  <div class="transport-list-popover">${content}</div>
 </details>`;
}

function transportListChoices(options,selected) {
 return Object.entries(options).map(([key,label])=>`<button type="button" class="transport-list-choice"
  data-list-choice="${key}" aria-pressed="${key===selected}"><span aria-hidden="true">✓</span>${label}</button>`).join('');
}

function transportTimeRange(key,label) {
 return `<div class="transport-time-filter">
  <p>${label} <output data-range-output="${key}"></output></p>
  <div class="transport-dual-range">
   <input type="range" name="${key}Start" min="0" max="1440" step="5" value="0" aria-label="最早${label}时间">
   <input type="range" name="${key}End" min="0" max="1440" step="5" value="1440" aria-label="最晚${label}时间">
  </div>
 </div>`;
}

function transportSearchControls(mode,ids,passengers,priceMax,durationMax) {
 const count=Object.values(passengers).reduce((sum,n)=>sum+n,0);
 const citySelect=(index,label,icon)=>`<label>${transportListIcon(icon)}<select name="${index===0?'origin':'destination'}" aria-label="${label}">
  ${Object.entries(cities).map(([id,city])=>`<option value="${id}" ${ids[index]===id?'selected':''}>${city.n}</option>`).join('')}</select></label>`;
 const passengerRows=transportPassengerGroups.map(([key,label,age])=>`<div class="transport-passenger-row">
  <div><b>${label}</b><small>${age}</small></div>
  <button type="button" data-passenger="${key}" data-delta="-1" aria-label="减少${label}">−</button>
  <output data-passenger-count="${key}"></output>
  <button type="button" data-passenger="${key}" data-delta="1" aria-label="增加${label}">＋</button>
 </div>`).join('');
 const range=(key,title,max,step)=>`<h4>${title}</h4>
  <input type="range" name="${key}" min="0" max="${max}" step="${step}" value="${max}" aria-label="${title}上限">
  <output data-range-output="${key}"></output>`;
 return `<form class="transport-search">
  <div class="transport-search-options">
   ${transportListMenu('trip','单程',transportListChoices(transportTripOptions,'oneway'),transportListIcon('arrow'))}
   ${transportListMenu('passengers',count,passengerRows+'<button type="button" class="transport-search-primary transport-passenger-apply" data-list-apply>更新</button>',transportListIcon('person'))}
   ${mode==='plane'?transportListMenu('cabin','经济舱',transportListChoices(transportCabinOptions,'economy')):''}
  </div>
  <div class="transport-list-route">
   <div class="transport-search-route">
    ${citySelect(0,'出发城市','start')}
    <button type="button" data-list-swap aria-label="交换出发和到达城市">${transportListIcon('arrow')}</button>
    ${citySelect(1,'到达城市','pin')}
   </div>
   <div class="transport-search-date-row">
    <label class="transport-search-date">${transportListIcon('calendar')}<span data-date-label>${formatDate(transportSnapshot.date)}</span>
     <input type="date" name="date" value="${transportSnapshot.date}" aria-label="出发日期" required>
    </label>
    <button type="submit" class="transport-search-primary">搜索</button>
   </div>
  </div>
  <div class="transport-list-filters" role="group" aria-label="筛选行程">
   ${transportListMenu('stops','直达／换乘',transportListChoices(transportStopOptions,'any'))}
   ${transportListMenu('price','价格',range('price','价格',priceMax,10))}
   ${transportListMenu('times','时间','<h4>时间</h4>'+transportTimeRange('departure','出发')+transportTimeRange('arrival','到达'))}
   ${transportListMenu('duration','耗时',range('duration','耗时',durationMax,5))}
  </div>
  <div class="transport-list-heading">
   <h3>全部行程</h3>
   ${transportListMenu('sort','优选',transportListChoices(transportSortOptions,'best'),transportListIcon('sort'))}
  </div>
 </form>`;
}

function bindTransportSearch(form,initialPassengers,updateResults,applyFilters) {
 const fields=form.elements;
 let passengers=initialPassengers;
 let draft={...passengers};
 const selections={trip:'oneway',cabin:'economy',stops:'any',sort:'best'};
 const choices={trip:transportTripOptions,cabin:transportCabinOptions,stops:transportStopOptions,sort:transportSortOptions};
 const selectedMenu=()=>form.querySelector('.transport-list-menu[open]');
 const closeMenu=menu=>{menu.open=false;menu.querySelector('summary').focus({preventScroll:true});};
 const dateLabel=form.querySelector('[data-date-label]');
 const minutesText=minutes=>String(Math.floor(minutes/60)).padStart(2,'0')+':'+String(minutes%60).padStart(2,'0');
 const updatePassengerMenu=()=>{
  for(const [key,, ,min] of transportPassengerGroups){
   form.querySelector('[data-passenger-count="'+key+'"]').textContent=draft[key];
   form.querySelector('[data-passenger="'+key+'"][data-delta="-1"]').disabled=draft[key]<=min;
  }
 };
 const updateRanges=()=>{
  for(const key of ['price','duration']){
   const field=fields[key];
   field.style.setProperty('--range-fill',100*field.value/field.max+'%');
   form.querySelector('[data-range-output="'+key+'"]').textContent=field.value===field.max ?
    (key==='price'?'不限价格':'不限耗时') : '不超过 '+(key==='price'?transportFare(Number(field.value)):Number(field.value)===0?'0 分钟':transportDuration(Number(field.value)));
  }
  for(const key of ['departure','arrival']){
   const start=Number(fields[key+'Start'].value), end=Number(fields[key+'End'].value);
   const track=fields[key+'Start'].parentElement;
   track.style.setProperty('--range-start',100*start/1440+'%');
   track.style.setProperty('--range-end',100*end/1440+'%');
   form.querySelector('[data-range-output="'+key+'"]').textContent=minutesText(start)+'–'+minutesText(end);
  }
 };
 const filters=()=>({
  stops:selections.stops,sort:selections.sort,price:Number(fields.price.value),duration:Number(fields.duration.value),
  priceActive:fields.price.value!==fields.price.max,durationActive:fields.duration.value!==fields.duration.max,
  departure:[Number(fields.departureStart.value),Number(fields.departureEnd.value)],
  arrival:[Number(fields.arrivalStart.value),Number(fields.arrivalEnd.value)]
 });
 updatePassengerMenu();
 updateRanges();
 form.querySelectorAll('.transport-list-menu').forEach(menu=>menu.addEventListener('toggle',()=>{
  if(!menu.open)return;
  const popup=menu.querySelector('.transport-list-popover');
  popup.style.translate='';
  const outer=form.getBoundingClientRect(), rect=popup.getBoundingClientRect();
  popup.style.translate=Math.max(outer.left-rect.left,Math.min(0,outer.right-rect.right))+'px';
  if(menu.dataset.listMenu==='passengers'){draft={...passengers};updatePassengerMenu();}
 }));
 form.parentElement.addEventListener('click',event=>{
  const menu=selectedMenu();
  if(menu && !menu.contains(event.target))menu.open=false;
  const button=event.target.closest('button');
  if(button?.hasAttribute('data-list-swap')){
   [fields.origin.value,fields.destination.value]=[fields.destination.value,fields.origin.value];
  }
  if(button?.dataset.listChoice){
   const parent=button.closest('.transport-list-menu');
   const key=parent.dataset.listMenu, value=button.dataset.listChoice;
   selections[key]=value;
   parent.querySelector('[data-menu-label]').textContent=key==='stops' && value==='any'?'直达／换乘':choices[key][value];
   parent.querySelectorAll('[data-list-choice]').forEach(choice=>choice.setAttribute('aria-pressed',String(choice===button)));
   closeMenu(parent);
   if(key==='stops' || key==='sort')applyFilters(filters());
  }
  if(button?.dataset.passenger){
   draft[button.dataset.passenger]+=Number(button.dataset.delta);
   updatePassengerMenu();
  }
  if(button?.hasAttribute('data-list-apply')){
   passengers={...draft};
   const parent=button.closest('.transport-list-menu');
   parent.querySelector('[data-menu-label]').textContent=Object.values(passengers).reduce((sum,n)=>sum+n,0);
   closeMenu(parent);
   updateResults(null,passengers,filters());
  }
 });
 form.parentElement.addEventListener('keydown',event=>{
  const menu=selectedMenu();
  if(event.key==='Escape' && menu){event.preventDefault();event.stopPropagation();closeMenu(menu);}
 });
 form.addEventListener('input',event=>{
  const field=event.target;
  if(field.type!=='range')return;
  if(field.name.endsWith('Start'))field.value=Math.min(Number(field.value),Number(fields[field.name.replace('Start','End')].value));
  if(field.name.endsWith('End'))field.value=Math.max(Number(field.value),Number(fields[field.name.replace('End','Start')].value));
  updateRanges();
  applyFilters(filters());
 });
 form.addEventListener('change',event=>{
  if(event.target===fields.date)dateLabel.textContent=fields.date.value?formatDate(fields.date.value):'选择日期';
 });
 form.addEventListener('submit',event=>{
  event.preventDefault();
  updateResults({origin:fields.origin.value,destination:fields.destination.value,date:fields.date.value,...selections},passengers,filters());
 });
}
