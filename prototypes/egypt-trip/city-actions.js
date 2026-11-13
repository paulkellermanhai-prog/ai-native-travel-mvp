let cityNotice=null;

const cityActionIcons={
 save:'<path d="M20.8 5.7a5 5 0 0 0-7 0L12 7.5l-1.8-1.8a5 5 0 0 0-7 7l8.8 8.5 8.8-8.5a5 5 0 0 0 0-7Z"/>',
 add:'<path d="M12 5v14M5 12h14"/>',
 added:'<circle cx="12" cy="12" r="10" fill="#0988e5"/><path d="m7.8 12 2.6 2.7 5.9-6" stroke="white"/>',
 locate:'<path d="M10 7.5c0 2.2-3.5 6.5-3.5 6.5S3 9.7 3 7.5a3.5 3.5 0 0 1 7 0Zm11 5c0 2.2-3.5 6.5-3.5 6.5S14 14.7 14 12.5a3.5 3.5 0 0 1 7 0ZM5 19l2-1m3-1 2-1"/><circle cx="6.5" cy="7.5" r=".8"/><circle cx="17.5" cy="12.5" r=".8"/>',
 share:'<path d="M8 6l4-4 4 4m-4-4v13m-5-5H5v11h14V10h-2"/>'
};

function cityActionsView(){
 const id=state.city;
 const saved=(state.cityInterests||[]).includes(id);
 const plan=state.draft?draftPlan():state.itinerary;
 const added=Boolean(plan?.stops.some(stop=>stop.city===id));
 const button=(name,label,attrs='',showLabel=false,iconName=name)=>action(
  `<svg viewBox="0 0 24 24" aria-hidden="true">${cityActionIcons[iconName]}</svg>${showLabel?`<span class="city-action-label">${label}</span>`:''}`,
  'city-'+name,'city-action-button',`aria-label="${label}" title="${label}" ${attrs}`);
 return '<div class="city-actions" role="group" aria-label="城市操作">'+
  button('share','分享城市')+
  button('locate','在地图上查看城市')+
  button('add',added?(state.draft?'已在草稿':'已加入'):'加入旅程',added?'disabled':'',true,added?'added':'add')+
  button('save',saved?'感兴趣':'保存',`aria-pressed="${saved}"`,true)+'</div>';
}

function cityActionFeedbackView(){
 if(cityNotice?.city!==state.city)return '';
 const link=cityNotice.url?` <a href="${escapeHtml(cityNotice.url)}" target="_blank" rel="noopener">打开地图链接</a>`:'';
 return `<p class="city-action-feedback" role="status">${escapeHtml(cityNotice.text)}${link}</p>`;
}

function addCityToTrip(id){
 const stored=readSavedState();
 state.itinerary=stored?.itinerary || state.itinerary;
 if(!state.draft || state.draft===lastSavedDraft){
  state.draft=stored?.draft ?? null;
  lastSavedDraft=state.draft;
 }
 const previous=state.draft?draftPlan():state.itinerary;
 if(previous?.stops.some(stop=>stop.city===id))return '这个城市已加入';
 if(state.draft && draftIsStale())return '当前行程已更新，请先处理编辑草稿';
 const stops=withStopNights([...(previous?.stops||[]),{city:id,days:null,nights:null}]);
 const date=previous?previous.routeRequest.date:travelConditions().date;
 if(state.draft){
  const old=state.draft;
  state.draft={...old,frames:[...old.frames,{stops,date}]};
  if(saveDraft())return '已加入编辑草稿，停留天数待定';
  state.draft=old;
  return '这次未能加入草稿，请重试';
 }
 const base=previous || {kept:[],lost:[],timing:{},routeRequest:{date}};
 const {conflict,...plan}=planFromFrame(base,{stops,date});
 state.itinerary={...plan,revision:previous?(previous.revision||1)+1:1};
 if(save({itinerary:true}))return '已加入当前行程，停留天数待定';
 state.itinerary=previous;
 return '这次未能加入行程，请重试';
}

async function shareCity(id){
 const city=cities[id];
 const url='https://maps.google.com/?q='+city.geo.join(',');
 try{
  if(navigator.share){
   await navigator.share({title:city.n,url});
   return;
  }
  await navigator.clipboard.writeText(url);
  cityNotice={city:id,text:'城市地图链接已复制'};
 } catch(error){
  if(error.name==='AbortError')return;
  cityNotice={city:id,text:'可打开地图链接后分享。',url};
 }
 if(state.view==='city' && state.city===id)render();
}

function handleCityAction(act){
 remember();
 const id=state.city;
 const city=cities[id];
 if(act==='city-share'){shareCity(id);return;}
 if(act==='city-locate'){
  focusMapPlace(city.n,...city.geo);
  cityNotice=null;tab='map';
 } else if(act==='city-save'){
  const previous=state.cityInterests||[];
  const saved=previous.includes(id);
  state.cityInterests=saved?previous.filter(city=>city!==id):[...previous,id];
  const success=save();
  if(!success)state.cityInterests=previous;
  cityNotice={city:id,text:success?(saved?'已取消感兴趣':'已标记为感兴趣'):'这次未能保存，请重试'};
 } else {
  cityNotice={city:id,text:addCityToTrip(id)};
 }
 render();
}
