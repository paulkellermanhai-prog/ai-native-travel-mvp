const transportIcons = {
 connection: '<path d="M3 8h17m-4-4 4 4-4 4M21 16H4m4-4-4 4 4 4"/>',
 car: '<path d="m4 10 2-5h12l2 5M3 16v3m18-3v3M3 16h18v-4a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2zM7 13h.01M17 13h.01"/>',
 bus: '<rect x="4" y="3" width="16" height="16" rx="3"/><path d="M4 12h16M7 19v2m10-2v2M8 15h.01M16 15h.01"/>',
 train: '<rect x="5" y="3" width="14" height="15" rx="4"/><path d="M5 12h14M9 18l-3 4m9-4 3 4M8 20h8M9 15h.01M15 15h.01"/>',
 plane: '<path d="M21 3a2 2 0 0 0-2 0l-6 6-8-2-2 2 7 4-3 3-3-1-2 2 4 2 2 4 2-2-1-3 3-3 4 7 2-2-2-8 6-6a2 2 0 0 0-1-3Z"/>',
 clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
 info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5m0-8h.01"/>'
};

const transportModes = {
 car: {name:'包车', time:'等候上车、跨城驾车和途中休息', experience:'可以约定上车点和休息站。长途乘坐时，舒适度也取决于路况和司机的驾驶风格。'},
 bus: {name:'大巴', time:'两端车站接驳、候车、乘车及途中停靠', experience:'按固定站点上下车，停靠和休息跟随班次安排。'},
 train: {name:'火车', time:'两端车站接驳、候车和乘车', experience:'可以在车上走动。夜车的休息体验取决于座席或卧铺条件。'},
 plane: {name:'飞机', time:'两端机场接驳、值机安检、飞行和取行李', experience:'空中用时通常较短，实际省下多少时间取决于航线和两端机场接驳。'}
};

// Planning ranges for a city-centre to city-centre transfer, without sightseeing stops.
const transportOverviews = {
 north:{
  plane:{duration:'约 4–5 小时', experience:'直飞约 1 小时，卢克索机场离东岸市区较近。开罗去机场、值机安检和落地取行李要另留时间。'},
  train:{duration:'约 10–13 小时', experience:'比大巴更方便起身活动。日车会占去大半天，选夜车则要把卧铺条件和次日休息算进去。'},
  bus:{duration:'约 10–12 小时', experience:'乘车通常就要约 9–10 小时。两端还要去车站，途中能否下车活动要看班次的停靠安排。'},
  car:{duration:'约 9–11 小时', experience:'能从住处直接上车，途中也可约定休息，但在车上仍要坐约 8–10 小时。若对超车、急刹敏感，可以提前请司机开稳一些。'}
 },
 south:{
  train:{duration:'约 4–5 小时', experience:'车程约 3–4 小时，可以在车厢内走动。不同班次的停站数会影响到站时间。'},
  car:{duration:'约 3.5–4.5 小时', experience:'可以从住处直接出发，休息点也能协商。若沿途停留参观神庙，要另外预留时间。'}
 }
};

function transportIcon(name) {
 return `<svg viewBox="0 0 24 24" aria-hidden="true">${transportIcons[name]}</svg>`;
}

const transportBrowse = new Map();
const transportNotices = {
 missing:['尚未指定出行日期','可以先了解接驳方式。具体班次和价格需要按出行日期核验。'],
 conflict:['出行条件有冲突','请先确认日期与天数，再核验适用的安排。'],
 uncovered:['暂无可核验的候选','当前原型未接入班次及报价来源。可以先了解这段连接的接驳要求。'],
 car:['包车 · 待询价','具体车辆、报价和可用性待确认。']
};

function transportBrowsing(id) {
 if(!transportBrowse.has(id))transportBrowse.set(id,{mode:'train',index:0,detail:null,impact:false});
 return transportBrowse.get(id);
}

