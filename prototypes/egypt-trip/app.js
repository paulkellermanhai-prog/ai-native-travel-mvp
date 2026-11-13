const $ = id => document.getElementById(id);
const cities = {
  cairo:{n:'开罗', xy:[269.7,202.3], geo:[30.051906,31.248022], sub:'金字塔与古埃及文明的入口', intro:'从吉萨高原的金字塔到开罗城里的老街，适合第一次建立对埃及的整体印象。', exp:['giza','old']},
  luxor:{n:'卢克索', xy:[366.7,543.1], geo:[25.700019,32.650038], sub:'尼罗河两岸的神庙与王陵', intro:'东岸看神庙，西岸看王陵。想把古埃及历史看得更深，这两类体验值得分开了解。', exp:['karnak','valley']},
  aswan:{n:'阿斯旺', xy:[383.9,666.1], geo:[24.087508,32.898911], sub:'河岛、帆船与慢一点的节奏', intro:'沿尼罗河看河岛与帆船，也可以把一段时间留给岛上的菲莱神庙。', exp:['sail','philae']}
};
const nileCities = Object.keys(cities);
const moreDestinations = [
 ['giza-city', '吉萨', '金字塔、狮身人面像与博物馆', '想看金字塔，可以从吉萨高原开始，再把大埃及博物馆留作单独的一站。', ['giza']],
 ['alexandria', '亚历山大', '地中海海滨与港城历史', '沿海滨大道走走，看看亚历山大图书馆，再留点时间吃海鲜。'],
 ['hurghada', '赫尔格达', '红海海滩、浮潜与出海', '想在看古迹之外安排几天海边假期，可以从赫尔格达的海滩和珊瑚礁开始。'],
 ['sharm', '沙姆沙伊赫', '西奈半岛南端的潜水与度假', '以海湾为落脚点，在珊瑚礁潜水，也可以把一段时间留给西奈沙漠。'],
 ['dahab', '达哈卜', '海边小镇、岸潜与慢节奏', '可以沿海边散步，也可以了解蓝洞一带的浮潜和潜水体验。'],
 ['marsa-alam', '马萨阿拉姆', '南部红海的珊瑚礁与海湾', '如果想把更多时间留给海洋，可以先了解马萨阿拉姆的海湾与潜水点。'],
 ['el-gouna', '艾尔古纳', '潟湖、码头与风筝冲浪', '沿潟湖和码头走走，也可以了解当地的风筝冲浪体验。'],
 ['quseir', '库塞尔', '红海老港与珊瑚礁', '可以把老港街巷和近岸珊瑚礁放在同一次探索里。'],
 ['nuweiba', '努韦巴', '亚喀巴湾与西奈海岸', '想慢一点，可以先看努韦巴的海岸和海边营地。'],
 ['matruh', '马特鲁港', '地中海沙滩与浅蓝海湾', '在埃及北岸留几天，看看马特鲁港的海湾和沙滩。'],
 ['alamein', '阿莱曼', '北岸海滨与二战遗迹', '可以把地中海海滨和当地的二战博物馆、纪念地放在同一站。'],
 ['siwa', '西瓦', '盐湖、棕榈与沙漠绿洲', '可以探索沙利古城、棕榈林和盐湖，感受与海滨城市不同的节奏。'],
 ['fayoum', '法尤姆', '湖泊、沙丘与鲸鱼谷', '从卡伦湖到鲸鱼谷，这里适合了解沙漠地貌和古海洋化石。'],
 ['bahariya', '巴哈里亚绿洲', '绿洲村落与沙漠地貌', '以巴维提为落脚点，了解黑沙漠与白沙漠一带的地貌。'],
 ['suez', '苏伊士', '运河入口与港口风貌', '从苏伊士湾一侧看港口，了解运河如何连接红海与地中海。'],
 ['abu-simbel', '阿布辛贝', '纳赛尔湖畔的巨型岩窟神庙', '看拉美西斯二世的岩窟神庙，并了解它如何迁至今天的湖畔。']
];
for (const [id, n, sub, intro, exp=[]] of moreDestinations) {
 const point = egyptPlaces.find(([name])=>name === (id === 'abu-simbel' ? '阿布辛贝神庙' : n));
 cities[id] = {n, sub, intro, exp, geo:point.slice(1,3)};
}
const experiences = {
  giza:['吉萨金字塔群','在高原上看金字塔的尺度与布局。','从开阔处看三座金字塔的相对位置，也可以走近观察石块与坡面。它提供的是纪念性建筑和荒漠地景的体验。'],
  old:['老开罗街巷','在城里走走，感受不同于古迹的日常。','如果想在大型遗址之外留一点城市时间，可以把散步安排得松一些，按自己感兴趣的街区展开。'],
  karnak:['卡纳克神庙','走进层叠的柱厅与石刻。','从庭院进入柱厅，石柱的尺度和光影是这段体验的重点。如果你对建筑或石刻感兴趣，可以为这里留出从容的参观时间。'],
  valley:['帝王谷','去西岸看山谷里的王陵。','与开阔的神庙不同，这里的看点是山谷中的墓室与壁画。具体开放范围需要按旅行日期另查。'],
  sail:['尼罗河帆船','换一个视角看河岛与河岸。','如果你喜欢慢一点的节奏，可以把帆船当成一段独立体验。水上条件、风况和安排需按出行当天再确认。'],
  philae:['菲莱神庙','从水上接近一座岛屿神庙。','乘船靠近河岛，神庙和河面是同一段体验的一部分。交通安排与开放条件仍需按日期核对。']
};
for (const [cityId, entries] of Object.entries(additionalCityExperiences)) {
 for (const [id, ...content] of entries) {
  experiences[id] = content;
  cities[cityId].exp.push(id);
 }
}
const citySlides = new Map();
let cityFeedbackNotice = null;
const photos={
 giza:{file:'giza',alt:'吉萨高原上的三座金字塔全景',author:'Benjamin Inbar',page:'Giza_Pyramids_Panorama.jpg',license:'BY-SA'},
 karnak:{file:'karnak',alt:'卢克索卡纳克神庙大神柱厅内成排的石柱',author:'Vyacheslav Argenberg',page:'Luxor,_Egypt,_Karnak,_Great_Hypostyle_Hall,_Columns.jpg',license:'BY'},
 sail:{file:'felucca',alt:'阿斯旺尼罗河上一艘张开三角帆的传统帆船',author:'Vyacheslav Argenberg',page:'Nile_River,_Felucca_boat,_Aswan,_Egypt.jpg',license:'BY'}
};
const routes={
 north:{n:'开罗 → 卢克索',xy:[317,385]},
 south:{n:'卢克索 → 阿斯旺',xy:[375,607]}
};
const key='antu-f1-f2-v1';
const initial={active:false,view:'overview',city:'',detail:'',feedback:{},cityReviewPrompted:{},seen:{},task:'',dismissed:[],paused:false,candidate:0,fromRoute:'overview',fromCompare:'overview',positions:{},route:'north',routeRequest:{},comparison:null,itinerary:null,draft:null,hypothesis:null,tripDetails:{}};
let state={...initial}, resumed=false;
const restored=readSavedState();
if(restored){state={...initial,...restored};resumed=Boolean(restored.active);}
state.discovery={likes:[],feedbackCities:{},conditions:{},concern:state.concern?{label:'担心转场太累',ids:['luxor'],conditions:{}}:null,waiting:null,compareLater:false,...state.discovery};
if(state.view==='compare' && !state.comparison) state.view=state.city?'city':'overview';
if(state.view==='edit' && !state.draft) state.view=state.itinerary?'itinerary':'overview';
let open=state.active, compact=false, pop=false, pending=false, mapOnly=false, tab=state.active?'results':'chat', suggestion=null, comparing=false, comparisonTicket=0, error=false;
let adoptionError='';
let drawerExpanded=false, drawerCloseAnimation=null;
let transportPreview=null;
let connectionOrigin='';
let draftError='', lastSavedDraft=state.draft;
let messages=resumed?[{who:'ai',text:'上次浏览的城市与体验还在。你可以从原来的位置继续，也可以换个问题。'}]:[];
const escapeHtml = s => String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const icon = '<span class="spark" aria-hidden="true"><svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="8.5"/><path d="m7 13 2.4-6h3.6l-2.4 6z" fill="currentColor" stroke="none"/></svg></span>';
const aiContentIcon = '<svg class="ai-content-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linejoin="round" aria-hidden="true"><path d="M9 2.5c.8 4 2.5 5.7 6.5 6.5-4 .8-5.7 2.5-6.5 6.5-.8-4-2.5-5.7-6.5-6.5 4-.8 5.7-2.5 6.5-6.5Z"/><path d="M18 10.5c.6 3.3 1.7 4.4 5 5-3.3.6-4.4 1.7-5 5-.6-3.3-1.7-4.4-5-5 3.3-.6 4.4-1.7 5-5Z" fill="currentColor" stroke="none"/></svg>';
const action = (label,cmd,cls='textbtn',attrs='')=>`<button class="${cls}" data-act="${cmd}" ${attrs}>${label}</button>`;
const status = (txt)=>`<span class="tag">${txt}</span>`;
function readSavedState(){
  try{return JSON.parse(localStorage.getItem(key));}catch{return null;}
}
function save(writes={}){
  try{
   const stored=readSavedState();
   const snapshot={...state,
    itinerary:writes.itinerary?state.itinerary:stored?.itinerary||state.itinerary,
    draft:writes.draft?state.draft:stored?.draft??null};
   localStorage.setItem(key,JSON.stringify(snapshot));error=false;
  }
  catch{error=true;}
  return !error;
}
function resultKey(){return state.view+':'+(state.view==='detail'?state.detail:state.view==='city'?state.city:state.view==='route'?state.route:'');}
function remember(){
 if(!open || $('workspace').dataset.layout==='start' || (matchMedia('(max-width:860px)').matches && tab!=='results'))return;
 const scroll=$('results').scrollTop;
 if(transportPreview)transportPreview.scroll=scroll;
 else state.positions[resultKey()]=scroll;
}
const heading=(label,title,intro='')=>`<div class="section-line"><span class="overline">${label}</span></div><h2>${title}</h2>${intro?`<p class="intro">${intro}</p>`:''}`;
function experiencePhoto(id){
 const legacy=photos[id];
 if(legacy)return {...legacy,page:'https://commons.wikimedia.org/wiki/File:'+legacy.page,
  licenseLabel:'CC '+legacy.license+' 4.0',license:'https://creativecommons.org/licenses/'+legacy.license.toLowerCase()+'/4.0/'};
 return experiencePhotos[id];
}
function photoCredit(p) {
 return `<a href="${escapeHtml(p.page)}" target="_blank" rel="noopener">${escapeHtml(p.author)}</a> · <a href="${p.license}" target="_blank" rel="noopener">${p.licenseLabel}</a> · 缩放与裁切`;
}
function photo(id,detail=false){
 const p=experiencePhoto(id);
 if(!p)return '';
 const img=`<img src="assets/${p.file}.webp" alt="${detail?p.alt:''}" ${detail?'':'class="place-thumb"'}>`;
 if(!detail)return img;
 return `<figure class="place-photo">${img}<figcaption>${photoCredit(p)}</figcaption></figure>`;
}
function row(c,id){return action(`${photos[c.exp[0]]?photo(c.exp[0]):''}<span><b>${c.n}</b><small>${c.sub}</small></span><span class="arrow" aria-hidden="true">↗</span>`,'city:'+id,'city-row');}
function chooseConnection(origin) {
 connectionOrigin=origin;
 const dialog=$('connection-picker');
 $('connection-picker-title').textContent=origin?'从'+cities[origin].n+'到哪里？':'从哪里出发？';
 const list=$('connection-picker-list');
 list.innerHTML=Object.entries(cities).filter(([id])=>id!==origin).map(([id,city])=>
  action(`<b>${city.n}</b><span class="arrow" aria-hidden="true">›</span>`,'connection-pick:'+id,'connection-option')).join('');
 if(!dialog.open)dialog.showModal();
 list.scrollTop=0;
 list.querySelector('button').focus();
}
function activeTransport(){return transportPreview || (state.view==='route' ? {id:state.route} : null);}
function attractionCard(id) {
 const [title,summary] = experiences[id];
 const feedback = state.feedback[id];
 const p=experiencePhoto(id);
 const image=p?`<span class="attraction-image"><img src="assets/${p.file}.webp" alt="" loading="lazy"></span>`:'';
 return action(`${image}<span class="attraction-copy"><strong>${title}</strong><small>${summary}</small>
 ${feedback?`<small class="attraction-feedback">${feedback==='yes'?'♥ 感兴趣':'暂不考虑'}</small>`:''}</span>`,'detail:'+id,'attraction-card');
}
function cityExperience() {
 const ids = cities[state.city].exp.slice(0,5);
 const index = citySlides.get(state.city) || 0;
 const complete = index===ids.length;
 const notice = cityFeedbackNotice?.city===state.city
  ? `<p class="city-feedback-notice" role="status">${escapeHtml(cityFeedbackNotice.text)}</p>` : '';
 const header = `<div class="city-carousel-bar">
  <h3 id="city-experience-title" tabindex="-1">体验精选</h3>
  <div class="city-carousel-controls">
   ${action('‹','city-slide:-1','city-icon',`aria-label="上一个体验" ${index===0?'disabled':''}`)}
   <span aria-live="polite">${complete?'已看完':(index+1)+' / '+ids.length}</span>
   ${action('›','city-slide:1','city-icon',`aria-label="下一个体验" ${index>=ids.length-1?'disabled':''}`)}
  </div>
 </div>`;
 if (complete) return header+`<p class="city-slide-complete" tabindex="-1">这组体验已看完。可以回看并修改选择。</p>`+notice;
 const id = ids[index];
 const [title,summary] = experiences[id];
 const [benefit,cost] = experienceTradeoffs[id];
 const feedback = state.feedback[id];
 const p=experiencePhoto(id);
 const cross = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>';
 const heart = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.8 5.7a5 5 0 0 0-7 0L12 7.5l-1.8-1.8a5 5 0 0 0-7 7l8.8 8.5 8.8-8.5a5 5 0 0 0 0-7Z"/></svg>';
 return header+`
 <div class="city-slide-frame">
 ${action(`${p?`<img class="city-slide-photo" src="assets/${p.file}.webp" alt="" draggable="false">`:''}
  <span class="city-drag-label" aria-hidden="true"></span>
  <span class="city-slide-copy"><span><strong>${title}</strong><small>${summary}</small></span><span aria-hidden="true">↗</span></span>`,
  'detail:'+id,'city-slide')}
  <div class="city-slide-actions" role="group" aria-label="${title}的反馈">
   ${action(cross+'不喜欢','city-feedback:no','city-vote',`aria-pressed="${feedback==='no'}"`)}
   ${action(heart+'喜欢','city-feedback:yes','city-vote city-vote-like',`aria-pressed="${feedback==='yes'}"`)}
  </div>
 </div>
 <div class="city-slide-footer"><span>左拖不喜欢 · 右拖喜欢</span>
 ${p?`<details class="city-photo-source"><summary>照片来源</summary><p>${photoCredit(p)}</p></details>`:''}</div>
 <div class="city-experience-notes">
  <h4>体验解读</h4>
  <dl><div><dt>看点</dt><dd>${escapeHtml(benefit)}</dd></div><div><dt>代价</dt><dd>${escapeHtml(cost)}</dd></div></dl>
 </div>${notice}`;
}
function changeCitySlide(step) {
 if (state.view!=='city' || $('city-carousel').querySelector('[data-exiting]')) return;
 const current = citySlides.get(state.city) || 0;
 if (step>0 && current>=Math.min(5,cities[state.city].exp.length)-1) return;
 const next = Math.max(0,Math.min(current+step,Math.min(5,cities[state.city].exp.length)-1));
 if (next === current) return;
 const focused = document.activeElement.dataset.act;
 const wasOnCard = document.activeElement.classList.contains('city-slide');
 citySlides.set(state.city,next);
 $('city-carousel').innerHTML = cityExperience();
 if (focused?.startsWith('city-slide:')) {
  const button = $('city-carousel').querySelector(`[data-act="${focused}"]`);
  (button.disabled ? $('city-carousel').querySelector('.city-slide') : button).focus({preventScroll:true});
 } else if (wasOnCard) $('city-carousel').querySelector('.city-slide').focus({preventScroll:true});
}
function resultDrawerToolbar(content) {
 const layoutLabel = drawerExpanded ? '恢复三栏' : '向右扩展成果抽屉';
 const closeLabel = activeTransport() ? '关闭成果抽屉' : '关闭城市卡片';
 const layoutIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 4v16M2 12h14m-6-6 6 6-6 6"/></svg>';
 return `
  ${content}
  <div class="result-drawer-actions">
   ${action(layoutIcon,'drawer-expand','city-icon city-layout',`aria-label="${layoutLabel}" title="${layoutLabel}" aria-pressed="${drawerExpanded}" aria-controls="results"`)}
   ${action('<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 5 14 14M19 5 5 19"/></svg>','drawer-close','city-icon city-close',`aria-label="${closeLabel}" title="${closeLabel}"`)}
  </div>`;
}

