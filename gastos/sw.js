const CACHE = 'gastos-v18';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k.startsWith('gastos-v') && k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Recibe lo que se comparte desde otra app (WhatsApp, banco, galería) y lo deja para que la app lo levante.
async function recibirCompartido(req) {
  const fd = await req.formData();
  const c = await caches.open('gastos-compartido');
  const texto = ['title', 'text', 'url'].map(k => fd.get(k)).filter(Boolean).join(' ');
  await c.put('compartido-texto', new Response(texto));
  const f = fd.get('file');
  if (f && f.size) await c.put('compartido-archivo', new Response(f, { headers: { 'Content-Type': f.type } }));
  else await c.delete('compartido-archivo');
  return Response.redirect('./?compartido=1', 303);
}

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method === 'POST' && url.pathname.endsWith('/share')) {
    e.respondWith(recibirCompartido(e.request));
    return;
  }
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // Pedidos que exigen ir a la red (el botón "Buscar actualización"): no se responden con la copia guardada.
  if (e.request.cache === 'no-store') return;
  // Responde del caché al instante y actualiza en segundo plano.
  e.respondWith(
    caches.open(CACHE).then(async c => {
      const hit = await c.match(e.request, { ignoreSearch: true });
      const red = fetch(e.request, { cache: 'no-cache' }).then(r => { if (r.ok) c.put(e.request.url.split('?')[0], r.clone()); return r; }).catch(() => hit);
      return hit || red;
    })
  );
});