function transportData(id,view,{date,conflict}) {
 if(id!=='north' || conflict)return null;
 const day=transportSnapshot.date;
 if(!date || (date.mode==='fixed' && date.start<=day && day<=date.end)){
  return view.mode==='plane' ? transportSnapshot : transportFixtures[view.mode] || null;
 }
 return null;
}

function transportDuration(minutes) {
 return minutes ? [Math.floor(minutes/60)+' 小时',minutes%60 ? minutes%60+' 分' : ''].filter(Boolean).join(' ') : '—';
}

function transportFare(amount) {
 return '¥'+amount.toLocaleString('zh-CN');
}

function transportTravelers() {
 return travelerCount(state.tripDetails.companions || {}) || 1;
}

function transportDetail(dataset,{source,code}) {
 return `<p><b>门到门耗时</b> · 还需加上前后接驳、候车或值机等待。</p>
  ${dataset.published ? `<p>时刻为当地计划时间，核对日期为 ${dataset.checked}。票价、余位和退改条件待航司确认。</p>
  <a href="${source}" target="_blank" rel="noopener">查看 Flight.info 的 ${code} 时刻表</a>` :
  `<p>运营商、站点和时刻待核验。当前金额为占位值。</p>
  <a href="${dataset.source}" target="_blank" rel="noopener">${dataset.sourceLabel}</a>`}`;
}

function transportCandidate(dataset, candidate, index, mode, detail, routeName) {
 const {departure,arrival,minutes,transfers,fare,tags=[],analysis,code}=candidate;
 const {published,operator,origin,destination,originCode,destinationCode,logo}=dataset;
 const mark=logo ? `<img class="transport-airline-logo" src="assets/${logo}" alt="">` : transportIcon(mode);
 const travelers=transportTravelers();
 return `<div class="transport-option">
  <section class="transport-candidate" aria-label="${published?'计划航班 '+code:transportModes[mode].name+'方案 '+(index+1)}">
   ${tags.length ? `<div class="transport-tags">${tags.map(tag=>`<span>${tag}</span>`).join('')}</div>` : ''}
   <div class="transport-operator">
    <span class="transport-operator-icon" ${logo ? `role="img" aria-label="${operator}"` : ''}>${mark}</span>
    <div><h4>${routeName}</h4><p>${transportSnapshot.dateLabel}</p><p class="quiet">单程 · ${dataset.category || transportModes[mode].name}</p></div>
   </div>
   <div class="transport-segment">
    <div class="transport-segment-operator">
     ${mark}<b>${operator || '—'}</b><span class="transport-service">${code || '—'}</span>
    </div>
    <div class="transport-stops">
     <b>${originCode || origin || '—'}</b>
     <span class="transport-duration" title="${dataset.segment || '耗时'}"><span class="transport-duration-pill">${transportIcon('clock')}${transportDuration(minutes)}</span></span>
     <b>${destinationCode || destination || '—'}</b>
    </div>
    <div class="transport-stop-times">
     <div><b>${departure || '—'}</b>${originCode ? `<span>${origin}</span>` : ''}</div>
     <div><b>${arrival || '—'}</b>${destinationCode ? `<span>${destination}</span>` : ''}</div>
    </div>
    ${Number.isInteger(transfers) ? `<p class="quiet">${transfers ? transfers+' 次换乘' : published?'直飞':'无需换乘'}</p>` : ''}
   </div>
   <div class="transport-fare">
    <div><strong>${transportFare(fare)}</strong><p class="quiet">总价 ${transportFare(fare*travelers)} · ${travelers} 人</p></div>
    ${action(detail ? '收起详情' : '查看详情','transport-detail:'+index,'subtle',`aria-expanded="${detail}" aria-controls="transport-detail-${index}"`)}
   </div>
   <div id="transport-detail-${index}" class="transport-detail" ${detail?'':'hidden'}>
    ${transportDetail(dataset,candidate)}
   </div>
  </section>
  <div class="transport-analysis ai-content">${aiContentIcon}<p>${analysis}</p></div>
 </div>`;
}