function closeResultDrawer(onClose) {
 if(drawerCloseAnimation)return;
 if(matchMedia('(prefers-reduced-motion: reduce)').matches){onClose();return;}
 const panel=$('results');
 drawerCloseAnimation=panel.animate([
  {transform:getComputedStyle(panel).transform},
  {transform:'translateX(-100%)'}
 ],{duration:220,easing:'ease-in',fill:'forwards'});
 drawerCloseAnimation.finished.then(()=>{
  drawerCloseAnimation.cancel();
  drawerCloseAnimation=null;
  onClose();
 },()=>{});
}

function openTransportPreview(id,returnTo=null) {
 if(!state.active || connectionCities(id).length!==2)return;
 if(!transportPreview && state.view==='route' && state.route===id){
  open=true;tab='results';mapOnly=false;render();
  $('transport-drawer-title').focus({preventScroll:true});
  return;
 }
 drawerCloseAnimation?.cancel();
 drawerCloseAnimation=null;
 remember();
 const opening=!transportPreview;
 if(opening)drawerExpanded=false;
 if(transportPreview?.id!==id)transportPreview={id,scroll:0,returnTo:transportPreview?.returnTo || returnTo};
 open=true;compact=false;mapOnly=false;tab='results';
 render();
 if(opening){
  const slide=$('results').getAnimations().find(animation=>animation.animationName==='result-drawer-enter');
  if(slide){slide.currentTime=0;slide.play();}
 }
 $('transport-drawer-title').focus({preventScroll:true});
}

