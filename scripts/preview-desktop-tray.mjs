// Build apps/desktop, then run this server and inspect at 420 × 640 CSS pixels.
// Synthetic account data only; no service connections, credentials or model calls.
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
const directory = fileURLToPath(new URL('../apps/desktop/dist/', import.meta.url))
const bootstrap = `
const now = Date.now();
const profiles = [
  {id:'work',loggedIn:true,subscriptionType:'team',allowance:'20x',organizationName:'A Very Long Organization Name With Enterprise Account Metadata'},
  {id:'personal',loggedIn:true,subscriptionType:'max',allowance:'20x'},
];
const windows = [{type:'five_hour',utilization:.58,resetsAt:now+3600000},{type:'seven_day',utilization:.5,resetsAt:now+86400000},{type:'seven_day_fable',utilization:0,resetsAt:now+86400000}];
window.fixtureState = {desktopVersion:'fixture',platform:'darwin',glass:'Standard appearance',preferences:{mode:'managed',notifications:true,quietUntil:0},owned:true,running:'1.78.0',health:{status:'healthy'},profiles:{activeProfile:'personal',profiles,profileOrder:['work','personal']},quota:{profiles:profiles.map(p=>({id:p.id,fetchedAt:now,windows}))},summary:{},providers:{providers:[{id:'claude',enabled:true,activity:{requests:0,inputTokens:0,outputTokens:0,errors:0}}]},dataErrors:[],lastChecked:now};
let subscriber;
window.meridian = {state:async()=>window.fixtureState,subscribe:fn=>subscriber=fn,action:async(action,value)=>{
  if(action==='switch-profile') window.fixtureState.profiles.activeProfile=value;
  return window.fixtureState;
}};
window.refreshFixture = () => subscriber(window.fixtureState);
window.assertTrayLayout = () => {
  const panel=document.querySelector('#panel');
  const accounts=[...document.querySelectorAll('.account')];
  const failures=[];
  if(panel.scrollWidth>panel.clientWidth) failures.push('panel horizontal overflow');
  if(panel.scrollHeight>panel.clientHeight) failures.push('panel vertical overflow clips controls');
  for(const account of accounts) {
    if(account.scrollWidth>account.clientWidth) failures.push('account horizontal overflow');
    const name=account.querySelector('.account-name').getBoundingClientRect();
    const action=account.querySelector('.account-state').getBoundingClientRect();
    if(name.width<80 || name.right>action.left) failures.push('account identity/action overlap');
  }
  const list=document.querySelector('.accounts');
  if(accounts.length===2 && !document.querySelector('details[open]') && list.scrollHeight>list.clientHeight) failures.push('two accounts require vertical scrolling');
  if(failures.length) throw new Error(failures.join(', '));
  return {width:innerWidth,height:innerHeight,accounts:accounts.length,panelHeight:panel.getBoundingClientRect().height,failures};
};
`;
const assets = new Set(['theme.css','tray.css','trayRenderer.js']);
createServer(async(req,res)=>{
  try {
    const path = new URL(req.url,'http://localhost').pathname.slice(1);
    if(path==='review') {res.setHeader('content-type','text/html');res.end('<!doctype html><title>Meridian tray review</title><iframe title="Native 420 × 640 panel" src="/" width="420" height="640" frameborder="0"></iframe>');return;}
    if(path==='fixture.js') {res.setHeader('content-type','text/javascript');res.end(bootstrap);return;}
    if(assets.has(path)) {res.setHeader('content-type',path.endsWith('.css')?'text/css':'text/javascript');res.end(await readFile(directory+path));return;}
    if(path) {res.writeHead(404);res.end();return;}
    res.setHeader('content-type','text/html');
    res.end((await readFile(directory+'tray.html','utf8')).replace('<script src="trayRenderer.js">','<script src="fixture.js"></script><script src="trayRenderer.js">'));
  } catch(error) {res.writeHead(500);res.end(String(error));}
}).listen(Number(process.env.PORT || 4319),'127.0.0.1',()=>console.log('Tray fixture: http://127.0.0.1:'+(process.env.PORT || 4319)));
