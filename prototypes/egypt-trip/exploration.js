function mentionedCities(text) {
 const lower = text.toLowerCase();
 return Object.entries(cities).map(([id,city])=>{
  const english = egyptPlaces.find(place=>place[0]===city.n)?.[4].match(/^[A-Za-z]+(?:[ -][A-Za-z]+)*/)?.[0].trim();
  const index = lower.indexOf(city.n);
  return [id,index>=0 ? index : english ? lower.search(new RegExp('\\b'+english+'\\b','i')) : -1];
 }).filter(([,index])=>index>=0).sort((a,b)=>a[1]-b[1]).map(([id])=>id);
}

function cityNames(ids) {
 return ids.map(id=>cities[id].n).join('、');
}

function namedConnection(text) {
 const names=Object.fromEntries(Object.entries(cities).map(([id,c])=>[c.n,id]));
 const citiesPattern=Object.keys(names).sort((a,b)=>b.length-a.length).join('|');
 const pair=text.match(new RegExp('('+citiesPattern+')\\s*(?:怎么|如何)?\\s*(?:到|去|往|→|至|前往)\\s*('+citiesPattern+')'));
 return pair && pair[1]!==pair[2] ? [names[pair[1]],names[pair[2]]] : [];
}

function dateSpan(start,end) {
 return Math.round((Date.parse(end)-Date.parse(start))/86400000)+1;
}

function chatConditions(text, previous={}) {
 const conditions = {...previous};
 const duration = text.match(/(\d+|[一二两三四五六七八九十]{1,3})\s*天/);
 if(duration){
  const number = duration[1];
  const digits = '零一二三四五六七八九';
  const digit = value => digits.indexOf(value.replace('两','二'));
  const [tens,ones] = number.split('十');
  conditions.days = /^\d+$/.test(number) ? Number(number) : ones!==undefined ?
   10*(tens ? digit(tens) : 1)+(ones ? digit(ones) : 0) : digit(number);
  if(!Number.isSafeInteger(conditions.days)||conditions.days<1) conditions.days=0;
 }
 const pattern = /(?:(\d{4})\s*年\s*)?(\d{1,2})\s*月\s*(\d{1,2})\s*(?:日|号)?|\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g;
 const parts = [...text.matchAll(pattern)];
 if(parts.length){
  const [first,second] = parts;
  const shortEnd = text.slice(first.index+first[0].length).match(/^\s*(?:到|至|[—–～~－-])\s*(\d{1,2})(?:\s*(?:日|号)|(?=\s*(?:[，。；,;]|$)))/);
  const year = Number(first[1]||first[4])||new Date().getFullYear();
  const month = Number(first[2]||first[5]), day = Number(first[3]||first[6]);
  const calendarDay = (y,m,d)=>{
   const date = new Date(y,m-1,d);
   return date.getMonth()===m-1 && date.getDate()===d ? dateKey(date) : '';
  };
  const start = calendarDay(year,month,day);
  const endMonth = Number(second?.[2]||second?.[5])||month;
  const endYear = Number(second?.[1]||second?.[4])||year+(endMonth<month ? 1 : 0);
  const end = second || shortEnd ? calendarDay(endYear,endMonth,Number(second?.[3]||second?.[6]||shortEnd?.[1])) : start;
  conditions.date = start && end && end>=start ? {mode:'fixed',start,end} : null;
 } else {
  const monthOnly = text.match(/(?:(\d{4})\s*年\s*)?(\d{1,2})\s*月/);
  if(monthOnly) {
   const [,year,month] = monthOnly;
   conditions.date = Number(month)>=1 && Number(month)<=12 ?
    {mode:'flexible',month:(year||new Date().getFullYear())+'-'+month.padStart(2,'0')} : null;
  }
 }
 return conditions;
}