function closeTransportPreview() {
 if(!transportPreview){closeResultDrawer(()=>interact('route-back'));return;}
 const {id,returnTo}=transportPreview;
 closeResultDrawer(()=>{
  transportPreview=null;
  drawerExpanded=returnTo?.drawerExpanded ?? false;
  open=Boolean(returnTo);
  tab=returnTo?.tab ?? 'map';
  if(returnTo)({compact,mapSearchFocus,zoomLevel,userLocation,pop}=returnTo);
  render();
  const selector=returnTo ? '[data-act="connection-picker"]' : `button[data-act="map-connection:${id}"]`;
  document.querySelector(selector)?.focus({preventScroll:true});
 });
}
function cityCover(id) {
 const cover=cityPhotos[id][0];
 return `<div class="city-cover"><img src="assets/${cover.file}.webp" alt="${escapeHtml(cover.alt)}">
  <div class="city-cover-caption">
   <div><h2 id="city-card-title">${cities[id].n}</h2><span>埃及</span></div>
   ${action('查看更多照片','city-gallery','city-gallery-button')}
  </div>
 </div>`;
}
function openCityGallery() {
 const city=cities[state.city];
 const images=[...cityPhotos[state.city],...city.exp.map(experiencePhoto).filter(Boolean)];
 const unique=[...new Map(images.map(p=>[p.file,p])).values()];
 $('city-gallery-title').textContent=city.n+'的照片';
 $('city-gallery-photos').innerHTML=unique.map(p=>`<figure><img src="assets/${p.file}.webp" alt="${escapeHtml(p.alt)}" loading="lazy">
 <figcaption>${escapeHtml(p.alt)}<small>${photoCredit(p)}</small></figcaption></figure>`).join('');
 $('city-gallery').showModal();
}
function cityView(city) {
 const {summary,more,questions}=cityDecision(state.city);
 return `${cityCover(state.city)}
 ${cityActionFeedbackView()}
 <nav class="city-sections" aria-label="城市卡片导览">
  ${action('概览','city-section:city-introduction-title','','aria-current="location"')}
  ${action('体验精选','city-section:city-experience-title','')}
  ${action('你可能想问','city-section:city-questions-title','')}
  ${action('景点与体验','city-section:city-sights-title','')}
 </nav>
 <section class="city-introduction" id="city-introduction-title" aria-label="概览" tabindex="-1">
  <p class="city-overview-copy">${escapeHtml(summary)}</p>
  <details class="city-read-more"><summary><span>阅读更多</span><span>收起</span></summary><p>${escapeHtml(more)}</p></details>
 </section>
 <section id="city-carousel" class="city-carousel" aria-labelledby="city-experience-title">${cityExperience()}</section>
 <section class="city-questions" aria-labelledby="city-questions-title">
  <h3 id="city-questions-title" tabindex="-1">你可能想问</h3>
  ${questions.map((question,i)=>action(`<span>${escapeHtml(question.label)}</span><span aria-hidden="true">›</span>`,'city-question:'+i,'city-question')).join('')}
 </section>
 <section class="city-sights" aria-labelledby="city-sights-title">
  <h3 id="city-sights-title" tabindex="-1">景点与体验</h3>
  <div class="city-landmarks">${city.exp.map(attractionCard).join('')}</div>
 </section><div class="result-links">${action('查看城市连接','connection-picker')}</div>`;
}
function renderResults(){
 const details=$('draft-details');
 const previousNotice=$('draft-notices')?.textContent;
 if(details)draftDetailsOpen=details.open;
 let html='';
 const transport=activeTransport();
 if(transport) html=transportConnectionView(transport,transportPreview ? undefined : state.routeRequest);
 else if(!state.active) html=heading('旅行成果','先说说你想去哪里','开始探索后，城市与体验会在这里出现。')+action('去对话','tab:chat');
 else if(pending) html=heading('目的地探索','埃及')+'<p class="loading" role="status">正在整理埃及城市与体验</p>';
 else if(state.view==='compare') html=comparisonView();
 else if(state.view==='itinerary') html=itineraryView();
 else if(state.view==='edit') html=draftView(draftPlan());
 else if(state.view==='hypothesis') html=hypothesisView();
 else if(state.view==='detail'){
   const e=experiences[state.detail],c=cities[state.city],f=state.feedback[state.detail];
   const included=state.itinerary?.kept.some(item=>item.label===e[0] && item.city===state.city);
   html=action('← 返回'+c.n,'backcity')+`<div style="margin-top:17px">`+heading(c.n,e[0],e[1])+photo(state.detail,true)+ `<p class="body-copy">${e[2]}</p></div><div class="feedback">`+
   action('感兴趣','feedback:yes','subtle',`aria-pressed="${f==='yes'}"`)+action('暂不考虑','feedback:no','subtle',`aria-pressed="${f==='no'}"`)+
   `</div><p class="quiet" role="status">${f==='yes'?(included?'已记为兴趣 · 当前骨架保留此体验':'已记为兴趣 · 尚未加入行程'):f==='no'?'本次暂不考虑此体验':'可直接返回，稍后再选。'}</p>`+(f?action('清除反馈','feedback:clear','textbtn result-links'):'');
 } else if(state.view==='city'){
   html=cityView(cities[state.city]);
 } else {
   html='<h2 class="destination-title">埃及，想从哪里出发？</h2><p class="intro">去看金字塔和古老神庙，在地中海边散步，到红海潜水，或走进沙漠里的盐湖与绿洲。</p>'+
   `<div class="city-list">${Object.entries(cities).map(([id,c])=>row(c,id)).join('')}</div><div class="result-links">${action('查看城市连接','connection-picker')}${action('比较城市组合','compare','subtle')}</div>`;
 }
 const toolbar=$('result-drawer-toolbar');
 toolbar.hidden=!(state.active && (transport || (!pending && state.view==='city')));
 toolbar.innerHTML=toolbar.hidden?'':resultDrawerToolbar(transport ?
  `<h2 id="transport-drawer-title" tabindex="-1">${transportIcon('connection')}交通</h2>` : cityActionsView());
 $('result-inner').innerHTML=html;
 const notice=$('draft-notices');
 $('results').scrollTop=transportPreview ? transportPreview.scroll :
  notice && notice.textContent!==previousNotice ? 0 : state.positions[resultKey()]||0;
 toolbar.toggleAttribute('data-scrolled',$('results').scrollTop>0);
}
function renderChat(){
 const editing=['edit','hypothesis'].includes(state.view) || (state.view==='route' && state.fromRoute==='edit');
 $('chat-title').innerHTML=state.active?'<b>对话</b>':'';
 $('thread').innerHTML=(!state.active?`<div class="welcome"><h1>想去哪里？</h1><p>说一个地方，我们先看看那里有什么值得去的。</p></div>`:'')+
 messages.map(m=>m.who==='user'?`<div class="message user">${escapeHtml(m.text)}</div>`:
 `<article class="message"><div class="assistant-label">${icon} 安途</div><p class="reply">${escapeHtml(m.text)}</p></article>`).join('')+
 (comparing?'<p class="loading" role="status">正在整理城市比较</p>':'')+
 (state.active && !pending && !editing ? currentSummary() : '')+
 (suggestion && !state.paused?`<aside class="suggestion"><span class="overline">可以接着看</span><h3>${escapeHtml(suggestion.title)}</h3><p>${escapeHtml(suggestion.reason)}</p><div class="result-links">${action(suggestion.label,'accept','primary')}${action('先跳过','skip')}</div></aside>`:'');
 $('prompts').innerHTML=!state.active?`<div class="start-prompt">${action('我想去埃及 ↗','example','subtle')}</div>`:state.paused?`<div class="chat-hint quiet">已暂停主动建议 · ${action('继续探索','resume')}</div>`:state.view==='city' && state.city==='luxor' && !state.discovery.concern?`<div class="chat-hint">${action('喜欢卢克索，但怕转场太累','concern','subtle')}</div>`:'';
 if(error && !(state.view==='edit' && draftError))$('prompts').insertAdjacentHTML('beforeend','<p class="chat-hint quiet" role="status">这次未能保存；当前输入和浏览仍在。</p>');
 $('input').placeholder=state.active?'问安途，或说说你的想法…':'说说你想去哪里…';
}
function setFloatingChat(expanded) {
 $('workspace').toggleAttribute('data-chat-open',expanded);
 $('floating-chat-trigger').setAttribute('aria-expanded',String(expanded));
 if(expanded)$('thread').scrollTop=$('thread').scrollHeight;
}
const zoomSteps = [0.78, 1, 1.28, 1.62, 2.05];
let zoomLevel = 1;
let userLocation = null;
let locationRequest = 0;
let mapSearchFocus = null;
let weatherOpen = false;
const forecasts = new Map();

