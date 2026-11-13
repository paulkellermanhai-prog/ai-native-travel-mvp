// Ground transport cards use placeholder fares until a dated timetable is available.
const transportFixtures = {
 train: {
  source:'https://www.abelatrains.com/', sourceLabel:'查看 Abela 铁路班次',
  candidates:[
   {fare:280,analysis:'白天出发通常更方便衔接市内交通。确认车次后，再决定出发当天是否还适合安排景点。'},
   {fare:210,analysis:'比较车票时，可以一起算上去车站和抵达后进城的费用。'},
   {fare:330,analysis:'如果考虑夜车，可先核对座席或卧铺条件，以及抵达后能否寄存行李。'}
  ]
 },
 bus: {
  source:'https://go-bus.com/', sourceLabel:'查看 Go Bus 班次',
  candidates:[
   {fare:120,analysis:'选车次时可以先比较上车点到住处的距离，把两端接驳一起算进路程。'},
   {fare:150,analysis:'如果选择夜间班次，可以省下白天的移动时间，也要考虑路上休息和到站后的安排。'},
   {fare:180,analysis:'如果有大件行李，出发前可以核对行李规则和途中停靠安排。'}
  ]
 }
};

const transportSnapshot = {
 date:'2026-12-18',
 dateLabel:'2026 年 12 月 18 日 · 周五',
 checked:'2026 年 11 月 12 日',
 operator:'埃及航空',
 category:'经济舱',
 logo:'egyptair-symbol.png',
 origin:'开罗国际机场 T3',
 destination:'卢克索国际机场',
 originCode:'CAI',
 destinationCode:'LXR',
 segment:'计划飞行段',
 published:true,
 candidates:[
  {code:'MS62',departure:'06:05',arrival:'07:10',minutes:65,transfers:0,fare:680,tags:['直飞','早班'],
   source:'https://www.flight.info/MS62',
   analysis:'早到能给卢克索留出更多白天时间。开罗去机场的接驳要安排在清晨，抵达后还要考虑寄存行李。'},
  {code:'MS66',departure:'18:00',arrival:'19:05',minutes:65,transfers:0,fare:760,tags:['直飞','傍晚出发'],
   source:'https://www.flight.info/MS66',
   analysis:'可以把白天更多时间留在开罗。到卢克索后，适合先安排晚间接驳和入住，把参观留到次日。'},
  {code:'MS60',departure:'22:00',arrival:'23:05',minutes:65,transfers:0,fare:590,tags:['直飞','晚班'],
   source:'https://www.flight.info/MS60',
   analysis:'出发日可在开罗停留更久，但抵达较晚，宜先核对机场接驳和住处的最晚入住时间。'}
 ]
};