function openTransportList(id,request) {
 const {mode}=transportBrowsing(id);
 let dataset=transportData(id,{mode},travelConditions(request));
 if(!dataset)return;
 const companions=state.tripDetails.companions;
 const passengers={adults:companions?.adults || 1,children:companions?.children || 0,lap:companions?.infants || 0,seat:0};
 const priceMax=Math.max(100,Math.ceil(Math.max(...dataset.candidates.map(candidate=>candidate.fare))/100)*100);
 const durationMax=Math.max(mode==='plane'?360:720,...dataset.candidates.map(candidate=>candidate.minutes || 0));
 const body=$('transport-list-body');
 $('transport-list-title').textContent=mode==='plane'?'航班':transportModes[mode].name;
 body.innerHTML=`<div class="transport-list-session">
  ${transportSearchControls(mode,connectionCities(id),passengers,priceMax,durationMax)}
  <div class="transport-list"></div>
  <p class="transport-list-empty" role="status" hidden></p>
 </div>`;
 const list=body.querySelector('.transport-list');
 const empty=body.querySelector('.transport-list-empty');
 let entries=[];
 const timeValue=value=>{
  const clock=value?.match(/(\d{2}):(\d{2})/);
  return clock ? Number(clock[1])*60+Number(clock[2]) : NaN;
 };
 const inWindow=(time,[start,end])=>{
  const minutes=timeValue(time);
  return (start===0 && end===1440) || (minutes>=start && minutes<=end);
 };
 const applyFilters=({stops,sort,price,duration,priceActive,durationActive,departure,arrival})=>{
  const matches=entries.filter(({candidate})=>
   (stops==='any' || (Number.isInteger(candidate.transfers) && candidate.transfers<=(stops==='direct'?0:1))) &&
   (!priceActive || candidate.fare<=price) &&
   (!durationActive || (candidate.minutes>0 && candidate.minutes<=duration)) &&
   inWindow(candidate.departure,departure) && inWindow(candidate.arrival,arrival)
  );
  if(sort==='price')matches.sort((a,b)=>a.candidate.fare-b.candidate.fare);
  if(sort==='duration')matches.sort((a,b)=>(a.candidate.minutes ?? Infinity)-(b.candidate.minutes ?? Infinity));
  if(sort==='departure')matches.sort((a,b)=>(a.candidate.departure || '99:99').localeCompare(b.candidate.departure || '99:99'));
  list.replaceChildren(...matches.map(({row})=>row));
  empty.textContent=dataset?'没有符合条件的行程，可以调整筛选再试。':'暂无符合这组搜索条件的行程。';
  empty.hidden=matches.length>0;
 };
 const renderEntries=(travelers)=>{
  if(!dataset){entries=[];list.replaceChildren();return;}
  const mark=dataset.logo ? `<img src="assets/${dataset.logo}" alt="">` : transportIcon(mode);
  const stationPair=[dataset.originCode || dataset.origin,dataset.destinationCode || dataset.destination];
  list.innerHTML=dataset.candidates.map(candidate=>{
   const {code,departure,arrival,minutes,transfers,fare}=candidate;
   const connection=Number.isInteger(transfers) ? transfers ? transfers+' 次换乘' : mode==='plane'?'直飞':'无需换乘' : '';
   return `<details class="transport-list-row">
    <summary>
     <span class="transport-list-mark">${mark}</span>
     <span class="transport-list-duration"><b>${transportDuration(minutes)}</b><small>${stationPair.every(Boolean)?stationPair.join(' → '):'站点待核验'}</small></span>
     <span class="transport-list-service"><b>${departure && arrival ? departure+'–'+arrival : '时刻待核验'}</b><small>${[dataset.operator,code,connection].filter(Boolean).join(' · ') || '运营商待核验'}</small></span>
     <span class="transport-list-fare"><b>${transportFare(fare)}</b><small>每人</small><small>总价 ${transportFare(fare*travelers)}</small></span>
     <span class="transport-list-chevron" aria-hidden="true"></span>
    </summary>
    <div class="transport-detail transport-list-detail">
     ${dataset.origin && dataset.destination ? `<p>${dataset.origin} → ${dataset.destination}</p>` : ''}
     ${transportDetail(dataset,candidate)}
    </div>
   </details>`;
  }).join('');
  entries=dataset.candidates.map((candidate,index)=>({candidate,row:list.children[index]}));
 };
 renderEntries(transportTravelers());
 bindTransportSearch(body.querySelector('.transport-search'),passengers,(query,people,filters)=>{
  if(query){
   dataset=query.trip==='oneway' && query.cabin==='economy' && query.date===transportSnapshot.date ?
    transportData(connectionId([query.origin,query.destination]),{mode},{}) : null;
  }
  renderEntries(Object.values(people).reduce((sum,n)=>sum+n,0));
  applyFilters(filters);
 },applyFilters);
 const dialog=$('transport-list-dialog');
 dialog.showModal();
 dialog.scrollTop=0;
}