function travelConditions(request={}) {
 const trip=request.frozen ? {} : state.discovery.conditions;
 const savedDates=request.frozen ? undefined : state.tripDetails.dates;
 const date = request.date || trip.date || savedDates;
 const fixed = date?.mode==='fixed';
 const rangeDays = fixed && (date.end>date.start || (!request.date && !trip.date)) ? dateSpan(date.start,date.end) : 0;
 const explicitDays = request.days ?? (!request.date ? trip.days : undefined);
 const days = explicitDays ?? (rangeDays || date?.days || trip.days || savedDates?.days);
 const dateYear = fixed && date.start.slice(0,4)!==String(new Date().getFullYear()) && date.start.slice(0,4)===date.end.slice(0,4) ? date.start.slice(0,4)+' 年 ' : '';
 const dateLabel = fixed ? dateYear+
  (date.start===date.end ? formatDate(date.start) : date.start.slice(0,4)===date.end.slice(0,4) ?
   tripSummary('dates',date) : date.start+' 至 '+date.end) :
  date?.month ? Number(date.month.slice(-2))+' 月内灵活出发' :
  typeof date==='string' ? date : '日期待定';
 return {date, days, dateLabel, label:[dateLabel,days ? '共 '+days+' 天' : '天数待定'].join(' · '),
  conflict:explicitDays && rangeDays>1 && days!==rangeDays ? rangeDays : 0};
}

function connectionCities(id) {
 if(id==='north') return ['cairo','luxor'];
 if(id==='south') return ['luxor','aswan'];
 return id.split('~').filter(city=>Object.hasOwn(cities,city));
}

function connectionId(ids) {
 if(ids.join('~')==='cairo~luxor') return 'north';
 if(ids.join('~')==='luxor~aswan') return 'south';
 return ids.join('~');
}

function comparisonOptions(ids, text='') {
 if(!/[+＋→]|还是|或者/.test(text)) return ids.map(id=>[id]);
 const groups = text.split(/还是|或者|对比|相比|和|与|[；;]/).map(mentionedCities).filter(ids=>ids.length);
 return groups.length>=2 && groups.some(group=>group.length>1) ? groups : ids.map(id=>[id]);
}

function interestEntries() {
 const recorded = Object.entries(state.feedback).filter(([id,v])=>v==='yes' && experiences[id]).map(([id])=>({
  label:experiences[id][0], city:state.discovery.feedbackCities[id] || Object.keys(cities).find(city=>cities[city].exp.includes(id))
 }));
 return [...new Map([...recorded,...state.discovery.likes].map(entry=>[entry.label,entry])).values()];
}

