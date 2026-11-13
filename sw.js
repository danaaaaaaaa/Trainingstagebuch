"use strict";

/* Service Worker: Beim ersten Öffnen (mit Internet) werden alle App-Dateien auf dem
   Handy gespeichert. Danach startet die App auch im Flugmodus.
   WICHTIG: Bei jeder Änderung an der App die Zahl bei VERSION erhöhen, sonst
   bekommt das Handy die neuen Dateien nicht. Die Trainingsdaten sind davon nicht betroffen. */
const VERSION = "v19";
const CACHE = `trainingstagebuch-${VERSION}`;
const FILES = [
  "./", "index.html", "app.js", "store.js", "style.css", "manifest.webmanifest",
  "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(FILES)).then(() => self.skipWaiting()));
});

// Alte Versionen aufräumen
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()));
});

// Erst im Speicher nachsehen, sonst aus dem Netz holen. Nur eigene Dateien.
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== location.origin) return;
  event.respondWith(caches.match(event.request, { ignoreSearch: true }).then((hit) => hit || fetch(event.request)));
});
