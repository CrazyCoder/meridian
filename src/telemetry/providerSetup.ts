/** Pure command generation, shared by the browser dashboard and desktop renderer. */
export function providerSetupCommand(serviceUrl: string, route: string, client: string, model: string, keyEnv = '', setDefault = false): string {
  if (client !== 'pi' && client !== 'opencode') throw new Error('Choose Pi or OpenCode V1.')
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(model)) throw new Error('Choose an available account model.')
  if (keyEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(keyEnv)) throw new Error('Use an environment variable name, not the API key itself.')
  if (route !== '/v1/messages' && route !== '/antigravity/v1/messages') throw new Error('The Antigravity endpoint is unavailable.')
  const service = new URL(serviceUrl)
  if (!['http:', 'https:'].includes(service.protocol) || service.username || service.password || service.search || service.hash) throw new Error('Use a service URL without credentials, query or fragment.')
  const base = service.href.replace(/\/+$/, '') + route.replace(/\/v1\/messages$/, '')
  const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'"
  return `meridian setup --antigravity --client ${client} --url ${quote(base)} --model ${quote(model)}${keyEnv ? ` --api-key-env ${keyEnv}` : ''}${setDefault ? ' --set-default' : ''}`
}

export function providerSetupHtml(models: string[] | undefined, route: string): string {
  const available = models?.filter(model => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(model)) ?? []
  if (!available.length) return '<p class="provider-caption">Client setup will be available when account models load.</p>'
  const esc = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c)
  const selected = available.find(model => /^gemini-.*-low$/.test(model)) ?? available[0]
  return `<details class="provider-setup" data-detail="antigravity-setup"><summary>Connect Pi or OpenCode</summary>
    <form class="provider-client-setup" data-setup-route="${esc(route)}">
      <div class="provider-setup-fields"><label>Client<select name="agy-client"><option value="pi">Pi</option><option value="opencode">OpenCode V1</option></select></label>
      <label>Account model<select name="agy-model">${available.map(model => `<option value="${esc(model)}"${model === selected ? ' selected' : ''}>${esc(model)}</option>`).join('')}</select></label></div>
      <label class="provider-setup-default"><input type="checkbox" name="agy-default"> Make this the client's default</label>
      <details data-detail="antigravity-setup-auth"><summary>Service authentication</summary><label>API-key environment variable <span>(optional)</span><input name="agy-key-env" placeholder="MERIDIAN_CLIENT_KEY" autocomplete="off" spellcheck="false"></label><p class="provider-caption">If this Meridian service requires a key, set it in your client's environment and enter the variable name here.</p></details>
      <label class="provider-setup-command">Setup command<textarea data-setup-command readonly rows="4" spellcheck="false" aria-label="Antigravity client setup command"></textarea></label>
      <div class="provider-setup-actions"><button type="button" data-setup-copy>Copy command</button><span data-setup-status role="status"></span></div>
      <p class="provider-caption">Run in a terminal with Meridian installed, then restart your client. Installs the provider and recovery integration; preserves other providers and tool permissions.</p>
    </form></details>`
}

// The web UI is served without a client bundler. Serialize only the pure helper;
// no provider data is embedded in executable JavaScript.
export const providerSetupJs = `
var meridianSetupCommand = ${providerSetupCommand.toString()};
function refreshProviderSetup(form) {
  var command = form.querySelector('[data-setup-command]');
  var copy = form.querySelector('[data-setup-copy]');
  var status = form.querySelector('[data-setup-status]');
  try {
    command.value = meridianSetupCommand(location.origin, form.dataset.setupRoute, form.elements['agy-client'].value, form.elements['agy-model'].value, form.elements['agy-key-env'].value.trim(), form.elements['agy-default'].checked);
    copy.disabled = false; status.textContent = '';
  } catch(error) { command.value = ''; copy.disabled = true; status.textContent = error.message; }
}
function refreshProviderSetups() { document.querySelectorAll('.provider-client-setup').forEach(refreshProviderSetup); }
document.addEventListener('input', function(event) { var form = event.target.closest('.provider-client-setup'); if (form) refreshProviderSetup(form); });
document.addEventListener('change', function(event) { var form = event.target.closest('.provider-client-setup'); if (form) refreshProviderSetup(form); });
document.addEventListener('submit', function(event) { if (event.target.matches('.provider-client-setup')) event.preventDefault(); });
document.addEventListener('click', async function(event) {
  var button = event.target.closest('[data-setup-copy]'); if (!button) return;
  var form = button.closest('form'), command = form.querySelector('[data-setup-command]'), status = form.querySelector('[data-setup-status]');
  try { await navigator.clipboard.writeText(command.value); status.textContent = 'Copied'; }
  catch(error) { command.focus(); command.select(); status.textContent = 'Select and copy the command above.'; }
});
`