function weatherName(code) {
 if (code === 0) return '晴';
 if (code <= 3) return code === 3 ? '阴' : '多云';
 if (code <= 48) return '雾';
 if (code >= 95) return '雷雨';
 if ([71, 73, 75, 77, 85, 86].includes(code)) return '雪';
 return '雨';
}
function degree(value) {
 return Number.isFinite(value) ? Math.round(value) + '°' : '—';
}
function renderWeather() {
 const city = cities[state.city] || cities.cairo;
 const forecast = forecasts.get(city.n);
 const data = forecast?.data;
 const expanded = $('weather-details');
 expanded.hidden = !weatherOpen;
 document.querySelector('[data-act=weather]').setAttribute('aria-expanded', String(weatherOpen));
 if (!forecast) loadWeather(city);
 $('weather-summary').innerHTML = data
  ? `<strong>${degree(data.current.temperature_2m)}C</strong> <small>${city.n} · ${weatherName(data.current.weather_code)}</small>`
  : `${city.n}天气${forecast?.failed ? ' · 暂不可用' : ''}`;
 const weatherIcon = document.querySelector('.weather-pill svg');
 if (data?.current.weather_code === 0 && data.current.is_day === 1) {
  weatherIcon.innerHTML = '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>';
 } else if (data && data.current.weather_code !== 0) {
  weatherIcon.innerHTML = '<path d="M7 18a4 4 0 1 1 .8-7.9 5 5 0 0 1 9.7 1 3.5 3.5 0 1 1 .2 7H7Z"/>';
 } else {
  weatherIcon.innerHTML = '<path d="M20.4 15a8.8 8.8 0 0 1-11.5-11A8.8 8.8 0 1 0 20.4 15Z"/>';
 }
 if (!weatherOpen) return;
 const rows = data?.daily.time.map((date, index) =>
  `<div class="forecast-row"><span>${escapeHtml(date.slice(5).replace('-', '/'))}　${weatherName(data.daily.weather_code[index])}</span><span>${degree(data.daily.temperature_2m_min[index])} / ${degree(data.daily.temperature_2m_max[index])}</span></div>`
 ).join('');
 expanded.innerHTML = `<strong>${city.n}天气</strong>` + (rows || (forecast?.failed
  ? '<p>暂时无法取得预报。</p><button class="textbtn" data-act="weather-retry">重试</button>'
  : '<p role="status">正在获取预报…</p>')) +
  '<div><a href="https://open-meteo.com/" target="_blank" rel="noopener">天气数据 · Open-Meteo</a></div>';
}
async function loadWeather(city) {
 forecasts.set(city.n, {});
 const [latitude, longitude] = city.geo;
 const params = new URLSearchParams({
  latitude, longitude, timezone:'Africa/Cairo', forecast_days:3,
  current:'temperature_2m,weather_code,is_day', daily:'weather_code,temperature_2m_min,temperature_2m_max'
 });
 try {
  const response = await fetch('https://api.open-meteo.com/v1/forecast?' + params, {signal:AbortSignal.timeout(8000)});
  if (!response.ok) throw new Error('weather request failed');
  const data = await response.json();
  if (!data.current || !Array.isArray(data.daily?.time)) throw new Error('weather response incomplete');
  forecasts.set(city.n, {data});
 } catch {
  forecasts.set(city.n, {failed:true});
 }
 renderWeather();
}
function locationMessage(text, canReturn=false) {
 const status = $('location-status');
 status.hidden = !text;
 status.textContent = text;
 if (canReturn) status.insertAdjacentHTML('beforeend', action('返回埃及地图','return-map','return-map'));
}
function mapCoordinates(latitude, longitude, west=27.35, north=32.55, span=9.25) {
 const mercator = angle => Math.asinh(Math.tan(angle * Math.PI / 180)) * 180 / Math.PI;
 return {
  x:(longitude-west)/span*100,
  y:(mercator(north)-mercator(latitude))/span*640/8.4
 };
}
function updateMapSearch() {
 const query = $('map-search-input').value.trim().toLocaleLowerCase();
 const terms = query.split(/\s+/);
 const matches = egyptPlaces.map(([name, , , area, aliases], id) => ({name, area, aliases, id}))
  .filter(place => terms.every(term => `${place.name} ${place.area} ${place.aliases}`.toLocaleLowerCase().includes(term)))
  .sort((a,b) => Number(b.name.startsWith(query))-Number(a.name.startsWith(query)));
 const results = matches.slice(0, query ? 12 : 6);
 $('map-search-status').textContent = !query ? '热门地点' : !matches.length ? '未找到地点，试试其他名称' :
  matches.length > results.length ? `显示前 ${results.length} 条结果` : `${matches.length} 个结果`;
 $('map-search-results').innerHTML = results.map(({name, area, id}) =>
  action(`<span>${escapeHtml(name)}</span><small>${area === '城市' ? area : '景点 · '+escapeHtml(area)}</small>`, 'map-place:'+id, 'map-search-result')
 ).join('');
}
function toggleMapSearch(open, restoreFocus=false) {
 const panel = $('map-search-panel');
 const button = document.querySelector('[data-act=map-search]');
 panel.hidden = !open;
 button.setAttribute('aria-expanded', String(open));
 if (open) {
  updateMapSearch();
  $('map-search-input').focus();
  $('map-search-input').select();
 } else if (restoreFocus) {
  button.focus();
 }
}
function clearMapFocus() {
 if (!mapSearchFocus) return;
 mapSearchFocus = null;
 zoomLevel = 1;
}
function focusMapPlace(name, latitude, longitude) {
 const point = mapCoordinates(latitude, longitude);
 const wide = point.x < 1 || point.x > 99 || point.y < 1 || point.y > 99;
 mapSearchFocus = {name, wide, ...(wide ? mapCoordinates(latitude, longitude, 24.5, 32.75, 12.25) : point)};
 locationRequest++;
 userLocation = null;
 document.querySelector('[data-act=locate]').disabled = false;
 locationMessage('');
 zoomLevel = 3;
}
function locate() {
 const button = document.querySelector('[data-act=locate]');
 if (!navigator.geolocation) {
  locationMessage('当前浏览器无法定位');
  return;
 }
 const request = ++locationRequest;
 button.disabled = true;
 locationMessage('正在获取当前位置…');
 navigator.geolocation.getCurrentPosition(({coords}) => {
  if (request !== locationRequest) return;
  const {latitude, longitude} = coords;
  const {x,y} = mapCoordinates(latitude, longitude);
  const regional = x >= 0 && x <= 100 && y >= 0 && y <= 100;
  mapSearchFocus = null;
  userLocation = regional ? {x,y,regional} : {x:(longitude+180)/3.6,y:(90-latitude)/1.8,regional};
  zoomLevel = regional ? 2 : 1;
  button.disabled = false;
  locationMessage(regional ? '当前位置' : '当前位置 · 全球底图', true);
  renderMap();
 }, error => {
  if (request !== locationRequest) return;
  button.disabled = false;
  locationMessage(error.code === 1 ? '位置权限未开启，请在浏览器中允许定位' : '暂时无法获取当前位置，请重试', Boolean(userLocation));
 }, {timeout:10000, maximumAge:0});
}
function renderMap(){
 const comparingCities=state.view==='compare';
 const adopted=state.view==='itinerary';
 const editing=state.view==='edit';
 const preview=state.view==='hypothesis';
 const stops=editing ? draftPlan().stops : preview ? hypothesisPlan().stops : adopted ? state.itinerary.stops : [];
 const activeConnection=state.view==='route';
 const routeCities=activeConnection ? connectionCities(state.route) : [];
 const enabled=comparingCities ? state.comparison.options[state.candidate] : stops.length ? stops.map(stop=>stop.city) : activeConnection ? routeCities : nileCities;
 const selectedConnection=activeTransport()?.id;
 const selectedPair=selectedConnection ? connectionCities(selectedConnection) : [];
 const pinned=[...new Set([...enabled,...selectedPair])];
 const visible=!userLocation&&!mapSearchFocus&&(state.active||pending);
 const wide=visible && pinned.some(id=>{
  const {x,y}=mapCoordinates(...cities[id].geo);
  return x<2 || x>98 || y<2 || y>98;
 });
 const point=id=>{
  const {x,y}=wide ? mapCoordinates(...cities[id].geo,24.5,32.75,12.25) : mapCoordinates(...cities[id].geo);
  return wide || !cities[id].xy ? [x*6.4,y*8.4] : cities[id].xy;
 };
 $('map-title').hidden=Boolean(mapSearchFocus);
 document.querySelector('[data-act=map-search-reset]').hidden=!mapSearchFocus;
 $('map-title').textContent=userLocation?'当前位置':comparingCities?'候选 '+(state.candidate+1):preview?'假设预览':editing?'草稿预览':adopted?'当前行程':'埃及';
 const geographicLinks=activeConnection || comparingCities || stops.length ? [enabled] : Object.keys(routes).map(connectionCities);
 const pairs=geographicLinks.flatMap(ids=>ids.slice(1).map((to,i)=>[ids[i],to]));
 if(selectedPair.length===2 && !pairs.some(pair=>connectionId(pair)===selectedConnection)){
  const reverse=pairs.findIndex(([from,to])=>from===selectedPair[1] && to===selectedPair[0]);
  if(reverse===-1)pairs.push(selectedPair);
  else pairs[reverse]=selectedPair;
 }
 const mapConnections=pairs.map(pair=>{
  const id=connectionId(pair);
  const [a,b]=pair.map(point);
  const position=(!wide && !activeConnection && !comparingCities && !stops.length && routes[id]?.xy)
   || [(a[0]+b[0])/2,(a[1]+b[1])/2];
  return {id,pair,position,points:[a,b].map(p=>p.join(',')).join(' '),focused:selectedConnection===id};
 });
 $('pins').innerHTML=visible?pinned.map((id,index)=>{
  const c=cities[id], [x,y]=point(id);
  const stop=stops[index];
  const stay=stop && (editing || preview) ? stop.days===null ? ' · 待定' : ' · '+stop.days+' 天' : '';
  return action(`<i aria-hidden="true">${stop?index+1:''}</i><span>${c.n+stay}</span>`,'pin:'+id,stop?'pin ordered-pin':'pin',
   `aria-label="查看${c.n+stay}" aria-pressed="${state.city===id&&!comparingCities}" style="left:${x/6.4}%;top:${y/8.4}%"`);
 }).join('')+
 mapConnections.map(({id,pair,position:[x,y],focused})=>action('看连接','map-connection:'+id,'link-pin',
  `aria-label="查看${cities[pair[0]].n}至${cities[pair[1]].n}交通连接" aria-pressed="${focused}" aria-controls="results" style="left:${x/6.4}%;top:${y/8.4}%"`)).join(''):'';
 $('links').innerHTML=visible ? mapConnections.map(({id,points,focused})=>`
  <polyline points="${points}" stroke="${focused?'#1763ac':editing||preview?'#365a77':activeConnection?'#255b50':'#779689'}" stroke-width="${focused?3:2}" stroke-dasharray="5 7" fill="none"/>
  <polyline class="map-connection-hit" points="${points}" data-act="map-connection:${id}" aria-hidden="true"/>`).join('') : '';
 const c=cities[state.city];
 $('map-pop').innerHTML=!userLocation&&!mapSearchFocus&&pop&&c?`<div class="map-pop"><div class="section-line"><strong>${c.n}</strong>${action('×','closepop','close','aria-label="关闭城市浮层"')}</div><p>${c.sub}</p>${action(preview?'查看体验取舍 ↗':editing?'查看修改摘要 ↗':'查看城市体验 ↗','showcity')}</div>`:'';
 const atlas = $('atlas');
 const world = Boolean(userLocation && !userLocation.regional);
 atlas.classList.toggle('world', world);
 const base = atlas.querySelector('.basemap');
 const source = world ? 'assets/world-basemap.svg' : (mapSearchFocus?.wide || wide) ? 'assets/egypt-wide.svg' : 'assets/egypt-basemap.svg';
 if (base.getAttribute('src') !== source) base.src = source;
 const {x,y} = userLocation || mapSearchFocus || {x:50,y:50};
 atlas.style.transformOrigin = `${x}% ${y}%`;
 atlas.style.transform = `translate(${50-x}%, ${50-y}%) scale(${zoomSteps[zoomLevel]})`;
 if (userLocation) $('pins').innerHTML = `<span class="current-location" role="img" aria-label="当前位置" style="left:${x}%;top:${y}%"></span>`;
 if (mapSearchFocus) $('pins').innerHTML = `<div class="map-search-pin" role="status" style="left:${x}%;top:${y}%"><i aria-hidden="true"></i><span>${escapeHtml(mapSearchFocus.name)}</span></div>`;
 atlas.querySelector('svg').setAttribute('aria-hidden', String(world));
 $('map').setAttribute('aria-label', world ? '全球定位地图' : '埃及地图');
 $('map-legend').hidden = !visible || geographicLinks.every(ids=>ids.length<2);
 document.body.classList.toggle('map-only',mapOnly);
 document.querySelector('[data-act=zoom-in]').disabled = zoomLevel === zoomSteps.length - 1;
 document.querySelector('[data-act=zoom-out]').disabled = zoomLevel === 0;
 const full=document.querySelector('[data-act=fullscreen]');
 const label = mapOnly ? '收起地图' : '向左展开地图';
 full.setAttribute('aria-label',label);
 full.setAttribute('aria-pressed',String(mapOnly));
 full.title=label;
 renderWeather();
}
function render(bottom=false){
 const scroll=$('thread').scrollTop, focus=document.activeElement;
 $('identity').innerHTML=state.active?'<strong>埃及旅行</strong>':'<strong>新旅行</strong>';
 const transport=activeTransport();
 const cityCard=!transport && state.view==='city';
 const drawer=Boolean(transport || cityCard);
 const floatingChat=open && (compact || (drawer && drawerExpanded));
 $('workspace').dataset.layout=open?(floatingChat?'compact':'three'):'start';
 if(!floatingChat)setFloatingChat(false);
 $('workspace').dataset.tab=tab;
 $('workspace').dataset.view=transport?'transport':state.view;
 $('workspace').toggleAttribute('data-result-drawer',drawer && open);
 $('workspace').dataset.drawerExpanded=String(drawer && drawerExpanded && open);
 $('results').setAttribute('aria-labelledby',transport?'transport-drawer-title':cityCard?'city-card-title':'results-title');
 const timeline=$('itinerary-timeline');
 const timelineScroll=timeline.querySelector('.timeline-stops')?.scrollLeft||0;
 const editing=state.view==='edit';
 const preview=state.view==='hypothesis';
 const plan=editing?draftPlan():preview?hypothesisPlan():state.view==='itinerary'?state.itinerary:null;
 timeline.hidden=!plan;
 $('workspace').dataset.timeline=String(Boolean(plan));
 timeline.innerHTML=plan?timelineView(plan,editing,preview):'';
 if(plan)timeline.querySelector('.timeline-stops').scrollLeft=timelineScroll;
 const resultsTitle=$('results-title');
 resultsTitle.hidden=drawer;
 if(editing || preview)resultsTitle.innerHTML='<h2 class="draft-panel-title">'+(preview?'少去一座城':'修改摘要')+'</h2>';
 else {
  const title=state.view==='compare'?'旅行方案':state.view==='itinerary'?'行程总览':'目的地探索';
  resultsTitle.innerHTML='<b>'+title+'</b>';
 }
 document.querySelectorAll('[data-act=itinerary]').forEach(b=>{b.hidden=!state.itinerary;});
 const activeTab=tab==='results' && state.view==='itinerary' ? 'itinerary' : 'tab:'+tab;
 document.querySelectorAll('.mobile-tabs button').forEach(b=>b.setAttribute('aria-current',String(b.dataset.act===activeTab)));
 for(const [id,show,txt,expanded] of [['results-toggle',state.active,open?'收起成果':'展开成果',open],['chat-toggle',open,floatingChat?'展开对话':'收起对话',!floatingChat]]){
   $(id).hidden=!show; $(id).textContent=txt; $(id).setAttribute('aria-expanded',String(expanded));
 }
 renderTripPill();renderResults();renderChat();renderMap();
 const interestButton=document.querySelector('[data-act=rail-interests]');
 const interestLabel=state.cityInterests?.length?'感兴趣的城市和体验':'感兴趣的体验';
 interestButton.setAttribute('aria-label',interestLabel);
 interestButton.title=interestLabel;
 $('thread').scrollTop=bottom?$('thread').scrollHeight:scroll;
 if(focus?.dataset.act && !focus.isConnected){
   const next=[...document.querySelectorAll('button[data-act]')].find(b=>b.dataset.act===focus.dataset.act && b.getClientRects().length);
   const stop=next?.closest('.timeline-stop');
   const target=stop && next.disabled ? stop.querySelector('button:not(:disabled)') : next;
   target?.focus({preventScroll:true});
   stop?.scrollIntoView({block:'nearest',inline:'nearest'});
 }
 if(focus?.matches('.timeline-sortable') && !focus.isConnected){
   const stop=timeline.querySelector(`[data-city="${focus.dataset.city}"]`);
   stop?.focus({preventScroll:true});
   stop?.scrollIntoView({block:'nearest',inline:'nearest'});
 }
}
function move(view){
 remember();
 drawerCloseAnimation?.cancel();drawerCloseAnimation=null;
 if(activeTransport()){transportPreview=null;drawerExpanded=false;}
 state.view=view;open=true;tab='results';pop=false;
}
function dismiss(){
 if(suggestion && !state.dismissed.includes(suggestion.key))state.dismissed.push(suggestion.key);
 suggestion=null;
}
function say(text){messages.push({who:'ai',text});}
function start(onReady){
 state.active=true;open=true;pending=true;tab='chat';state.task='了解埃及';
 render(true);
 setTimeout(()=>{
   pending=false;
   say('可以先选一种体验：看古迹，去地中海边散步，到红海潜水，或进沙漠看绿洲。点左侧的城市卡片，可以看介绍和地图位置。');
   if(onReady){onReady();return;}
   if(tab==='chat'&&matchMedia('(max-width:860px)').matches)tab='results';
   save();render(true);
 },460);
}
function route(id,conditions={}){
 clearMapFocus();mapOnly=false;
 if(userLocation)interact('return-map');
 dismiss();if(state.view!=='route')state.fromRoute=state.view==='compare' ? state.fromCompare : state.view;
 move('route');state.route=id;state.routeRequest=conditions;
 const ids=connectionCities(id);
 const concern=state.discovery.concern;
 if(concern && concern.ids.join('~')===ids.join('~')) concern.viewed=true;
 state.task=cityNames(ids)+'的转场';
}
function compare(ids,conditions={},text='',options){
 if(comparing)return;
 dismiss();
 const interestCities=[...new Set(interestEntries().map(item=>item.city).filter(Boolean))];
 ids=ids?.length ? ids : interestCities;
 if(ids.length<2){
   state.discovery.waiting={kind:'compare',ids,conditions};
   say(ids.length ? '你想拿'+cities[ids[0]].n+'和哪座城市比较？' : '你想比较哪两座城市？');
   tab='chat';mapOnly=false;save();render(true);return;
 }
 state.discovery.waiting=null;
 state.discovery.compareLater=false;
 if(state.view!=='compare')state.fromCompare=state.view==='route' ? state.fromRoute : state.view;
 comparing=true;const ticket=++comparisonTicket;render(true);
 setTimeout(()=>{
   if(ticket!==comparisonTicket)return;
   comparing=false;clearMapFocus();mapOnly=false;
   if(userLocation)interact('return-map');
   state.comparison={options:options || comparisonOptions(ids,text),conditions};
   adoptionError='';
   move('compare');state.candidate=0;state.task='比较'+cityNames(ids);
   say('我把'+cityNames(ids)+'放在一起比较。先看各自的体验和转场取舍，候选都还没采用。');
   save();render(true);
 },320);
}
function cancelComparison(){if(comparing){comparisonTicket++;comparing=false;}}
function backToExploration(view){
 move(view);
 if(state.city && !nileCities.includes(state.city) && ['city','detail'].includes(view))focusMapPlace(cities[state.city].n,...cities[state.city].geo);
}
function send(text,replay=false){
 text=text.trim();if(!text||pending)return;
 cancelComparison();if(!replay)messages.push({who:'user',text});suggestion=null;$('input').value='';
 const ids=mentionedCities(text);
 if(receiveHypothesis(text,ids)){
  if(state.active)save();
  render(true);
  if(state.view==='hypothesis')$('timeline-heading').focus({preventScroll:true});
  return;
 }
 const namedRoute=namedConnection(text);
 const discovery=state.discovery;
 const waiting=discovery.waiting;
 const postpone=/(?:先不|暂不|不要|不用|不想|不急着|没必要|稍后再|以后再|不)\s*(?:做|看|进行|帮我)?\s*(?:比较|对比|规划|安排)|(?:比较|对比)(?:先放一放|待会|晚点|以后再)/.test(text);
 const wantsCompare=/比较|对比|安排|规划|区别|差别|选哪|之间选/.test(text);
 const wantsRoute=namedRoute.length>0 || /交通|火车|航班|车程|路上|怎么走|怎么去|如何去|怎么到|转场|[到去往].*多久/.test(text);
 const concern=/怕|担心|顾虑|介意|在意/.test(text) && !/不(?:再|用)?(?:怕|担心|介意|在意)|没有顾虑/.test(text);
 const askSummary=/目前理解|现在知道|总结|梳理|刚才的取舍|之前.*担心|下一步|接下来/.test(text);
 const changesConditions=/\d+\s*[天月日]|[一二两三四五六七八九十]+天|\d{4}-\d{1,2}-\d{1,2}/.test(text);
 if(!state.active){
   if(/埃及|egypt/i.test(text)||ids.length){start(!postpone && (wantsRoute || wantsCompare || ids.length || changesConditions) ? ()=>send(text,true) : null);return;}
   say('目前可以先探索埃及。你可以从想看的城市或体验开始。');
 } else if(/暂停|先不聊|停止建议|不要再推荐/.test(text)){
   state.paused=true;say('好，先暂停主动建议。你浏览过的体验和表达过的兴趣还在。');
 } else if(postpone){
   discovery.compareLater=true;discovery.waiting=null;
   if(state.view==='compare')backToExploration(state.fromCompare);
   say('好，先继续探索。想比较时再告诉我。');
 } else if(/删掉|删除|移除/.test(text)){
   say(state.itinerary?'你想调整的是当前行程里的哪一项？当前骨架已保留。':'目前还没有采用行程。你想暂不考虑哪一项体验？');
 } else {
   if(!askSummary)recordInterests(text);
   const continuesWaiting=waiting && (ids.length || changesConditions) && !/有什么|好玩|景点|体验/.test(text) &&
    !(waiting.kind==='route' && wantsCompare) && !(waiting.kind==='compare' && wantsRoute);
   const relevant=state.view==='compare' && !ids.length && (wantsCompare || changesConditions) ? state.comparison : null;
   const updatesRoute=state.view==='route' && changesConditions && !ids.length && !concern && !wantsRoute && !wantsCompare && !continuesWaiting;
   const tripTiming=changesConditions && !wantsCompare && !wantsRoute && !relevant && !updatesRoute && !continuesWaiting && !concern;
   const previous=continuesWaiting ? waiting.conditions : updatesRoute ? state.routeRequest : tripTiming ? discovery.conditions : relevant?.conditions || {};
   const conditions=chatConditions(text,previous);
   const selected=continuesWaiting ? (ids.length>=2 ? ids : [...new Set(waiting.kind==='route' && waiting.singleRole!=='from' ? [...ids,...waiting.ids] : [...waiting.ids,...ids])]) :
    relevant ? [...new Set(relevant.options.flat())] : ids;
   if(conditions.date===null || conditions.days===0){
    if(continuesWaiting || wantsCompare || wantsRoute)discovery.waiting={kind:continuesWaiting ? waiting.kind : wantsCompare ? 'compare' : 'route',ids:selected,conditions:previous,singleRole:waiting?.singleRole};
    say('这个日期或天数读不通。可以用「12 月 10 日到 14 日」或「5 天」再写一次吗？');
   } else if(askSummary && !wantsCompare){
    say('我把已记录的兴趣、顾虑和待决定的事列在下面。');
    suggestion=nextSuggestion({allowExplore:true});
   } else if(wantsCompare || relevant || (continuesWaiting && waiting.kind==='compare')){
    compare(selected,conditions,text,relevant?.options);return;
   } else if(concern && !wantsRoute && !/折腾|换乘|接驳|跨城/.test(text)){
    const subject=text.match(/(?:担心|顾虑|介意|在意|怕)([^，。；！？]{2,32})/)?.[1];
    if(subject)discovery.concern={kind:'other',label:'在意'+subject,ids,conditions};
    say('记下这项顾虑了。可以继续看感兴趣的地方，等需要取舍时一起考虑。');
    suggestion=nextSuggestion({allowExplore:true});
   } else if(concern || wantsRoute || (continuesWaiting && waiting.kind==='route') || updatesRoute){
    const linked=namedRoute.length ? namedRoute : selected.length===2 ? selected : selected.length===1 && discovery.concern?.ids.length===2 &&
     discovery.concern.ids.includes(selected[0]) ? discovery.concern.ids : selected.slice(0,1);
    if(concern){
     const label=/费用|价格|贵/.test(text)?'担心交通花费':/换乘|接驳/.test(text)?'担心换乘和接驳':/时间|耗时|太久/.test(text)?'担心转场占用太多时间':'担心转场太累';
     const prior=discovery.concern;
     discovery.concern={label,ids:linked,conditions,viewed:prior?.label===label && prior.ids.join('~')===linked.join('~') && JSON.stringify(prior.conditions)===JSON.stringify(conditions) && prior.viewed};
    }
    if(continuesWaiting && waiting.kind==='route' && discovery.concern && linked.length===2){
     discovery.concern={...discovery.concern,ids:linked,conditions,viewed:false};
    }
    if(updatesRoute){
     state.routeRequest=conditions;
     say('已更新这段连接的查看条件。具体班次与费用仍待核验。');
    } else if((wantsRoute && !concern) || continuesWaiting){
     if(linked.length===2 && (selected.length<=2 || namedRoute.length)){
      discovery.waiting=null;route(connectionId(linked),conditions);
      say('先看'+cities[linked[0]].n+'到'+cities[linked[1]].n+'这段连接。班次、耗时和费用仍待核验。');
     } else {
      const singleRole=waiting?.kind==='route' && !ids.length ? waiting.singleRole : linked.length && text.includes('从'+cities[linked[0]].n) ? 'from' : 'to';
      discovery.waiting={kind:'route',ids:linked,conditions,singleRole};
      say(selected.length>2 ? '你想先查其中哪两座城市之间的连接？' : linked.length ? (singleRole==='from' ? '从'+cities[linked[0]].n+'出发，你要去哪里？' : '你是要从哪座城市出发去'+cities[linked[0]].n+'？') : '你想查哪一段转场？请告诉我起点和终点。');
     }
    } else if(concern){
     discovery.waiting=null;
     say('记下了：'+discovery.concern.label+'。判断是否值得多停一站时，可以一起看接驳、等待和在途时间。');
     suggestion=nextSuggestion();
    }
   } else if(tripTiming){
    discovery.conditions=conditions;
    say('记下这趟旅行的时间条件了：'+travelConditions().label+'。');
    suggestion=nextSuggestion();
   } else if(ids.length){
    discovery.waiting=null;
    const city=ids[0];
    clearMapFocus();mapOnly=false;move('city');state.city=city;state.task=cities[city].n;
    if(!nileCities.includes(city))focusMapPlace(cities[city].n,...cities[city].geo);
    say(cities[city].intro);
    suggestion=nextSuggestion();
   } else {
    say('可以继续看地图和体验，也可以告诉我你想比较哪些城市。');
    suggestion=nextSuggestion();
   }
 }
 if(state.active)save();render(true);
}
function toggleRailInterests(open, restoreFocus=false) {
 const button = document.querySelector('[data-act=rail-interests]');
 $('rail-interests').hidden = !open;
 button.setAttribute('aria-expanded', String(open));
 if (open) {
  const savedCities=state.cityInterests||[];
  const liked = Object.keys(experiences).filter(id=>state.feedback[id] === 'yes');
  $('rail-interests-title').textContent=savedCities.length?'感兴趣的城市和体验':'感兴趣的体验';
  $('rail-interests-list').innerHTML = savedCities.length || liked.length ? savedCities.map(id=>
   action(cities[id].n+' <small>城市</small>','city:'+id,'map-search-result')
  ).join('')+liked.map(id=>
   action(escapeHtml(experiences[id][0]),'rail-experience:'+id,'map-search-result')
  ).join('') : '<p class="quiet">在体验详情里点「感兴趣」，就能在这里找到它。</p>';
 } else if (restoreFocus) button.focus();
}
function interact(cmd,exitFrame){
 const [act,id]=cmd.split(':');let bottom=false;
 let showCityReview=false;
 let cityVote=null;
 if(pending && ['city','pin','route'].includes(act))return;
 if(['home','city','pin','overview','detail','route-back','compare-back'].includes(act)){cancelComparison();}
 switch(act){
 case 'home':clearMapFocus();if(state.active){dismiss();move('overview');state.city='';mapOnly=false;}else tab='chat';break;
 case 'trip-field':openTripDialog(id);return;
 case 'rail-chat':
   mapOnly=false;
   tab='chat';
   render();
   $('input').focus();
   return;
 case 'rail-interests':toggleRailInterests($('rail-interests').hidden);return;
 case 'rail-experience':
   toggleRailInterests(false);
   clearMapFocus();
   dismiss();
   mapOnly=false;
   move('detail');
   state.city=Object.keys(cities).find(city=>cities[city].exp.includes(id));
   if (!nileCities.includes(state.city)) focusMapPlace(cities[state.city].n,...cities[state.city].geo);
   state.detail=id;
   break;
 case 'rail-search':
   tab='map';
   render();
   toggleMapSearch($('map-search-panel').hidden, true);
   return;
 case 'example':send('我想去埃及');return;
 case 'concern':send('喜欢卢克索的古迹，但怕转场太累');return;
 case 'results':
   if(activeTransport() && open){closeTransportPreview();return;}
   remember();open=!open;break;
 case 'chat-open':
   setFloatingChat(true);
   $('input').focus({preventScroll:true});
   return;
 case 'chat-minimize':
   setFloatingChat(false);
   $('floating-chat-trigger').focus({preventScroll:true});
   return;
 case 'chat-full':
 case 'chat':
   remember();
   if((activeTransport() || state.view==='city') && drawerExpanded){drawerExpanded=false;compact=false;}
   else compact=!compact;
   if(act==='chat-full'){
    render(true);
    $('input').focus({preventScroll:true});
    return;
   }
   if(transportPreview){render(true);return;}
   bottom=true;break;
 case 'tab':
   remember();tab=id;
   if(transportPreview){render();return;}
   if(id==='map')dismiss();
   break;
 case 'overview':clearMapFocus();dismiss();move('overview');state.city='';drawerExpanded=false;break;
 case 'drawer-expand':
   if(!activeTransport() && state.view!=='city')return;
   remember();drawerExpanded=!drawerExpanded;compact=false;mapOnly=false;
   render();
   return;
 case 'drawer-close':
   if(activeTransport())closeTransportPreview();
   else closeResultDrawer(()=>interact('overview'));
   return;
 case 'map-connection':openTransportPreview(id);return;
 case 'connection-picker':chooseConnection(state.view==='city' ? state.city : '');return;
 case 'connection-picker-close':$('connection-picker').close();return;
 case 'connection-pick': {
   if(!connectionOrigin){chooseConnection(id);return;}
   const returnTo={tab,drawerExpanded,compact,mapSearchFocus,zoomLevel,userLocation,pop};
   $('connection-picker').close();
   clearMapFocus();zoomLevel=1;userLocation=null;pop=false;
   openTransportPreview(connectionId([connectionOrigin,id]),returnTo);
   return;
 }
 case 'transport-mode':
 case 'transport-step':
 case 'transport-detail':
 case 'transport-impact': {
   if(!activeTransport())return;
   const focus=document.activeElement;
   remember();
   updateTransportBrowsing(activeTransport().id,act,id,transportPreview ? undefined : state.routeRequest);
   renderResults();
   const target=[...$('results').querySelectorAll('[data-act]')].find(control=>control.dataset.act===focus.dataset.act)
    || (act==='transport-step' ? $('results').querySelector('[data-transport-carousel]') : null);
   target?.focus({preventScroll:true});
   if(act==='transport-detail')target?.scrollIntoView({block:'nearest'});
   return;
 }
 case 'transport-all':
   if(activeTransport())openTransportList(activeTransport().id,transportPreview ? undefined : state.routeRequest);
   return;
 case 'transport-list-close':$('transport-list-dialog').close();return;
 case 'city-gallery':openCityGallery();return;
 case 'city-gallery-close':$('city-gallery').close();return;
 case 'city-question': {
   const question=cityDecision(state.city).questions[Number(id)];
   if(!question)return;
   remember();
   messages.push({who:'user',text:question.label});
   say(question.answer);
   drawerExpanded=false;compact=false;mapOnly=false;tab='chat';
   render(true);
   $('input').focus({preventScroll:true});
   return;
 }
 case 'city-section': {
   const target=$(id);
   document.querySelector('.city-sections [aria-current]')?.removeAttribute('aria-current');
   document.querySelector(`[data-act="city-section:${id}"]`).setAttribute('aria-current','location');
   target.focus({preventScroll:true});
   target.scrollIntoView({block:'start'});
   return;
 }
 case 'city-save':
 case 'city-add':
 case 'city-locate':
 case 'city-share':
   if(state.view==='city')handleCityAction(act);
   return;
 case 'pin':
 case 'city':
   if(act==='pin' && ['edit','hypothesis'].includes(state.view)){state.city=id;pop=true;break;}
   mapOnly=false;
   clearMapFocus();
   dismiss();move('city');state.city=id;
   if (!nileCities.includes(id)) focusMapPlace(cities[id].n,...cities[id].geo);
   pop=act==='pin';if(pop&&matchMedia('(max-width:860px)').matches)tab='map';break;
 case 'closepop':pop=false;break;
 case 'showcity':open=true;tab='results';pop=false;mapOnly=false;break;
 case 'detail':dismiss();move('detail');state.detail=id;state.seen[id]=true;break;
 case 'backcity':move('city');break;
 case 'city-slide':changeCitySlide(Number(id));return;
 case 'city-feedback': {
   if ($('city-carousel').querySelector('[data-exiting]')) return;
   remember();
   const ids = cities[state.city].exp.slice(0,5);
   const index = citySlides.get(state.city) || 0;
   const experience=ids[index];
   if(!experience)return;
   state.feedback[experience]=id;
   state.discovery.feedbackCities[experience]=state.city;
   cityVote={city:state.city,text:`已将「${experiences[experience][0]}」标记为${id==='yes'?'喜欢':'不喜欢'}。`};
   const next=nextSuggestion();
   bottom=Boolean(next && suggestion?.key!==next.key);
   suggestion=next;
   const unreviewed=ids.findIndex(place=>!['yes','no'].includes(state.feedback[place]));
   const nextIndex=index+1===ids.length && unreviewed>=0 ? unreviewed : index+1;
   citySlides.set(state.city,nextIndex);
   if(!state.cityReviewPrompted[state.city] && unreviewed===-1){
    state.cityReviewPrompted[state.city]=true;
    showCityReview=true;
   }
   break;
 }
 case 'city-review-continue': {
   $('city-review-panel').close();
   const sights=$('city-sights-title');
   sights.focus({preventScroll:true});
   sights.scrollIntoView({block:'start'});
   remember();save();
   return;
 }
 case 'city-review-elsewhere':
   $('city-review-panel').close();
   interact('overview');
   return;
 case 'feedback':
   remember();if(id==='clear')delete state.feedback[state.detail];else state.feedback[state.detail]=id;
   state.discovery.feedbackCities[state.detail]=state.city;
   suggestion=nextSuggestion();bottom=Boolean(suggestion);
   break;
 case 'route-back':backToExploration(state.fromRoute);break;
 case 'accept': {
   const next=suggestion;
   if(!next)return;
   if(next.kind==='compare'){compare(next.ids);return;}
   if(next.kind==='route'){route(connectionId(next.ids),next.conditions);break;}
   if(next.kind==='explore'){interact('city:'+next.ids[0]);return;}
   suggestion=null;state.discovery.waiting={kind:'route',ids:next.ids,conditions:next.conditions};
   say(next.ids.length?'你打算从哪座城市出发去'+cities[next.ids[0]].n+'？':'你想查看哪两座城市之间的转场？');
   tab='chat';bottom=true;break;
 }
 case 'skip':dismiss();break;
 case 'resume':state.paused=false;suggestion=nextSuggestion();bottom=Boolean(suggestion);break;
 case 'compare':
   if(new Set(interestEntries().map(item=>item.city).filter(Boolean)).size>=2)compare();
   else compare(['cairo','luxor','aswan'],{},'',[['cairo','luxor'],['cairo','luxor','aswan']]);
   return;
 case 'candidate':clearMapFocus();remember();state.candidate=Number(id);tab='map';break;
 case 'jump-tradeoffs':
   $('tradeoffs-title').focus({preventScroll:true});
   $('tradeoffs-title').scrollIntoView({block:'start'});
   return;
 case 'compare-back':state.discovery.compareLater=true;backToExploration(state.fromCompare);break;
 case 'skeleton-route': {
   const source=state.view;
   const request=source==='edit'?draftPlan().routeRequest:source==='itinerary'?state.itinerary.routeRequest:state.comparison.conditions;
   route(id,request);
   state.fromRoute=source;
   break;
 }
 case 'adopt-skeleton': {
   if(state.view!=='compare' || comparing)return;
   const plan=buildSkeletons(state.comparison)[Number(id)];
   if(!plan || plan.issue)return;
   const previous=state.itinerary;
   const savedItinerary=readSavedState()?.itinerary || null;
   if(JSON.stringify(savedItinerary)!==JSON.stringify(previous)){
    state.itinerary=savedItinerary;
    adoptionError='当前行程已在另一个页面更新。请重新核对取舍后再采用。';
    render();return;
   }
   move('itinerary');
   state.itinerary={...plan,revision:previous?(previous.revision||1)+1:1};
   state.positions['itinerary:']=0;
   adoptionError=save({itinerary:true})?'':'这次未能保存方案。你可以重试。';
   if(adoptionError){state.itinerary=previous;state.view='compare';}
   else {
    clearMapFocus();mapOnly=false;
    if(userLocation){userLocation=null;zoomLevel=1;locationMessage('');}
    say('已采用'+skeletonTitle(plan)+'的旅行骨架。交通和费用仍待核验。');
   }
   render(!adoptionError);
   if(!adoptionError)$('itinerary-heading').focus({preventScroll:true});
   return;
 }
 case 'itinerary':
   state.itinerary=readSavedState()?.itinerary || state.itinerary;
   if(!state.itinerary)return;
   cancelComparison();dismiss();clearMapFocus();mapOnly=false;
   if(userLocation){userLocation=null;zoomLevel=1;locationMessage('');}
   move('itinerary');break;
 case 'reopen-compare':
   if(!state.comparison)return;
   clearMapFocus();mapOnly=false;move('compare');break;
 case 'hypothesis-city':
   if(state.view!=='hypothesis' || !state.hypothesis.base.stops.some(stop=>stop.city===id))return;
   state.hypothesis={...state.hypothesis,removed:id};
   hypothesisError='';
   clearMapFocus();pop=false;
   if(userLocation){userLocation=null;zoomLevel=1;locationMessage('');}
   break;
 case 'hypothesis-back':
   if(state.view!=='hypothesis')return;
   move(state.hypothesis.source==='edit' && state.draft?'edit':state.itinerary?'itinerary':'overview');
   state.hypothesis=null;
   clearMapFocus();mapOnly=false;
   if(userLocation){userLocation=null;zoomLevel=1;locationMessage('');}
   break;
 case 'hypothesis-include':
   if(state.view==='hypothesis')includeHypothesis();
   return;
 case 'draft-start':
 case 'draft-undo':
 case 'draft-discard':
 case 'draft-finish':
 case 'draft-more':
 case 'draft-less':
 case 'draft-align-date':
   editTimeline(act,id);return;
 case 'fullscreen': {
   const map = $('map');
   const left = map.getBoundingClientRect().left;
   mapOnly = !mapOnly;
   if (mapOnly) {
    map.style.setProperty('--map-inset', Math.max(0,left-document.querySelector('.side-nav').offsetWidth-3)+'px');
    dismiss();
   }
   render();
   return;
 }
 case 'zoom-in':zoomLevel=Math.min(zoomLevel+1,zoomSteps.length-1);renderMap();return;
 case 'zoom-out':zoomLevel=Math.max(zoomLevel-1,0);renderMap();return;
 case 'map-search':toggleMapSearch($('map-search-panel').hidden);return;
 case 'map-place': {
  const [name, latitude, longitude] = egyptPlaces[Number(id)];
  focusMapPlace(name, latitude, longitude);
  toggleMapSearch(false, true);
  renderMap();
  return;
 }
 case 'map-search-reset':mapSearchFocus=null;zoomLevel=1;renderMap();return;
 case 'locate':locate();return;
 case 'return-map':userLocation=null;zoomLevel=1;locationMessage('');renderMap();return;
 case 'weather':weatherOpen=!weatherOpen;renderWeather();return;
 case 'weather-retry':loadWeather(cities[state.city]||cities.cairo);renderWeather();return;
 default:return;
 }
 if(state.active){
  const saved=save();
  if(cityVote)cityFeedbackNotice=saved?cityVote:{...cityVote,text:'这次偏好未能保存。可以回看卡片并重试。'};
 }
 const finish=()=>{
  render(bottom);
  if(showCityReview){
   $('city-review-message').textContent=`想继续看看${cities[state.city].n}的景点与体验，还是换个地方？`;
   $('city-review-panel').showModal();
  }
  if(bottom)requestAnimationFrame(()=>$('thread').scrollTop=$('thread').scrollHeight);
 };
 if(exitFrame && !matchMedia('(prefers-reduced-motion: reduce)').matches){
  const direction=id==='yes'?1:-1;
  const from=getComputedStyle(exitFrame).transform;
  exitFrame.setAttribute('data-exiting','');
  exitFrame.animate([
   {transform:from,opacity:1},
   {transform:`translateX(${direction*(exitFrame.offsetWidth+56)}px) rotate(${direction*12}deg)`,opacity:0}
  ],{duration:200,easing:'ease-out',fill:'forwards'}).finished.then(()=>{
   if(exitFrame.isConnected)finish();
  });
 } else finish();
}
document.addEventListener('click',e=>{
 const b=e.target.closest('button[data-act],.map-connection-hit');
 if (!$('map-search-panel').hidden && !e.target.closest('#map-search-panel,[data-act=map-search],[data-act=rail-search]')) toggleMapSearch(false);
 if (!$('rail-interests').hidden && !e.target.closest('#rail-interests,[data-act=rail-interests]')) toggleRailInterests(false);
 if(b)interact(b.dataset.act);
});
bindTimelineSorting($('itinerary-timeline'));
bindTransportNavigation($('results'),interact);
$('map-search-input').addEventListener('input',updateMapSearch);
$('map-search-input').addEventListener('keydown',e=>{
 if(e.key==='Enter'&&!e.isComposing){
  e.preventDefault();
  $('map-search-results').querySelector('button')?.click();
 }
});
const openFloatingComposer=()=>{
 if($('workspace').dataset.layout==='compact' && !$('workspace').hasAttribute('data-chat-open') && matchMedia('(min-width:861px)').matches){
  setFloatingChat(true);
 }
};
$('composer').addEventListener('submit',e=>{e.preventDefault();if($('input').value.trim())openFloatingComposer();send($('input').value);});
$('input').addEventListener('focus',openFloatingComposer);
$('input').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();$('composer').requestSubmit();}});
$('city-review-panel').addEventListener('cancel',e=>{
 e.preventDefault();
 $('city-review-panel').close();
 $('city-carousel').querySelector('.city-slide,.city-slide-complete')?.focus({preventScroll:true});
});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!document.querySelector('dialog[open]')){if(!$('rail-interests').hidden)toggleRailInterests(false,true);else if(!$('map-search-panel').hidden)toggleMapSearch(false,true);else if(weatherOpen)interact('weather');else if(mapOnly)interact('fullscreen');else if($('workspace').hasAttribute('data-chat-open')&&$('chat').contains(e.target)&&matchMedia('(min-width:861px)').matches)interact('chat-minimize');else if(activeTransport()&&open)closeTransportPreview();else if(pop)interact('closepop');}});
let scrollSave;
let citySwipe = null;
let suppressCitySlideClick = false;
$('results').addEventListener('pointerdown',e=>{
 const card=e.target.closest('.city-slide');
 if (!card || !e.isPrimary || e.button!==0) return;
 suppressCitySlideClick=false;
 citySwipe={id:e.pointerId,x:e.clientX,y:e.clientY,frame:card.closest('.city-slide-frame')};
 card.setPointerCapture(e.pointerId);
});
$('results').addEventListener('pointermove',e=>{
 if(citySwipe?.id!==e.pointerId)return;
 const {frame,x,y}=citySwipe;
 const dx=e.clientX-x,dy=e.clientY-y;
 if(!frame.hasAttribute('data-dragging') && (Math.abs(dx)<10 || Math.abs(dx)<=Math.abs(dy)))return;
 frame.setAttribute('data-dragging','');
 frame.style.setProperty('--drag-x',dx+'px');
 frame.style.setProperty('--drag-rotation',Math.max(-10,Math.min(dx/24,10))+'deg');
 frame.dataset.direction=dx>0?'right':'left';
 frame.querySelector('.city-drag-label').textContent=dx>0?'喜欢':'不喜欢';
});
$('results').addEventListener('pointerup',e=>{
 if (!citySwipe || citySwipe.id!==e.pointerId) return;
 const x=e.clientX-citySwipe.x, y=e.clientY-citySwipe.y;
 const frame=citySwipe.frame;
 citySwipe=null;
 const horizontal=Math.abs(x)>=10 && Math.abs(x)>Math.abs(y);
 suppressCitySlideClick=horizontal;
 const threshold=Math.min(72,Math.max(35,frame.offsetWidth*.18));
 if(horizontal && Math.abs(x)>=threshold)interact('city-feedback:'+(x>0?'yes':'no'),frame);
 else frame.removeAttribute('data-dragging');
});
$('results').addEventListener('pointercancel',()=>{
 citySwipe?.frame.removeAttribute('data-dragging');
 citySwipe=null;
});
$('results').addEventListener('click',e=>{
 if (e.detail && suppressCitySlideClick && e.target.closest('.city-slide')) {
  e.stopPropagation();
  suppressCitySlideClick=false;
 }
});
$('results').addEventListener('keydown',e=>{
 if (!e.target.closest('#city-carousel') || !['ArrowLeft','ArrowRight'].includes(e.key)) return;
 e.preventDefault();
 changeCitySlide(e.key==='ArrowRight'?1:-1);
});
$('results').addEventListener('scroll',()=>{
 const scrolled=$('results').scrollTop>0;
 $('result-drawer-toolbar').toggleAttribute('data-scrolled',scrolled);
 if(!scrolled && state.view==='city'){
  document.querySelector('.city-sections [aria-current]')?.removeAttribute('aria-current');
  document.querySelector('.city-sections button')?.setAttribute('aria-current','location');
 }
 clearTimeout(scrollSave);
 scrollSave=setTimeout(()=>{if(state.active&&open){remember();if(!transportPreview)save();}},150);
},{passive:true});
if (['city','detail'].includes(state.view) && cities[state.city] && !nileCities.includes(state.city)) {
 const city = cities[state.city];
 focusMapPlace(city.n,...city.geo);
}
render(true);
