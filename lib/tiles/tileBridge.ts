/**
 * tileBridge injects the Vitality bridge into every sealed tile at mount.
 *
 * A tile is a sandboxed srcDoc iframe: opaque origin, no network, and no
 * localStorage (it throws). The ONLY way a tile persists is by calling
 * window.Vitality.save/load, which this shim defines by postMessaging the host
 * (useTileHost) and matching each reply by id. Tiles stay pure feature code;
 * the bridge lives and upgrades here in one place.
 */

const SHIM = `<script>
(function () {
  var pending = {}, seq = 0;
  window.addEventListener('message', function (e) {
    var m = e.data;
    if (!m || m.source !== 'vitality-host') return;
    var p = pending[m.id];
    if (!p) return;
    delete pending[m.id];
    if (m.type === 'load:result') p.resolve(m.data);
    else if (m.type === 'estimate:result') p.resolve(m.data);
    else if (m.type === 'identify:result') p.resolve(m.data);
    else if (m.type === 'style:result') p.resolve(m.data);
    else if (m.type === 'upload:result') p.resolve(m.data);
    else if (m.type === 'save:ok') p.resolve(true);
    else if (m.type === 'save:error') p.reject(new Error(m.reason || 'save_failed'));
  });
  function call(type, extra, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var id = 'v' + (++seq);
      pending[id] = { resolve: resolve, reject: reject };
      var msg = { source: 'vitality-tile', type: type, id: id };
      if (extra) for (var k in extra) msg[k] = extra[k];
      parent.postMessage(msg, '*');
      // backstop: never let a tile hang if a reply is somehow lost.
      setTimeout(function () {
        if (!pending[id]) return;
        delete pending[id];
        if (type === 'load') resolve([]);
        else if (type === 'estimate' || type === 'identify' || type === 'uploadPhoto' || type === 'style') resolve({ ok: false, error: 'timeout' });
        else reject(new Error('vitality_timeout'));
      }, timeoutMs || 8000);
    });
  }
  window.Vitality = {
    save: function (data) { return call('save', { data: data }); },
    load: function () { return call('load', {}); },
    /* AI food estimate: the host relays the photo to the server's Gemini
       vision route (a sealed tile's opaque origin can't reach the API itself).
       Long timeout — a vision call can take tens of seconds. */
    estimateFood: function (image) { return call('estimate', { image: image }, 90000); },
    /* AI clothing identify: same relay as estimateFood — the host forwards the
       item photo to the server's Gemini vision route (opaque-origin tiles can't
       reach the API themselves). Long timeout: a vision call can take tens of seconds. */
    identifyClothing: function (image) { return call('identify', { image: image }, 90000); },
    /* Closet stylist: the host relays the owned items to the server's Gemini
       route (grounded with live web search) and returns outfit combinations +
       shopping gaps. Long timeout — grounded generation can take tens of seconds. */
    styleCloset: function (items, context, influencers) { return call('style', { items: items, context: context, influencers: influencers }, 90000); },
    /* Upload a photo to the owner's cloud storage; resolves { ok, url } or an
       error so the tile can fall back to storing the image inline. */
    uploadPhoto: function (image) { return call('uploadPhoto', { image: image }, 90000); },
    /* Best-effort cleanup of a previously uploaded photo (fire-and-forget). */
    deletePhoto: function (url) { parent.postMessage({ source: 'vitality-tile', type: 'deletePhoto', url: url }, '*'); },
    report: function (stream) {
      parent.postMessage({ source: 'vitality-tile', type: 'report', stream: stream }, '*');
    }
  };
})();
</script>`

/** Prepend the bridge shim so window.Vitality exists inside the sealed tile. */
export function withBridge(html: string): string {
  if (html.includes('<head>')) return html.replace('<head>', '<head>' + SHIM)
  if (html.includes('<body>')) return html.replace('<body>', '<body>' + SHIM)
  return SHIM + html
}