function transportRecommendations(fixture, view, notice, conflict, routeName) {
 if(!fixture){
  const [title,copy]=transportNotices[notice];
  return `<section class="transport-notice" aria-live="polite"><h3>${title}</h3><p>${conflict || copy}</p></section>`;
 }
 const {candidates}=fixture;
 const {mode,index,detail}=view;
 const count=candidates.length;
 const card=i=>transportCandidate(fixture,candidates[i],i,mode,detail===i,routeName);
 const progress=Math.round(2*index/Math.max(1,count-1));
 return `<section class="transport-recommendations" aria-labelledby="transport-recommendation-title">
  <div class="transport-recommendation-head">
   <h3 id="transport-recommendation-title">优选行程</h3>
  </div>
   <div class="transport-featured" data-transport-carousel tabindex="0" aria-label="精选候选，可用左右方向键切换">
    ${card(index)}
    <div class="transport-carousel-controls">
     ${count>1 ? action('‹','transport-step:-1','city-icon','aria-label="上一条候选"') : ''}
     ${count>1 ? `<div class="transport-dots" aria-hidden="true">${[0,1,2].map(i=>`<span ${i===progress?'data-current':''}></span>`).join('')}</div>` : ''}
     ${count>1 ? action('›','transport-step:1','city-icon','aria-label="下一条候选"') : ''}
     <span class="quiet transport-counter" aria-live="polite">${index+1} / ${count}</span>
     ${action('查看全部','transport-all','textbtn','aria-haspopup="dialog" aria-controls="transport-list-dialog"')}
    </div>
   </div>
 </section>`;
}