const experienceTradeoffs = {
 giza:['站在高原上看三座金字塔的尺度与布局。','遗址开阔，要留出步行和往返吉萨的时间。'],
 old:['在市场和街巷里感受老开罗的日常。','人流和步行速度会影响节奏，行程宜留余量。'],
 'egyptian-museum':['把石像、棺椁和日常器物放在一起看，认识古埃及的不同时期。','馆藏多，可以先挑主题，给室内参观留出一段完整时间。'],
 'cairo-citadel':['把城防、清真寺和老开罗的城市景观串起来看。','山丘上的几个看点分散，参观要留出坡道和步行时间。'],
 'hanging-church':['从教堂和周边街巷了解开罗的科普特文化。','如要入内，先确认当天开放，并留出街区步行时间。'],
 karnak:['在大神柱厅看石柱、浮雕与光影的变化。','遗址范围大，想细看石刻就要多留些步行时间。'],
 valley:['走进山谷里的王陵，近看墓室壁画。','需要去西岸。想看的墓室及其开放、票种要按日期核对。'],
 'luxor-temple':['把城中的柱廊和雕像与卡纳克的建筑放在一起比较。','若想看夜间灯光，先核对当天开放时段。'],
 hatshepsut:['看神庙的台地和柱廊怎样嵌进崖壁。','要去西岸并步行上台地，宜和同岸景点一起安排。'],
 sail:['从河面换一个角度看阿斯旺的河岛和两岸。','要留出登船和航行时间，能否成行也取决于风况。'],
 philae:['从水上接近河岛，再看岛上的古埃及神庙。','参观之外还要算上到码头、等船和往返接驳。'],
 obelisk:['看石碑还连着岩层的样子，理解古埃及人如何凿取巨石。','主要看点集中在采石场。若单独去，要把往返和露天步行算进去。'],
 'grand-museum':['把博物馆藏品和吉萨高原的遗址联系起来。','馆内参观容易占用较多时间，和金字塔同天去需留出转场余量。'],
 'alex-library':['看临海的斜顶建筑，了解这座现代图书馆的空间。','如要入内或看展，先核对开放和票务，再留出参观时间。'],
 'alex-corniche':['边走边看地中海和港城街景，行程节奏也能慢下来。','海滨很长，可以只选一段，先想好回程怎么走。'],
 'hurghada-reef':['从海上认识红海的珊瑚和鱼群。','通常要预留集合和出海时间，并按水性与当天海况选活动。'],
 'hurghada-coast':['用海滨散步或沙滩休息给古迹行程换个节奏。','想进入特定海滩时，先确认通行方式和可能的费用。'],
 'ras-muhammad':['在西奈南端看海岸地貌，也能了解红海的礁区。','陆路和船游的时间与体验不同，先决定哪一种更适合。'],
 nabq:['把红树林、沙地和海岸放在同一段自然探索里。','需单独安排往返，并确认当天能到哪些区域。'],
 'dahab-blue-hole':['从岸边看红海岸边天然蓝洞的地貌。','岸上和下水是两种安排。下水需另行确认经验要求与当地条件。'],
 'eel-garden':['了解栖息在近岸沙地里的花园鳗和岸潜环境。','水下观赏取决于海况、能见度和个人经验。'],
 'abu-dabbab':['认识海草床与红海动物的栖息环境。','动物是否出现不确定，还要把到海湾的接驳算进去。'],
 'sharm-luli':['看白沙与浅水交界的红海岸线。','从落脚点往返会占用时间，宜先确认接驳与进入条件。'],
 'gouna-lagoons':['沿水道和潟湖慢走，看城镇怎样与水面相连。','不妨选一段散步路线，减少不同水道之间的往返。'],
 'gouna-water':['了解红海边的风筝冲浪，或从岸上观看。','体验课程需另留时间和预算，能否开展受风况影响。'],
 'quseir-port':['从老港街巷理解这座红海城镇的贸易历史。','看点散在街区里，要留步行时间；进室内场馆需核对开放。'],
 'quseir-reef':['认识近岸礁区，与老港的街巷体验形成对照。','出行方式要按下水经验和当天海况决定，并留出准备时间。'],
 'colored-canyon':['近看岩壁的颜色和层理，认识西奈的峡谷地貌。','要把往返车程和峡谷步行计入行程，并先确认可达性。'],
 wishwashi:['在岩壁间看西奈的峡谷地貌，和海岸景观做对照。','先核对交通和步行条件，再决定要不要单独留半天。'],
 'cleopatra-beach':['沿北岸看浅蓝水面、礁石和浪花。','观景和下水所需条件不同，排程时要考虑当天风浪。'],
 agiba:['从高处看两侧崖壁围出的小海湾。','想从观景处继续走到岸边，要预留上下坡的时间。'],
 'alamein-museum':['用馆内材料串起北非战场和附近纪念地的历史。','想与纪念地同一天看，需核对开放时段并留出接驳。'],
 'alamein-coast':['留一段时间看地中海海景，让行程慢下来。','先确认想去的海滨入口以及往返交通。'],
 shali:['在绿洲的旧城里看泥砖建筑和街巷布局。','路面和坡度会影响步行速度，留些时间慢慢走。'],
 'siwa-lakes':['看盐湖、棕榈与周围沙漠地景的反差。','湖点与镇区的往返要单独计算，想停多个湖点就要多留时间。'],
 qarun:['在湖边看水面和旱地相接的绿洲景观。','湖岸范围大，先选落脚点和回程路线。'],
 'whale-valley':['看古鲸化石，理解沙漠曾经的海洋环境。','去程和回程都要算入，现场为露天步行参观。'],
 'black-desert':['看散布深色岩石的山丘，认识绿洲外的沙漠地貌。','要安排从绿洲出发的交通，和白沙漠同看还要留转场时间。'],
 'white-desert':['看风塑成的浅色岩层，与黑沙漠的地貌做对照。','要留出沙漠往返和观景时间，并按日期确认当地交通安排。'],
 'suez-canal':['从南端理解运河、港口与苏伊士湾的地理关系。','观景受可进入区域限制，出发前先核对落脚点。'],
 'suez-bay':['沿能到达的岸线观察海湾与港城的关系。','先选可以到达的岸段，再估算市内往返时间。'],
 'abu-great':['从拉美西斯二世巨像认识大神庙的尺度与迁建故事。','若从阿斯旺出发，转场可能比参观本身更占时间。'],
 'abu-small':['对照两座神庙的立面，了解娜芙蒂蒂与哈托尔小神庙。','适合和大神庙一起看，要为第二处参观多留些时间。']
};

