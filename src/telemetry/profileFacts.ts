/**
 * What a profile card states about an account, in one place.
 *
 * Two surfaces render the same list — the detail grid on /profiles and the
 * hover overlay on the landing page — so the list lives here instead of being
 * written twice and drifting apart the first time a row is added.
 *
 * Emitted as browser source rather than a TypeScript function because the
 * pages are string templates concatenated at import time, the same arrangement
 * `profileBarJs` uses. The unit tests evaluate this exact text, so what they
 * assert is what the browser runs.
 *
 * Values are plain text; escaping is the page's job, since only the page knows
 * whether it is filling a grid cell or an overlay row.
 */
export const profileFactsJs = `
function timeAgo(ts) {
  if (!ts) return '\\u2014';
  var s = Math.floor((Date.now() - ts) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return new Date(ts).toLocaleString();
}

// The two largest units of an advisory stored expiry countdown.
function expirySpan(ms) {
  var mins = Math.floor(Math.abs(ms) / 60000);
  var d = Math.floor(mins / 1440);
  mins -= d * 1440;
  var h = Math.floor(mins / 60);
  var m = mins - h * 60;
  if (d > 0) return d + 'd ' + h + 'h';
  if (h > 0) return h + 'h ' + m + 'm';
  return m + 'm';
}

function expiryFacts(p, now) {
  var facts = [];
  if (p.refreshTokenExpiresAt) {
    var left = p.refreshTokenExpiresAt - now;
    facts.push({ label: 'Refresh deadline',
      value: left > 0 ? 'in ' + expirySpan(left) : 'passed \\u2014 login may need renewal',
      tone: left <= 0 || p.renewalRequiredSoon ? 'warn' : '',
      title: new Date(p.refreshTokenExpiresAt).toLocaleString()
        + '. Reported by the stored credential; log in again before then. Authentication is checked separately.' });
  }
  if (p.accessTokenExpiresAt) {
    var accessLeft = p.accessTokenExpiresAt - now;
    facts.push({ label: 'Stored access token',
      value: accessLeft > 0 ? 'expires in ' + expirySpan(accessLeft) : 'expiry passed',
      tone: accessLeft <= 0 ? 'warn' : '',
      title: new Date(p.accessTokenExpiresAt).toLocaleString()
        + '. Recorded expiry, which may be estimated. Authentication is checked separately.' });
  }
  return facts;
}

function profileFacts(p) {
  var facts = [];
  var authStale = p.authProvenance && p.authProvenance !== 'live';
  var statusValue = p.authProvenance === 'never' ? 'never read' : (p.loggedIn ? '\\u2713 Authenticated' : '\\u2717 Not logged in');
  facts.push({
    label: 'Status',
    value: statusValue,
    tone: p.loggedIn ? 'ok' : 'err',
    cached: authStale && p.authProvenance !== 'never'
  });
  facts = facts.concat(expiryFacts(p, Date.now()));
  if (p.email) facts.push({ label: 'Email', value: p.email, tone: '', cached: authStale });
  if (p.organizationName) facts.push({ label: 'Organization', value: p.organizationName, tone: '' });
  if (p.accountType) facts.push({ label: 'Account', value: p.accountType, tone: '' });
  var plan = p.planName || p.planLabel || p.subscriptionType;
  if (plan) facts.push({ label: 'Plan', value: plan, tone: '', cached: authStale, title: p.seatTier || p.rateLimitTier || '' });
  if (p.allowance) facts.push({ label: 'Allowance', value: p.allowance + ' of a Pro plan\\u2019s Claude Code usage', shortValue: p.allowance, tone: '', title: p.rateLimitTier || '' });
  if (p.aliases && p.aliases.length > 0) facts.push({ label: 'Former names', value: p.aliases.join(', '), tone: '', title: 'Requests naming these are served by this profile, until the name is added again' });
  if (p.lastSuccessAt) facts.push({ label: 'Last Verified', value: timeAgo(p.lastSuccessAt), tone: 'ok' });
  if (p.lastCheckedAt && p.lastCheckedAt !== p.lastSuccessAt) {
    facts.push({ label: 'Last Checked', value: timeAgo(p.lastCheckedAt), tone: '' });
  }
  return facts;
}
`
