"use strict";

/* Service Worker: Beim ersten Öffnen (mit Internet) werden alle App-Dateien auf dem
   Handy gespeichert. Danach startet die App auch im Flugmodus.
   WICHTIG: Bei jeder Änderung an der App die Zahl bei VERSION erhöhen, sonst
   bekommt das Handy die neuen Dateien nicht. Die Trainingsdaten sind davon nicht betroffen. */
const VERSION = "v20";
const CACHE = `trainingstagebuch-${VERSION}`;
const FILES = [
  "./", "index.html", "app.js", "store.js", "style.css", "manifest.webmanifest",
  "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png",
];

// Jede Datei einzeln speichern, mit frischem Abruf am Browser-Cache vorbei (sonst könnten
// veraltete Dateien aus dem Zwischenspeicher der Webseite landen). Fehlt eine Datei, bricht
// nicht die ganze Installation ab; die wichtigsten Dateien müssen aber vorhanden sein.
const REQUIRED = ["./", "index.html", "app.js", "store.js", "style.css"];

async function precache() {
  const cache = await caches.open(CACHE);
  const failed = [];
  await Promise.all(FILES.map(async (file) => {
    try {
      const response = await fetch(new Request(file, { cache: "reload" }));
      if (!response.ok) throw new Error(response.status);
      await cache.put(file, response);
    } catch {
      failed.push(file);
    }
  }));
  if (failed.some((file) => REQUIRED.includes(file))) {
    await caches.delete(CACHE);                      // unvollständig: lieber die alte Version behalten
    throw new Error("App-Dateien konnten nicht gespeichert werden.");
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(precache().then(() => self.skipWaiting()));
});

// Alte Versionen aufräumen
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()));
});

// Erst im Speicher nachsehen, sonst aus dem Netz holen. Nur eigene Dateien.
// Seitenaufrufe ohne Treffer und ohne Netz zeigen die gespeicherte Startseite.
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== location.origin) return;
  event.respondWith((async () => {
    const hit = await caches.match(event.request, { ignoreSearch: true });
    if (hit) return hit;
    try {
      return await fetch(event.request);
    } catch (error) {
      if (event.request.mode === "navigate") return (await caches.match("index.html")) || Response.error();
      throw error;
    }
  })());
});
