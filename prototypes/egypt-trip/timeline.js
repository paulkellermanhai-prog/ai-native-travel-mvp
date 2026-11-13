function draftPlan() {
 const {base,frames}=state.draft;
 return planFromFrame(base,frames.at(-1));
}

function planFromFrame(base,{stops,date}) {
 const days=stops.every(stop=>stop.days!==null) ? stops.reduce((sum,stop)=>sum+stop.days,0) : undefined;
 const routeRequest={date,days,frozen:true};
 const {dateLabel}=travelConditions(routeRequest);
 const fixedRange=base.routeRequest.date?.mode==='fixed' &&
  (base.routeRequest.date.start!==base.routeRequest.date.end || base.timing.days===1);
 const conflict=Boolean(days && fixedRange && dateSpan(date.start,date.end)!==days);
 const included=new Set(stops.map(stop=>stop.city));
 const kept=base.kept.filter(item=>included.has(item.city));
 const lost=[...base.lost,...base.kept.filter(item=>!included.has(item.city))];
 return {...base,stops,kept,lost,timing:{dateLabel,days,label:dateLabel+' · '+(days?'共 '+days+' 天':'天数待定')},routeRequest,conflict};
}

function withStopNights(stops) {
 return stops.map((stop,index)=>({...stop,nights:stop.days===null?null:stop.days-Number(index===stops.length-1)}));
}

function draftChanged(plan) {
 const {base}=state.draft;
 return JSON.stringify(plan.stops)!==JSON.stringify(base.stops) ||
  JSON.stringify(plan.routeRequest.date)!==JSON.stringify(base.routeRequest.date);
}

function draftIsStale() {
 return JSON.stringify(state.draft.base)!==JSON.stringify(state.itinerary);
}

function timelineView(plan,editing,preview=false) {
 const sortable=editing && plan.stops.length>1;
 const dayTotal=plan.timing.days;
 const remaining=plan.stops.filter(stop=>stop.days===null).length;
 const assigned=plan.stops.reduce((sum,stop)=>sum+(stop.days||0),0);
 const total=dayTotal ? dayTotal+' 天 '+(dayTotal-1)+' 晚' :
  (assigned ? '已分配 '+assigned+' 天 · ' : '')+(remaining ? remaining+' 站待定' : '停留待定');
 return `<div class="timeline-bar">
  <div class="timeline-title"><h2 id="timeline-heading" tabindex="-1">旅行时间轴</h2>
   ${editing?'<span class="tag timeline-editing-badge">编辑中</span>':status(preview?'假设预览':'当前行程')+`<span class="quiet">${total}</span>`}
  </div>
  ${preview ? hypothesisActions() : editing ? '<div class="timeline-actions">'+
   action('撤销','draft-undo','subtle',state.draft.frames.length===1?'disabled':'')+
   action('放弃草稿','draft-discard','subtle')+
   action('完成编辑','draft-finish','primary',(!draftChanged(plan)||plan.conflict||draftIsStale())?'disabled':'')+'</div>' :
   action(state.draft?'继续编辑':'编辑时间轴','draft-start','primary')}
 </div>
 <ol class="timeline-stops" aria-label="城市顺序">${plan.stops.map((stop,index)=>{
  const city=cities[stop.city].n;
  const stay=stop.days===null ? '停留待定' : stop.days+' 天 '+stop.nights+' 晚';
  const move=(label,command,disabled,description)=>action(label,command+':'+stop.city,'timeline-icon',
   `aria-label="${description+city}" ${disabled?'disabled':''}`);
  return `<li class="timeline-stop${sortable?' timeline-sortable':''}" data-city="${stop.city}"
   ${sortable?`tabindex="0" aria-label="${city}，第 ${index+1} 站。可拖动卡片，或用左右方向键调整顺序" aria-keyshortcuts="ArrowLeft ArrowRight"`:''}>
   <div class="timeline-stop-title"><span aria-hidden="true">${index+1}</span><strong>${city}</strong></div>
   <div class="timeline-stay">
    ${editing?move('−','draft-less',stop.days===null||stop.days<=1,'减少一天，'):''}
    <span>${stay}</span>
    ${editing?move('+','draft-more',false,'增加一天，'):''}
   </div>
  </li>`;
 }).join('')}</ol>`;
}

