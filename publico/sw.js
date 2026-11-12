// Service worker da Área do Formando.
//
// Faz duas coisas, sem inventar cache esperto:
//  1. guarda a casca do site (página, estilo, fonte, logo) para abrir mesmo sem
//     internet — quem instalou na tela de início não vê tela de erro do navegador;
//  2. mostra a notificação (push) que o CRM manda quando a equipe responde um
//     pedido (12/11/2026, mig 1247) — o toque abre o pedido.
//
// Regra: dado do formando NUNCA entra em cache. Só a casca. Todo pedido a
// /area-formando/ vai direto para a rede.

const VERSAO = 'formando-v3';
const CASCA = ['./', './index.html', './estilo.css', './app.js', './logo-formaturas.png', './Daniel.ttf', './manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSAO).then((c) => c.addAll(CASCA).catch(() => null)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((nomes) => Promise.all(nomes.filter((n) => n !== VERSAO).map((n) => caches.delete(n))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // `/api/area-formando/`, com o `/api/`: no GitHub Pages o SITE mora em
  // `/area-formando/`, então a regra antiga marcava o próprio site como se
  // fosse chamada de API — e nada era guardado. O portal se dizia instalável e
  // abria em branco sem internet. A API, hoje, está em outro domínio e já seria
  // excluída pela checagem de origem; o caminho fica como segunda barreira para
  // o dia em que ela voltar a ser servida do mesmo endereço.
  const daApi = url.pathname.includes('/api/area-formando/');
  if (e.request.method !== 'GET' || daApi || url.origin !== location.origin) return;

  // rede primeiro (o site muda a cada publicação); o cache é a rede de segurança
  e.respondWith(
    fetch(e.request)
      .then((resposta) => {
        const copia = resposta.clone();
        caches.open(VERSAO).then((c) => c.put(e.request, copia)).catch(() => null);
        return resposta;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('./index.html'))),
  );
});

// Notificação: o CRM manda { titulo, texto, url } (url = portal com ?pedido=<id>).
self.addEventListener('push', (e) => {
  let dados = {};
  try { dados = e.data ? e.data.json() : {}; } catch { dados = {}; }
  const titulo = dados.titulo || 'Indaiá Formaturas';
  e.waitUntil(self.registration.showNotification(titulo, {
    body: dados.texto || '',
    icon: './icone-192.png',
    badge: './icone-192.png',
    data: { url: dados.url || './' },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const destino = (e.notification.data && e.notification.data.url) || './';
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then((abas) => {
    const aberta = abas.find((a) => a.url.includes(location.origin));
    if (!aberta) return clients.openWindow(destino);
    // Portal já aberto: leva a aba até o pedido (recarrega com ?pedido=) e traz para a frente.
    const ir = aberta.navigate ? aberta.navigate(destino).catch(() => aberta) : Promise.resolve(aberta);
    return ir.then((c) => (c || aberta).focus());
  }));
});
