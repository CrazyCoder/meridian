// Evaluate inside the /profiles frame from e2e-page-layout-live.mjs, in wide
// mode at 2560px. DOM-dispatched drag/key events drive the real browser handlers
// and actual HTTP settings writes; this does not claim OS pointer automation.
(async () => {
  const check = (value, message) => { if (!value) throw new Error(message) }
  const pause = () => new Promise(resolve => setTimeout(resolve, 600))
  const cards = () => Array.from(document.querySelectorAll('#content .profile-card[data-id]'))
  const expected = Array.from({ length: 14 }, (_, i) => 'fixture-' + String(i + 1).padStart(2, '0'))
  check(frameElement?.getAttribute('data-owned-fixture') === 'page-layout', 'Use the maintained owned fixture frame')
  check(location.pathname === '/profiles' && document.documentElement.dataset.layout === 'wide', 'Use the owned wide Profiles fixture')
  check(cards().length === 14 && cards().every(card => expected.includes(card.dataset.id)), 'Refuse to mutate non-fixture accounts')
  const json = async (path, method = 'GET', body) => {
    const response = await fetch(path, { method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
    check(response.ok, 'Fixture HTTP request failed: ' + path)
    return response.json()
  }
  await json('/settings/api/routing', 'PUT', { profileOrder: expected })
  await json('/profiles/active', 'POST', { profile: expected[0] })
  await window.refresh()
  const handle = document.querySelector('[data-id="fixture-05"] .drag-handle')
  handle.focus()
  handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }))
  await pause()
  const keyboardOrder = (await json('/settings/api/routing')).profileOrder
  check(keyboardOrder[3] === 'fixture-05' && cards()[3].dataset.id === 'fixture-05', 'Keyboard move across a grid row did not save')
  check(document.activeElement.closest('.profile-card')?.dataset.id === 'fixture-05', 'Keyboard focus was lost')
  const last = document.querySelector('[data-id="fixture-14"]'), first = cards()[0], dragHandle = last.querySelector('.drag-handle'), transfer = new DataTransfer()
  dragHandle.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: transfer }))
  first.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer, clientY: 300 }))
  first.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }))
  dragHandle.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: transfer }))
  await pause()
  check((await json('/settings/api/routing')).profileOrder[0] === 'fixture-14' && cards()[0].dataset.id === 'fixture-14', 'Drag across grid rows did not save')
  check(!document.querySelector('.dragging,.drop-target'), 'Drag marks remain')
  const input = document.getElementById('profiles-filter')
  input.value = 'fixture-14'; input.dispatchEvent(new Event('input', { bubbles: true }))
  check(cards().filter(card => !card.hidden).length === 1 && !cards()[0].hidden, 'Search did not isolate the target account')
  input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true }))
  location.hash = 'fixture-14'
  await new Promise(resolve => setTimeout(resolve, 150))
  check(document.querySelector('[data-id="fixture-14"]').classList.contains('anchor-flash'), 'Account anchor did not target its card')
  document.querySelector('[data-id="fixture-14"] .switch-btn').click()
  await pause()
  check((await json('/profiles/list')).activeProfile === 'fixture-14', 'Account switch did not save')
  check(document.querySelector('.profile-card.active')?.dataset.id === 'fixture-14', 'Active card did not update')
  check(document.documentElement.dataset.layout === 'wide', 'Layout changed during account interaction')
  return { result: 'PASS', keyboardAcrossRowSaved: true, keyboardFocusRestored: true, dragAcrossRowsSaved: true,
    dragMarksCleared: true, searchPassed: true, anchorPassed: true, accountSwitchSaved: true, activeCardUpdated: true, wideRetained: true, domDispatchedEvents: true }
})()
