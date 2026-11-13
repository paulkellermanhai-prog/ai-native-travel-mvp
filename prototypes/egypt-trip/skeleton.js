function buildSkeletons(comparison) {
 const timing=travelConditions(comparison.conditions);
 const interests=interestEntries().filter(item=>item.city);
 const plannedCities=[...new Set(comparison.options.flat())];
 const examples=plannedCities.flatMap(city=>cities[city].exp
  .filter(id=>state.feedback[id]!=='no').slice(0,2)
  .map(id=>({label:experiences[id][0],city})));
 const baseline=state.itinerary?.kept || [];
 const unique=items=>[...new Map(items.map(item=>[item.label,item])).values()];
 return comparison.options.map(ids=>{
  const issue=timing.conflict ? '日期和指定天数不一致，请先调整。' :
   timing.days && timing.days<ids.length ? '天数不足以给每站留出一天，请增加天数或减少停靠城市。' : '';
  const count=issue ? undefined : timing.days;
  const stops=ids.map((city,index)=>{
   const days=count ? Math.floor(count/ids.length)+(index<count%ids.length ? 1 : 0) : null;
   return {city,days,nights:days===null ? null : days-Number(index===ids.length-1)};
  });
  const kept=unique([...interests,...examples,...baseline].filter(item=>ids.includes(item.city)));
  const keptLabels=new Set(kept.map(item=>item.label));
  const lost=unique([...interests,...baseline,...examples].filter(item=>!keptLabels.has(item.label) && !ids.includes(item.city)));
  return {stops,kept,lost,issue,timing:{label:timing.label,days:count,dateLabel:timing.dateLabel},
   routeRequest:{date:timing.date,days:timing.days,frozen:true}};
 });
}

function skeletonTitle(plan) {
 return plan.stops.map(stop=>cities[stop.city].n).join(' → ');
}

function skeletonStops(plan) {
 return `<ol class="skeleton-stops">${plan.stops.map(stop=>`<li>
  <span>${cities[stop.city].n}</span> <span>${stop.days===null ? '天数／晚数待定' : stop.days+' 天 '+stop.nights+' 晚'}</span>
 </li>`).join('')}</ol>`;
}

function skeletonConnections(plan) {
 if(plan.stops.length===1)return '<p class="quiet">单城停留，往返交通待核验。</p>';
 return `<ul class="skeleton-connections">${plan.stops.slice(1).map((stop,i)=>{
  const from=plan.stops[i].city;
  return '<li>'+action(cities[from].n+' → '+cities[stop.city].n,'skeleton-route:'+connectionId([from,stop.city]),'textbtn')+
   '<small>方式、耗时与费用待核验</small></li>';
 }).join('')}</ul>`;
}

function experienceList(entries, empty) {
 return entries.length ? '<ul>'+entries.map(item=>'<li>'+escapeHtml(item.label)+'</li>').join('')+'</ul>' :
  '<span class="quiet">'+empty+'</span>';
}

function comparisonView() {
 const plans=buildSkeletons(state.comparison);
 const timing=travelConditions(state.comparison.conditions);
 const rows=[
  ['保留体验',plan=>experienceList(plan.kept,'暂无具体体验')],
  ['舍弃体验',plan=>experienceList(plan.lost,'无已列出的体验被舍弃')],
  ['跨城转场',plan=>plan.stops.length-1+' 段'],
  ['耗时与费用',()=>'<span class="quiet">待核验</span>']
 ];
 return heading('旅行骨架','城市比较',escapeHtml(timing.label))+
  `<div class="skeleton-tools">${status('候选方案')}${action('看并排取舍 ↓','jump-tradeoffs')}</div>
   <p class="skeleton-note">停留天数含转场，最后一站按末日离开计算夜数。</p>`+
  `<div class="skeleton-scroll" role="region" aria-label="旅行骨架方案" tabindex="0"><div class="skeleton-grid" style="--plan-count:${plans.length}">
   ${plans.map((plan,i)=>{
    const title=skeletonTitle(plan);
    const selected=state.candidate===i;
    return `<article class="candidate skeleton-card">
     <span class="num">方案 ${String(i+1).padStart(2,'0')}</span><h3>${title}</h3>
     ${skeletonStops(plan)}<h4>跨城连接</h4>${skeletonConnections(plan)}
     ${plan.issue ? '<p class="skeleton-issue">'+plan.issue+'</p>' : ''}
     <p class="skeleton-preview">${action(selected?'地图预览中 ↗':'在地图上看 ↗','candidate:'+i,'textbtn',`aria-label="在地图上看${title}" aria-pressed="${selected}"`)}</p>
    </article>`;
   }).join('')}
  </div></div>
  <section class="skeleton-tradeoffs" aria-labelledby="tradeoffs-title">
   <h3 id="tradeoffs-title" tabindex="-1">并排取舍</h3>
   <p class="quiet">对照你关注的体验、当前行程保留的体验，以及候选城市的代表体验。</p>
   <div class="skeleton-scroll" role="region" aria-label="并排比较方案" tabindex="0">
    <table class="skeleton-table">
     <thead><tr><th scope="col">比较项</th>${plans.map((plan,i)=>`<th scope="col">方案 ${String(i+1).padStart(2,'0')}<small>${skeletonTitle(plan)}</small></th>`).join('')}</tr></thead>
     <tbody>${rows.map(([label,cell])=>`<tr><th scope="row">${label}</th>${plans.map(plan=>`<td>${cell(plan)}</td>`).join('')}</tr>`).join('')}
      <tr><th scope="row">选择方案</th>${plans.map((plan,i)=>`<td>${action('采用此方案','adopt-skeleton:'+i,'primary',`aria-label="采用此方案，${skeletonTitle(plan)}" ${plan.issue?'disabled':''}`)}</td>`).join('')}</tr>
     </tbody>
    </table>
   </div>
  </section>`+
  (timing.conflict ? '<p class="skeleton-issue" role="status">所选日期覆盖 '+timing.conflict+' 天，与你指定的 '+timing.days+' 天不同。</p>' : '')+
  (adoptionError ? '<p class="skeleton-issue" role="alert">'+escapeHtml(adoptionError)+'</p>' : '')+
  `<div class="result-links">${action('都不选，继续探索','compare-back')}${state.itinerary?action('查看当前行程','itinerary','subtle'):''}</div>`;
}

function itineraryView() {
 const plan=state.itinerary;
 return `<div class="section-line">${status('已采用骨架 · 版本 '+(plan.revision||1))}</div>
  <h2 id="itinerary-heading" tabindex="-1">当前行程</h2>
  <p class="intro">${escapeHtml(plan.timing.label)}${plan.timing.days ? ' '+(plan.timing.days-1)+' 晚' : ''}</p>
  <article class="skeleton-current">
   <h3>${skeletonTitle(plan)}</h3>${skeletonStops(plan)}
   <h4>跨城连接</h4>${skeletonConnections(plan)}
   <h4>保留体验</h4>${experienceList(plan.kept,'暂无具体体验')}
  </article>
  <p class="support">待核验事项包括交通方式、班次、费用和体验的可用性。</p>
  <div class="result-links">${state.comparison?action('返回方案比较','reopen-compare','subtle'):''}
   ${action('继续探索','overview')}</div>`;
}
