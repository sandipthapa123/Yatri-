import { describeShareView, type ShareView } from '@yatri/types';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * The page a trusted contact opens. Text first: a headline that a screen reader announces when it
 * changes, and the details under it (updated quietly, so nothing chatters). There is no map to
 * interpret; a link opens the location in the contact's own maps app. All the words come from
 * `describeShareView` (the JSON carries the same lines), so the page restates nothing.
 * The script is small, has a per-request nonce, and only polls the JSON endpoint of this same link.
 */
export function renderSharePage(token: string, view: ShareView | null, nonce: string): string {
  const shown = view ? describeShareView(view) : null;
  const headline = shown?.headline ?? 'This link is not available.';
  const details = shown?.details ?? ['The trip may have ended, or the person stopped sharing it.'];
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<title>Following a Yatri trip</title>
<style nonce="${nonce}">
  body { font-family: system-ui, sans-serif; margin: 0; padding: 24px; line-height: 1.5; color: #14141a; background: #fff; }
  main { max-width: 36rem; margin: 0 auto; }
  h1 { font-size: 1.25rem; margin: 0 0 1rem; }
  #headline { font-size: 1.5rem; font-weight: 700; margin: 0 0 1rem; }
  ul { padding-left: 1.25rem; }
  li { margin: .35rem 0; }
  a { color: #1d4ed8; }
  .quiet { color: #53535e; font-size: .9rem; }
  @media (prefers-color-scheme: dark) { body { background: #121214; color: #f5f5f7; } a { color: #7fa6ff; } .quiet { color: #b8b8c0; } }
</style>
</head>
<body>
<main>
  <h1>Following a Yatri trip</h1>
  <p id="headline" role="status" aria-live="polite">${esc(headline)}</p>
  <ul id="details">${details.map((d) => `<li>${esc(d)}</li>`).join('')}</ul>
  <p id="map" class="quiet"></p>
  <p id="updated" class="quiet"></p>
</main>
<script nonce="${nonce}">
(function () {
  var url = ${JSON.stringify(`/share/${token}/data`)};
  var stopped = ${view ? 'false' : 'true'};
  var headline = document.getElementById('headline');
  var details = document.getElementById('details');
  var map = document.getElementById('map');
  var updated = document.getElementById('updated');
  function render(d) {
    if (headline.textContent !== d.headline) headline.textContent = d.headline;
    details.textContent = '';
    d.details.forEach(function (t) { var li = document.createElement('li'); li.textContent = t; details.appendChild(li); });
    map.textContent = '';
    if (d.view.location) {
      var a = document.createElement('a');
      a.href = 'https://www.openstreetmap.org/?mlat=' + d.view.location.latitude + '&mlon=' + d.view.location.longitude + '#map=17/' + d.view.location.latitude + '/' + d.view.location.longitude;
      a.textContent = "Open the driver's location in a map";
      a.rel = 'noopener noreferrer';
      map.appendChild(a);
    }
    updated.textContent = 'Updated ' + new Date(d.view.updatedAt).toLocaleTimeString() + '.';
  }
  function poll() {
    if (stopped) return;
    fetch(url, { cache: 'no-store' }).then(function (r) {
      if (r.status === 404) { stopped = true; headline.textContent = 'This link is not available.'; details.textContent = ''; map.textContent = ''; return null; }
      return r.json();
    }).then(function (j) { if (j && j.success) render(j.data); }).catch(function () {});
  }
  if (!stopped) { poll(); setInterval(poll, 10000); }
})();
</script>
</body>
</html>`;
}
