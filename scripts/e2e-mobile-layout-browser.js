// Evaluate this entire expression in the fixture server's collaborative tab.
(async () => {
  const results = []
  for (const tree of ['before', 'after']) {
    for (const page of ['/', '/profiles']) {
      for (const width of [320, 375, 480, 721, 800, 908, 1280]) {
        const frame = document.createElement('iframe')
        frame.style.cssText = `border:0;position:fixed;left:0;top:0;height:700px;width:${width}px;z-index:99999`
        frame.src = `/${tree}${page}`
        document.body.append(frame)
        try {
          await new Promise(resolve => { frame.onload = resolve })
          const doc = frame.contentDocument
          for (let i = 0; i < 100 && !doc.querySelector('.profile-card'); i++) await new Promise(r => setTimeout(r, 20))
          if (doc.querySelectorAll('.profile-card').length !== 3) throw Error('Expected all three fixture cards')
          const client = doc.documentElement.clientWidth
          const scroll = doc.documentElement.scrollWidth
          results.push({ tree, page, width, client, scroll })
          if (tree === 'after' && scroll > client + 1) throw Error(`Overflow at ${page} ${width}: ${scroll}/${client}`)
          if (page === '/' && tree === 'after') {
            const dot = doc.querySelector('.prof-info-dot')
            dot.focus()
            const pop = doc.querySelector('.prof-pop').getBoundingClientRect()
            if (width <= 720 && (pop.left < 0 || pop.right > client + 1)) throw Error('Popover overflow')
            dot.blur()
            const tabs = doc.querySelectorAll('.sort-tab')
            tabs[1].focus(); tabs[1].click()
            if (doc.querySelector('.sort-tab.active')?.dataset.sort !== 'spent-desc') throw Error('Sort control did not activate')
            if (!doc.activeElement?.matches('.sort-tab')) throw Error('Sort lost keyboard focus')
          }
          if (page === '/profiles' && tree === 'after') {
            doc.querySelector('button[title="Rename profile"]').click()
            if (!doc.querySelector('.rename-input')) throw Error('Rename did not open')
            if (doc.documentElement.scrollWidth > client + 1) throw Error('Rename overflow')
            doc.querySelector('button[title="Cancel"]').click()
          }
        } finally { frame.remove() }
      }
    }
  }
  if (!results.some(r => r.tree === 'before' && r.scroll > r.client + 100)) throw Error('Baseline did not reproduce overflow')
  return { result: 'PASS', results }
})()