function cityDecision(id) {
 const city=cities[id];
 const {concern}=state.discovery;
 const {date,days,dateLabel}=travelConditions();
 const liked=interestEntries().filter(item=>item.city===id || (!item.city && city.exp.some(place=>
  experiences[place].slice(0,2).some(text=>text.includes(item.label)))));
 const undecided=city.exp.filter(place=>!state.feedback[place]);
 const picks=city.exp.filter(place=>state.feedback[place]!=='no');
 const highlights=picks.slice(0,2).map(place=>experiences[place][0]).join('和');
 const tradeoffs={
  cairo:'把吉萨高原和开罗老城都放进同一天，容易挤压走访时间，还要留出进出城的路程。',
  luxor:'东岸神庙与西岸王陵要分开留时间，把两岸排在一起会增加过河和等待。',
  aswan:'河上体验要看风况，岛上的神庙还要预留乘船接驳。',
  'giza-city':'金字塔与博物馆各自需要参观时间，合在一天时要给进出和换乘留余量。'
 };
 const tradeoff=tradeoffs[id] || '若把不同方向的景点排在同一天，要先留出往返时间，再决定哪些值得保留。';
 const relevantConcern=concern && (!concern.ids.length || concern.ids.includes(id));
 const priority=liked.slice(0,2).map(item=>item.label).join('、');
 const entry=priority?'你对'+priority+'感兴趣，可以先围绕这些体验留时间。':
  highlights?'可以先从'+highlights+'开始。':'这轮体验你都标记了暂不考虑。';
 const summary=city.intro+' '+entry+' '+tradeoff;
 const timing=days?'你目前给了全程 '+days+' 天，先看这座城会占多少时间。':'先选出一项最想保留的体验，再决定是否多留时间。';
 const more=(relevantConcern?'你提到「'+concern.label+'」，做取舍时可以先核对这一点。':'')+
  timing+' 开放时间、门票、接驳和体验是否可安排，按出行日期再核对。';
 const experienceQuestion={
  label:priority?'想重点体验'+priority+'，还值得看什么？':'如果在'+city.n+'只选一两项体验，先看什么？',
  answer:(priority?'可以先给'+priority+'留出时间。':highlights?'可以先看看'+highlights+'。':'如果这座城的体验都不符合你的兴趣，可以把时间留给下一站。')+
   (priority && undecided.length?'还有'+experiences[undecided[0]][0]+'可以作为候选。':'')+
   tradeoff+' '+timing
 };
 const logisticsQuestion={
  label:relevantConcern && /交通|转场|接驳|换乘/.test(concern.label)?'去'+city.n+'这段转场，哪些最容易占时间？':'在'+city.n+'游览，哪些路程和费用要先算进去？',
  answer:tradeoff+' 可以先分开看跨城交通、市内接驳、门票和活动费用。'+
   (relevantConcern && concern.ids.length===2?'你在看的连接是'+cityNames(concern.ids)+'。':'有了出发城市和日期，就能进一步核对。')
 };
 const timingQuestion={
  label:date?'按我选的时间，去'+city.n+'要先确认什么？':days?'全程 '+days+' 天，要给'+city.n+'留多少时间？':'想去'+city.n+'，日期和停留时间怎么定？',
  answer:(date?'你现在的时间条件是'+dateLabel+'。':'')+timing+' '+tradeoff+
   ' 日期确定后，再核对开放和预约条件。'
 };
 const questions=relevantConcern?[logisticsQuestion,experienceQuestion,timingQuestion]:
  priority?[experienceQuestion,timingQuestion,logisticsQuestion]:[timingQuestion,experienceQuestion,logisticsQuestion];
 return {summary,more,questions};
}

function recordInterests(text) {
 const match = text.match(/(?:^|[，。；、\s]|我)(?:更|挺|很)?(喜欢|想看|想体验|对)([^，。；！？]*?)(?=[，。；！？]|但|不过|$)/);
 if(!match || /不太|不感兴趣|不想|不喜欢/.test(match[0]) || (match[1]==='对' && !/感兴趣/.test(match[2]))) return;
 const phrase = match[2].replace(/(?:很|挺|更)?感兴趣.*$/,'').trim();
 const ids = mentionedCities(phrase);
 const places = Object.entries(experiences).filter(([,e])=>phrase.includes(e[0]));
 const entries = places.length ? places.map(([id,e])=>({label:e[0],city:Object.keys(cities).find(city=>cities[city].exp.includes(id))})) :
  ids.map(city=>({label:phrase.match(/古迹|神庙|王陵|海边|潜水|河岛|帆船/) ? phrase : cities[city].n,city}));
 if(!entries.length && /^[\p{Script=Han}A-Za-z\s]{2,24}$/u.test(phrase)) entries.push({label:phrase,city:''});
 for(const entry of entries) if(!state.discovery.likes.some(item=>item.label===entry.label)) state.discovery.likes.push(entry);
}