let draftDetailsOpen=false;

function draftView(plan) {
 const base=state.draft.base;
 const oldStops=new Map(base.stops.map(stop=>[stop.city,stop]));
 const stayChanges=plan.stops.filter(stop=>stop.days!==oldStops.get(stop.city)?.days || stop.nights!==oldStops.get(stop.city)?.nights);
 const orderChanged=skeletonTitle(plan)!==skeletonTitle(base);
 const removedExperiences=base.kept.filter(item=>!plan.stops.some(stop=>stop.city===item.city));
 const stay=stop=>!stop?'未安排':stop.days===null?'待定':stop.days+' 天 '+stop.nights+' 晚';
 const notices=(draftError?`<p role="alert">${escapeHtml(draftError)}</p>`:'')+
  (draftIsStale()&&!draftError?'<p role="status">当前行程已更新。此草稿仍基于旧版本，请先核对当前行程。</p>':'')+
  (plan.conflict?`<div class="draft-conflict" role="status">
    <b>日期范围与草稿天数不一致</b>
    <p>固定日期覆盖 ${dateSpan(plan.routeRequest.date.start,plan.routeRequest.date.end)} 天，草稿共 ${plan.timing.days} 天。</p>
    ${action('按草稿天数调整结束日期','draft-align-date','subtle')}
   </div>`:'');
 const change=(label,before,after)=>`<div><dt>${label}</dt><dd><span class="quiet">${before}</span> → <strong>${after}</strong></dd></div>`;
 const changes=(orderChanged?`<div><dt>城市顺序</dt><dd><span class="quiet">原先 ${skeletonTitle(base)}</span><br><strong>改为 ${skeletonTitle(plan)}</strong></dd></div>`:'')+
  stayChanges.map(stop=>change(cities[stop.city].n,stay(oldStops.get(stop.city)),stay(stop))).join('')+
  (removedExperiences.length?`<div><dt>舍弃体验</dt><dd>${experienceList(removedExperiences,'')}</dd></div>`:'')+
  (base.timing.days!==plan.timing.days?change('总天数',base.timing.days?base.timing.days+' 天':'待定',plan.timing.days?plan.timing.days+' 天':'待定'):'')+
  (base.timing.dateLabel!==plan.timing.dateLabel?change('日期',escapeHtml(base.timing.dateLabel),escapeHtml(plan.timing.dateLabel)):'');
 return `${notices?`<div id="draft-notices" class="draft-notices">${notices}</div>`:''}
  ${changes?`<dl class="draft-changes">${changes}</dl>`:'<p class="draft-empty quiet">还没有修改</p>'}
  <details id="draft-details" class="draft-details" ${draftDetailsOpen?'open':''}>
   <summary>查看详情</summary>
   <div class="draft-detail-body">
    <p>基于当前行程版本 ${base.revision||1} · ${skeletonTitle(base)}</p>
    <p>${lastSavedDraft===state.draft?'已保存到此浏览器':'保存未确认'} · 尚未应用</p>
    <h3>草稿跨城连接</h3>
    ${skeletonConnections(plan)}
    ${action('查看当前行程','itinerary')}
   </div>
  </details>`;
}

function updateDraft(act,id,targetIndex) {
 const frame=state.draft.frames.at(-1);
 const stops=frame.stops.map(stop=>({...stop}));
 const index=stops.findIndex(stop=>stop.city===id);
 let date=frame.date;
 if(act==='draft-align-date'){
  const plan=draftPlan();
  if(!plan.conflict)return;
  const end=new Date(Date.parse(date.start)+(plan.timing.days-1)*86400000);
  if(!Number.isFinite(end.getTime()) || end.getUTCFullYear()>9999){
   draftError='草稿天数超出可用日期范围。请减少停留天数。';
   return;
  }
  date={...date,end:end.toISOString().slice(0,10)};
 } else {
  if(index<0)return;
  const stop=stops[index];
  if(act==='draft-more')stop.days=(stop.days||0)+1;
  else if(act==='draft-less'){
   if(stop.days===null || stop.days<=1)return;
   stop.days--;
  } else if(act==='draft-reorder'){
   if(!stops[targetIndex] || index===targetIndex)return;
   stops.splice(targetIndex,0,...stops.splice(index,1));
  }
 }
 state.draft={...state.draft,frames:[...state.draft.frames,{stops:withStopNights(stops),date}]};
 return true;
}