function transportConnectionView({id},request) {
 const [from,to]=connectionCities(id).map(city=>cities[city].n);
 const view=transportBrowsing(id);
 const {mode,impact}=view;
 const method=transportModes[mode];
 const overview=transportOverviews[id]?.[mode];
 const conditions=travelConditions(request);
 const {date,dateLabel,days,conflict}=conditions;
 const notice=mode==='car' ? 'car' : conflict ? 'conflict' : date?.mode==='fixed' ? 'uncovered' : 'missing';
 const fixture=transportData(id,view,conditions);
 const conflictText=conflict ? `所选日期覆盖 ${conflict} 天，与你指定的 ${days} 天不同。请确认以哪一项为准。` : '';
 const scope=fixture?.published ? 'Flight.info 计划时刻 · 核对日期 '+fixture.checked :
  fixture ? '12 月 18 日班次及报价待核验' : '数据来源待补充';
 return `<article class="transport-card" aria-labelledby="transport-drawer-title">
  <div class="transport-cities">
   <div class="transport-endpoint"><b>${from}</b><span>出发城市</span></div>
   <div class="transport-city-line">
    <div class="transport-modes" role="group" aria-label="交通方式">
     ${Object.entries(transportModes).map(([key,item])=>
      action(transportIcon(key),'transport-mode:'+key,'transport-mode',
       `aria-label="${item.name}" title="${item.name}" aria-pressed="${key===mode}"`)).join('')}
    </div>
    <p class="transport-mode-name">${method.name}</p>
   </div>
   <div class="transport-endpoint"><b>${to}</b><span>到达城市</span></div>
  </div>
  <section class="transport-overview ai-content" aria-label="AI 交通概览">
   ${aiContentIcon}
   <div>
    <p><b>总耗时</b> <strong>${overview?.duration || '待估算'}</strong></p>
    <p><b>交通体验</b> ${overview?.experience || method.experience}</p>
   </div>
  </section>
  ${transportRecommendations(fixture,view,notice,conflictText,from+' → '+to)}
  ${notice==='car' && conflictText ? `<p class="support">${conflictText}</p>` : ''}
  <footer class="transport-footer">
   <section class="transport-verification" aria-labelledby="transport-verification-title">
    <h3 id="transport-verification-title">${transportIcon('info')}核验条件与重要未知</h3>
    <p class="transport-source">${scope} · 旅行条件：${dateLabel==='日期待定'?'尚未指定出行日期':escapeHtml(dateLabel)}${days?' · 全程 '+days+' 天':''}</p>
    <p class="transport-scope">门到门时间包括${method.time}。地图连线仅表示城市间的地理关系。</p>
   </section>
   ${action('<span><b>了解这段连接对旅行骨架的影响</b><small>查看转场如何影响停留时间、城市顺序和体验安排。</small></span><span aria-hidden="true">›</span>',
     'transport-impact','transport-impact',`aria-expanded="${impact}" aria-controls="transport-impact-detail"`)}
   <div id="transport-impact-detail" class="transport-impact-detail" ${impact?'':'hidden'}>
    从${from}到${to}，可先给门到门转场留出时间，再看两端城市当天还能安排哪些体验。待核验日期、班次和接驳后，再决定是否调整停留或城市顺序。
   </div>
  </footer>
 </article>`;
}

function updateTransportBrowsing(id,act,value,request) {
 const view=transportBrowsing(id);
 if(act==='transport-impact'){view.impact=!view.impact;return;}
 if(act==='transport-mode'){
  if(!Object.hasOwn(transportModes,value))return;
  view.mode=value;
  view.index=0;view.detail=null;
  return;
 }
 const count=transportData(id,view,travelConditions(request))?.candidates.length;
 if(!count)return;
 if(act==='transport-step'){
  view.index=(view.index+Number(value)+count)%count;
  view.detail=null;
 }
 if(act==='transport-detail'){
  const index=Number(value);
  view.detail=view.detail===index ? null : index;
 }
}

function bindTransportNavigation(panel,select) {
 let swipe=null;
 panel.addEventListener('keydown',event=>{
  if(!event.target.closest('[data-transport-carousel]') || !['ArrowLeft','ArrowRight'].includes(event.key))return;
  event.preventDefault();
  select('transport-step:'+(event.key==='ArrowRight'?1:-1));
 });
 panel.addEventListener('pointerdown',event=>{
  const featured=event.target.closest('.transport-featured .transport-option');
  if(!featured || !event.isPrimary || event.button!==0 || event.target.closest('button'))return;
  swipe={id:event.pointerId,x:event.clientX,y:event.clientY};
  panel.setPointerCapture(event.pointerId);
 });
 panel.addEventListener('pointerup',event=>{
  if(swipe?.id!==event.pointerId)return;
  const dx=event.clientX-swipe.x,dy=event.clientY-swipe.y;
  swipe=null;
  if(Math.abs(dx)>55 && Math.abs(dx)>Math.abs(dy)*1.4)select('transport-step:'+(dx<0?1:-1));
 });
 panel.addEventListener('pointercancel',()=>{swipe=null;});
}