function currentSummary() {
 const {concern,waiting,compareLater} = state.discovery;
 const interests = interestEntries();
 const request = state.view==='route' ? state.routeRequest : state.view==='compare' ? state.comparison.conditions : waiting?.conditions || concern?.conditions;
 const conditions = state.view==='edit' ? draftPlan().timing : state.view==='itinerary' ? state.itinerary.timing : travelConditions(request);
 const lines = [
  ['兴趣',interests.length ? interests.map(i=>i.label).join('、') : '还没有明确记录'],
  ['顾虑',concern ? concern.label + (concern.ids.length ? ' · '+cityNames(concern.ids) : '') : '还没有明确记录'],
  ['待决定',waiting?.kind==='route' ? '要看的转场起点和终点' :
   waiting?.kind==='compare' ? '要比较的城市' :
   state.view==='compare' ? '在 '+cityNames([...new Set(state.comparison.options.flat())])+' 之间怎么取舍' :
   state.view==='itinerary' ? '核验交通、费用和体验可用性' :
   state.view==='edit' ? '核对草稿的城市顺序与停留，完成编辑后更新当前行程' :
   concern && concern.kind!=='other' ? (concern.ids.length===2 ? '这段转场是否值得' : '哪一段转场最影响选择') :
   compareLater ? '先继续探索，比较留到之后' : '哪些城市值得多留时间']
 ];
 if(conditions.days || conditions.dateLabel!=='日期待定') lines.push(['时间条件',conditions.label]);
 return '<aside class="understanding" aria-labelledby="understanding-title"><h3 id="understanding-title">安途目前理解了什么</h3><dl>'+
  lines.map(([label,value])=>`<div><dt>${label}</dt><dd>${escapeHtml(value)}</dd></div>`).join('')+'</dl></aside>';
}

function nextSuggestion({allowExplore=false}={}) {
 const {concern,waiting,compareLater} = state.discovery;
 const interests = interestEntries();
 const ids = [...new Set(interests.map(item=>item.city).filter(Boolean))];
 if(state.paused || waiting || ['compare','route','edit'].includes(state.view)) return null;
 if(concern && concern.kind!=='other' && !concern.viewed){
  const pair = concern.ids;
  const key = 'cost:'+pair.join('~')+':'+concern.label+':'+JSON.stringify(concern.conditions);
  if(!state.dismissed.includes(key)) return {
   key, kind:pair.length===2 ? 'route' : 'clarify-route', ids:pair, conditions:concern.conditions,
   title:pair.length===2 ? cityNames(pair)+'的转场代价' : pair.length===1 ? cities[pair[0]].n+'的转场代价' : '先确定你担心的转场',
   reason:(interests.length ? '你对'+interests.slice(0,2).map(i=>i.label).join('、')+'感兴趣，也' : '你')+concern.label+'。'+
    (pair.length===2 ? '可以先把接驳、等待和途中时间分开看，再决定是否值得。' : '确定起点和终点后，才能判断这段转场会占用多少时间。'),
   label:pair.length===2 ? '查看这段连接' : '补充起点和终点'
  };
 }
 if(ids.length>=2 && !compareLater){
  const key='compare:'+ids.join('~');
  if(!state.dismissed.includes(key)) return {key,kind:'compare',ids,title:'比较'+cityNames(ids),
   reason:'你对这些城市的体验都感兴趣。可以对照各自能保留哪些体验，以及把时间留给一座城市会舍去什么。',label:'比较这些城市'};
 }
 if(allowExplore && ids.length){
  const id=ids.at(-1);
  const key='explore:'+id;
  if(!state.dismissed.includes(key)) return {key,kind:'explore',ids:[id],title:'继续看看'+cities[id].n,
   reason:'你已经对这里的体验表达了兴趣。可以再看看同城还有哪些体验值得留时间。',label:'查看城市体验'};
 }
 return null;
}