function saveDraft(committing=false) {
 const stored=readSavedState()?.draft ?? null;
 if(JSON.stringify(stored)!==JSON.stringify(lastSavedDraft)){
  draftError='另一个页面已更新草稿。请保留此页面的编辑，重新打开当前行程核对后再继续。';
  return false;
 }
 if(!save({draft:true,itinerary:committing})){
  draftError='这次未能保存到此浏览器，草稿仍保留在页面里。';
  return false;
 }
 lastSavedDraft=state.draft;
 draftError='';
 return true;
}

function editTimeline(act,id,targetIndex) {
 if(act==='draft-start'){
  const stored=readSavedState();
  if(JSON.stringify(state.draft)===JSON.stringify(lastSavedDraft)){
   state.draft=stored?.draft ?? null;
   lastSavedDraft=state.draft;
  }
  state.itinerary=stored?.itinerary || state.itinerary;
  if(!state.itinerary)return;
  const base=state.itinerary;
  if(!state.draft){
   draftDetailsOpen=false;
   state.draft={base,frames:[{stops:base.stops,date:base.routeRequest.date}]};
  }
  cancelComparison();dismiss();clearMapFocus();mapOnly=false;
  if(userLocation){userLocation=null;zoomLevel=1;locationMessage('');}
  move('edit');
  saveDraft();
  render();
  $('timeline-heading').focus({preventScroll:true});
  return;
 }
 if(state.view!=='edit' || !state.draft)return;
 remember();
 if(act==='draft-undo'){
  if(state.draft.frames.length>1){
   state.draft={...state.draft,frames:state.draft.frames.slice(0,-1)};
   clearMapFocus();
   if(userLocation){userLocation=null;zoomLevel=1;locationMessage('');}
   saveDraft();
  }
 } else if(act==='draft-discard' || act==='draft-finish'){
  const draft=state.draft;
  const finishing=act==='draft-finish';
  const previous=state.itinerary;
  const previousDates=state.tripDetails.dates;
  const previousConditions=state.discovery.conditions;
  if(finishing){
   const {conflict,...plan}=draftPlan();
   if(conflict || !draftChanged(plan))return;
   const latest=readSavedState()?.itinerary || previous;
   if(JSON.stringify(latest)!==JSON.stringify(draft.base)){
    state.itinerary=latest;
    draftError='当前行程已更新。此草稿仍基于旧版本，请先核对当前行程。';
    render();return;
   }
   const date=plan.routeRequest.date;
   const dateChanged=JSON.stringify(date)!==JSON.stringify(draft.base.routeRequest.date);
   const flexibleDaysChanged=date?.mode==='flexible' && plan.timing.days!==draft.base.timing.days;
   if(dateChanged || flexibleDaysChanged){
    const dates=flexibleDaysChanged ? {...date,days:plan.timing.days} : date;
    plan.routeRequest={...plan.routeRequest,date:dates};
    state.tripDetails.dates=dates;
    state.discovery.conditions={};
   }
   state.itinerary={...plan,revision:(draft.base.revision||1)+1};
  }
  state.draft=null;
  move('itinerary');
  if(!saveDraft(finishing)){
   state.draft=draft;state.itinerary=previous;state.view='edit';
   state.tripDetails.dates=previousDates;state.discovery.conditions=previousConditions;
  } else {
   clearMapFocus();mapOnly=false;
   if(userLocation){userLocation=null;zoomLevel=1;locationMessage('');}
   if(finishing)say('已完成编辑，当前行程已更新。交通方式、班次和费用仍待核验。');
  }
 } else if(updateDraft(act,id,targetIndex)){
  clearMapFocus();
  if(userLocation){userLocation=null;zoomLevel=1;locationMessage('');}
  saveDraft();
 }
 render();
 if(state.view==='itinerary')$('itinerary-heading').focus({preventScroll:true});
}

