/*
 * Service worker do Seja Alpha.
 *
 * Existe por dois motivos: (1) é o que torna o site instalável como app
 * no celular, e (2) dá uma tela decente quando o celular fica sem
 * internet, em vez do dinossauro do Chrome.
 *
 * DE PROPÓSITO ele quase não usa cache: já tivemos problema com versão
 * antiga do app.js grudada no navegador. A regra aqui é sempre buscar da
 * rede primeiro; o cache só entra como último recurso quando a rede
 * falhou. Nada de /api/ é guardado — atendimento não pode mostrar
 * conversa velha achando que é a de agora.
 */
const CACHE = "whatts-inbox-v1";
const ESSENCIAIS = ["/", "/static/styles.css", "/static/app.js"];

self.addEventListener("install", (evento) => {
  self.skipWaiting();
  evento.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(ESSENCIAIS)).catch(() => {})
  );
});

self.addEventListener("activate", (evento) => {
  evento.waitUntil(
    caches.keys()
      .then((nomes) => Promise.all(nomes.filter((n) => n !== CACHE).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

// Notificação push de verdade -- pedido do Clayton (2026-09-14):
// avisar mesmo com o app fechado. O service worker já existia (é o que
// torna o site instalável); isso só adiciona o que faltava: escutar o
// push que o servidor manda e mostrar a notificação do sistema.
self.addEventListener("push", (evento) => {
  let dados = { title: "Seja Alpha", body: "Você tem uma notificação nova." };
  try { if (evento.data) dados = evento.data.json(); } catch (e) { /* usa o padrão acima */ }
  evento.waitUntil(
    self.registration.showNotification(dados.title || "Seja Alpha", {
      body: dados.body || "",
      tag: dados.tag || "whatts",
      icon: "/static/img/icone-192.png",
      badge: "/static/img/icone-192.png",
      data: { url: dados.url || "/" },
    })
  );
});

// Clicar na notificação abre (ou foca) a aba do sistema já na tela
// certa, em vez de só sumir a notificação sem fazer nada.
self.addEventListener("notificationclick", (evento) => {
  evento.notification.close();
  const url = (evento.notification.data && evento.notification.data.url) || "/";
  evento.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((lista) => {
      for (const cliente of lista) {
        if ("focus" in cliente) {
          cliente.navigate(url);
          return cliente.focus();
        }
      }
      return self.clients.openWindow(url);
    })
  );
});

self.addEventListener("fetch", (evento) => {
  const req = evento.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // API nunca passa pelo cache: dado de atendimento é sempre ao vivo.
  if (url.pathname.startsWith("/api/")) return;

  evento.respondWith(
    fetch(req)
      .then((resposta) => {
        if (resposta && resposta.ok) {
          const copia = resposta.clone();
          caches.open(CACHE).then((c) => c.put(req, copia)).catch(() => {});
        }
        return resposta;
      })
      .catch(() =>
        caches.match(req).then((cacheado) => cacheado || caches.match("/"))
      )
  );
});
