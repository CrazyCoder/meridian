// Evaluate this complete expression in the collaborative browser on fixture origin.
(async () => {
  const assert = (value, message) => { if (!value) throw Error(message) }
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
  const ready = async frame => { for(let i=0;i<100;i++){if(frame.contentWindow.lastProfiles?.profiles?.length === 14) return; await wait(50)} throw Error('Profile fixture did not load') }
  const results = []
  try {
  for (const width of [320,375,800,1280]) {
    const frame=document.createElement('iframe'); frame.style.cssText=`width:${width}px;height:700px;position:fixed;left:0;top:0;z-index:100000;background:white`;frame.src='/after/profiles?q=5x#former-account';document.body.append(frame)
    try {
      await ready(frame);await wait(1000)
      const w=frame.contentWindow,d=w.document,card=d.getElementById('profile-account-10'),header=d.querySelector('.meridian-header')
      assert(w.location.hash==='#account-10','Former name did not canonicalize')
      assert(w.profileQuery===''&&!card.hidden,'Anchor did not clear conflicting search')
      const aligned=()=>Math.abs(card.getBoundingClientRect().top-header.getBoundingClientRect().bottom-12)<3
      for(let i=0;i<40&&!aligned();i++)await wait(50)
      assert(aligned(),'Anchor hidden under sticky header')
      const alignCalls=[];const originalAlign=w.alignProfileCard;w.alignProfileCard=function(c){alignCalls.push({top:c.getBoundingClientRect().top,header:header.getBoundingClientRect().bottom});return originalAlign(c)}
      const extra=d.createElement('div');extra.style.cssText='height:80px;flex:0 0 100%';header.append(extra);await wait(50);for(let i=0;i<40&&!aligned();i++)await wait(50);assert(aligned(),'Async header growth obscured anchor '+JSON.stringify({top:card.getBoundingClientRect().top,bottom:header.getBoundingClientRect().bottom,hold:w.anchorHold&&w.anchorHold.until-Date.now(),connected:card.isConnected,scroll:w.scrollY,alignCalls,source:w.ResizeObserver?true:false,alignCode:w.alignProfileCard.toString()}))
      w.dispatchEvent(new w.Event('wheel'));w.scrollTo(0,0);await w.refresh();assert(w.scrollY===0,'Polling yanked reader back to anchor')
      const input=d.getElementById('profiles-filter');input.focus();input.value='5x'
      input.dispatchEvent(new w.Event('input',{bubbles:true}));await w.refresh()
      assert(d.activeElement===input&&input.value==='5x'&&w.location.search==='?q=5x','Polling lost search focus/value/URL')
      assert(d.querySelectorAll('.profile-card:not([hidden])').length===1,'Tier filtering failed')
      assert([...d.querySelectorAll('.drag-handle')].every(el=>w.getComputedStyle(el).display==='none'),'Filtering allowed blind reorder')
      input.value='<script>synthetic</script>';input.dispatchEvent(new w.Event('input',{bubbles:true}))
      assert(!d.getElementById('profiles-no-match').hidden,'No-match action absent')
      assert(d.getElementById('profiles-no-match-query').textContent===input.value&&!d.getElementById('profiles-no-match-query').querySelector('script'),'Search rendered markup')
      input.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))
      assert(input.value===''&&!w.location.search&&d.querySelectorAll('.profile-card:not([hidden])').length===14,'Escape did not clear search')
      assert(d.documentElement.scrollWidth===d.documentElement.clientWidth,'Profile search introduced horizontal overflow')
      results.push({width,client:d.documentElement.clientWidth,page:d.documentElement.scrollWidth,alias:true,anchor:true,pollFocus:true,pausedReorder:true,escaped:true})
    } finally { frame.remove() }
  }
  const frame=document.createElement('iframe');frame.style.cssText='width:375px;height:700px';frame.src='/before/profiles';document.body.append(frame)
  await ready(frame);assert(!frame.contentDocument.getElementById('profiles-filter'),'Baseline unexpectedly has search');frame.remove()
  const home=document.createElement('iframe');home.src='/after/';document.body.append(home)
  try {
    for(let i=0;i<100&&!home.contentDocument?.querySelector('a.needs-login');i++)await wait(50)
    const link=home.contentDocument.querySelector('a.needs-login');assert(link,'Signed-out card link absent')
    link.focus();link.dispatchEvent(new home.contentWindow.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));link.click()
    await ready(home)
    assert(home.contentWindow.location.hash==='#needs-login','Home link did not navigate to account')
    const facts=await (await fetch('/fixture/assertions')).json();assert(facts.mutations===0,'Following a link mutated active profile or order')
  } finally { home.remove() }
  return {result:'PASS',cases:results,baselineSearchAbsent:true,homeNavigationWithoutMutation:true}
  } catch(error) { return {result:'FAIL',cases:results,error:String(error),stack:error.stack} }
})()