function bindTimelineSorting(timeline) {
 let drag=null;
 let scrollFrame=0;

 function showDrop() {
  const {card,list,x,y,startX,startScroll}=drag;
  const bounds=list.getBoundingClientRect();
  card.style.transform='translateX('+(x-startX+list.scrollLeft-startScroll)+'px)';
  const cards=[...list.children].filter(item=>item!==card);
  const next=cards.findIndex(item=>{
   const rect=item.getBoundingClientRect();
   return x<rect.left+rect.width/2;
  });
  drag.marker?.classList.remove('drop-before','drop-after');
  drag.target=null;
  if(x<bounds.left-12 || x>bounds.right+12 || y<bounds.top-16 || y>bounds.bottom+16)return;
  drag.target=next<0?cards.length:next;
  drag.marker=next<0?cards.at(-1):cards[next];
  drag.marker.classList.add(next<0?'drop-after':'drop-before');
 }

 function scrollWhileDragging() {
  if(!drag?.card.isConnected){endDrag();return;}
  const {list,x,y,maxScroll}=drag;
  const bounds=list.getBoundingClientRect();
  if(y>=bounds.top-16 && y<=bounds.bottom+16 && x>=bounds.left-12 && x<=bounds.right+12){
   const before=list.scrollLeft;
   if(x<bounds.left+26)list.scrollLeft-=8;
   else if(x>bounds.right-26)list.scrollLeft=Math.min(maxScroll,before+8);
   if(list.scrollLeft!==before)showDrop();
  }
  scrollFrame=requestAnimationFrame(scrollWhileDragging);
 }

 function endDrag(commit=false) {
  if(!drag)return;
  const {card,list,pointer,target}=drag;
  drag.marker?.classList.remove('drop-before','drop-after');
  card.classList.remove('is-dragging');
  card.style.transform='';
  drag=null;
  cancelAnimationFrame(scrollFrame);
  if(list.hasPointerCapture(pointer))list.releasePointerCapture(pointer);
  if(commit && target!==null && card.isConnected)editTimeline('draft-reorder',card.dataset.city,target);
 }

 timeline.addEventListener('pointerdown',event=>{
  const card=event.target.closest('.timeline-sortable');
  if(!card || drag || event.button!==0 || !event.isPrimary || event.target.closest('button'))return;
  const list=card.parentElement;
  drag={card,list,pointer:event.pointerId,startX:event.clientX,startScroll:list.scrollLeft,
   maxScroll:list.scrollWidth-list.clientWidth,target:null};
  list.setPointerCapture(event.pointerId);
  card.focus({preventScroll:true});
 });
 timeline.addEventListener('pointermove',event=>{
  if(drag?.pointer!==event.pointerId)return;
  if(!drag.active){
   if(Math.abs(event.clientX-drag.startX)<6)return;
   drag.active=true;
   drag.card.classList.add('is-dragging');
   scrollFrame=requestAnimationFrame(scrollWhileDragging);
  }
  drag.x=event.clientX;
  drag.y=event.clientY;
  showDrop();
 });
 timeline.addEventListener('pointerup',event=>{
  if(drag?.pointer!==event.pointerId)return;
  if(drag.active){
   drag.x=event.clientX;
   drag.y=event.clientY;
   showDrop();
  }
  endDrag(true);
 });
 for(const type of ['pointercancel','lostpointercapture']){
  timeline.addEventListener(type,event=>{if(drag?.pointer===event.pointerId)endDrag();});
 }
 timeline.addEventListener('keydown',event=>{
  if(event.key==='Escape' && drag){event.stopPropagation();endDrag();return;}
  if(!event.target.matches('.timeline-sortable') || !['ArrowLeft','ArrowRight'].includes(event.key))return;
  event.preventDefault();
  const card=event.target;
  const index=[...card.parentElement.children].indexOf(card);
  editTimeline('draft-reorder',card.dataset.city,index+(event.key==='ArrowLeft'?-1:1));
 });
}
