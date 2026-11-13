let hypothesisError='';

function hypothesisPlan() {
 const {base,removed}=state.hypothesis;
 if(!removed)return base;
 const stops=withStopNights(base.stops.filter(stop=>stop.city!==removed));
 return planFromFrame(base,{stops,date:base.routeRequest.date});
}

function hypothesisActions() {
 const {source,removed}=state.hypothesis;
 return '<div class="timeline-actions">'+
  action(source==='edit'?'返回原草稿':'返回原方案','hypothesis-back','subtle')+
  action('确认纳入草稿','hypothesis-include','primary',removed?'':'disabled')+'</div>';
}

function hypothesisView() {
 const {base,removed,source}=state.hypothesis;
 const version=base.revision||1;
 const basis=source==='edit'?'以版本 '+version+' 的编辑草稿为基准':'以当前方案版本 '+version+' 为基准';
 const choices=base.stops.map(({city})=>action(cities[city].n,'hypothesis-city:'+city,'subtle',
  `aria-label="预览不去${cities[city].n}" aria-pressed="${city===removed}"`)).join('');
 const header=`<p class="quiet">${basis}</p>
  <div class="hypothesis-choices" role="group" aria-labelledby="hypothesis-question">
   <p id="hypothesis-question">${removed?'试着少去哪一站':'先选一座想暂时不去的城市'}</p><div>${choices}</div>
  </div>`;
 if(!removed)return header;
 const plan=hypothesisPlan();
 const removedStop=base.stops.find(stop=>stop.city===removed);
 const lost=base.kept.filter(item=>item.city===removed);
 const describeDays=days=>days?days+' 天':'待定';
 return `${hypothesisError?`<p class="draft-notices" role="alert">${escapeHtml(hypothesisError)}</p>`:''}
  ${plan.conflict?'<p class="draft-notices" role="status">固定日期与预览天数不一致，纳入后可在草稿中调整。</p>':''}
  ${header}
  <dl class="draft-changes hypothesis-changes">
   <div><dt>城市顺序</dt><dd><span class="quiet">${skeletonTitle(base)}</span><br><strong>${skeletonTitle(plan)}</strong></dd></div>
   <div><dt>全程</dt><dd>${describeDays(base.timing.days)} → <strong>${describeDays(plan.timing.days)}</strong></dd></div>
   <div><dt>少去一站</dt><dd><strong>${cities[removed].n}</strong>${removedStop.days?' · 原停留 '+removedStop.days+' 天':''}</dd></div>
   <div><dt>舍弃体验</dt><dd>${experienceList(lost,'这座城市尚无已列出的体验')}</dd></div>
   <div><dt>保留体验</dt><dd>${experienceList(plan.kept,'暂无已列出的体验')}</dd></div>
  </dl>
  <p class="quiet hypothesis-note">其余城市的停留天数沿用基准。交通方式、耗时和费用待核验。</p>`;
}

function receiveHypothesis(text,ids) {
 const continuing=state.view==='hypothesis';
 const omission=/少去|不去|去掉|删掉|移除|取消|少一座|少一站|跳过/;
 const request=/(如果|假设|假如|要是|试试)/.test(text) && omission.test(text);
 const followup=continuing && (ids.length===1 && text.replace(/[。！？!?\s]/g,'')===cities[ids[0]].n ||
  /^(?:那就|换成|改成|换个|我想看看)?(?:先)?(?:少去|不去|去掉|删掉|移除|跳过)/.test(text));
 if(!request && !followup)return false;
 const fromDraft=state.draft && (state.view==='edit' || (state.view==='route' && state.fromRoute==='edit'));
 const base=continuing ? state.hypothesis.base : fromDraft ? draftPlan() : state.itinerary;
 if(!base || base.stops.length<2){
  say(base?'当前行程只有一站。可以先比较一个多城市方案，再试着少去一站。':'先采用一个包含至少两座城市的方案，就能预览少去一站的变化。');
  return true;
 }
 if(!continuing){
  state.hypothesis={base,source:fromDraft?'edit':'itinerary',effective:state.itinerary,
   frame:fromDraft?state.draft.frames.at(-1):null,removed:null};
 }
 const candidate=ids.length===1 && base.stops.some(stop=>stop.city===ids[0]) ? ids[0] : null;
 state.hypothesis={...state.hypothesis,removed:candidate};
 hypothesisError='';
 clearMapFocus();mapOnly=false;
 if(userLocation){userLocation=null;zoomLevel=1;locationMessage('');}
 move('hypothesis');
 say(candidate?'已预览不去'+cities[candidate].n+'的变化。':ids.length?'请从这个方案里选一座城市预览。':'你想先看看少去哪一站的变化？可以点城市，也可以直接告诉我。');
 return true;
}

function includeHypothesis() {
 const {base,source,effective,frame,removed}=state.hypothesis;
 if(!removed)return;
 const stored=readSavedState();
 const current=stored?.itinerary || state.itinerary;
 const stale=JSON.stringify(current)!==JSON.stringify(effective);
 const draft=state.draft;
 const changedDraft=source==='edit' && (!draft || JSON.stringify(draft.frames.at(-1))!==JSON.stringify(frame));
 const otherDraft=source==='itinerary' && (draft || stored?.draft);
 if(stale || changedDraft || otherDraft){
  state.itinerary=current;
  hypothesisError=otherDraft && !stale?'已有编辑草稿。请继续编辑，再基于草稿发起预览。':'基准已更新。请返回并重新预览。';
  render();
  return;
 }
 const plan=hypothesisPlan();
 const nextFrame={stops:plan.stops,date:base.routeRequest.date};
 state.draft=source==='edit'?{...draft,frames:[...draft.frames,nextFrame]}:
  {base,frames:[{stops:base.stops,date:base.routeRequest.date},nextFrame]};
 if(source==='itinerary')draftDetailsOpen=false;
 const preview=state.hypothesis;
 state.hypothesis=null;
 move('edit');
 if(!saveDraft()){
  state.draft=draft;
  state.hypothesis=preview;
  move('hypothesis');
  hypothesisError=draftError;
  draftError='';
 } else {
  hypothesisError='';
  say('已将不去'+cities[removed].n+'纳入草稿。');
 }
 render(true);
 $('timeline-heading').focus({preventScroll:true});
}
