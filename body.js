"use strict";

/* =====================================================================
   Muskelkarte: ein 3D-Körper ohne Haut, auf dem die trainierten
   Muskelgruppen farbig markiert sind. Alles wird direkt in der App
   berechnet (kein Internet, keine fremden Dateien).

   Aufbau dieser Datei:
     1. BodyGeometry   baut den Körper aus vielen Muskel-Ellipsoiden
     2. BodyRenderer   zeichnet ihn (eigener kleiner 3D-Zeichner mit Tiefenspeicher)
     3. BodyViewer     Bedienung (Drehen, Verschieben, Zoomen), Legende, Details
   ===================================================================== */


/* ---------------------------------------------------------------------
   1. BodyGeometry
   Der Körper besteht aus "Teilen". Jedes Teil ist ein Ellipsoid (gestreckte Kugel),
   das einen Muskel, einen Knochen oder Füllmasse darstellt. Muskeln mit
   Zuordnung zu einer Standard-Muskelgruppe werden später eingefärbt.
   --------------------------------------------------------------------- */

class BodyGeometry {
  static RINGS = 14;          // Unterteilung einer Kugel von Pol zu Pol
  static SEGMENTS = 22;       // Unterteilung rund herum
  static cache = new Map();

  /** Liefert (und merkt sich) das Modell: "male" oder "female". */
  static get(sex) {
    if (!BodyGeometry.cache.has(sex)) BodyGeometry.cache.set(sex, new BodyGeometry(sex));
    return BodyGeometry.cache.get(sex);
  }

  constructor(sex) {
    this.sex = sex;
    this.parts = [];            // [{ name, group, kind, stripes }]
    this.pos = [];              // Eckpunkte (x, y, z)
    this.nrm = [];              // Flächennormalen (für die Beleuchtung)
    this.phi = [];              // Winkel um die Längsachse (für die Muskelfasern)
    this.vy = [];               // Lage entlang der Längsachse -1..1 (für die Sehnen an den Enden)
    this.owner = [];            // zu welchem Teil gehört der Eckpunkt
    this.tris = [];             // Dreiecke (drei Eckpunkt-Nummern)
    this.build();
    this.pos = new Float32Array(this.pos);
    this.nrm = new Float32Array(this.nrm);
    this.phi = new Float32Array(this.phi);
    this.vy = new Float32Array(this.vy);
    this.owner = new Uint16Array(this.owner);
    this.tris = new Uint32Array(this.tris);
  }

  // ---------- kleine Vektor-Hilfen ----------
  static sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  static dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  static cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
  static len(a) { return Math.hypot(a[0], a[1], a[2]); }
  static unit(a) { const l = BodyGeometry.len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }

  /** Achsen eines Ellipsoids aus drei Drehwinkeln (um x, dann y, dann z). */
  static eulerAxes(ax = 0, ay = 0, az = 0) {
    const [sx, cx, sy, cy, sz, cz] = [Math.sin(ax), Math.cos(ax), Math.sin(ay), Math.cos(ay), Math.sin(az), Math.cos(az)];
    // R = Rz * Ry * Rx; die Spalten sind die gedrehten Achsen
    return {
      x: [cz * cy, sz * cy, -sy],
      y: [cz * sy * sx - sz * cx, sz * sy * sx + cz * cx, cy * sx],
      z: [cz * sy * cx + sz * sx, sz * sy * cx - cz * sx, cy * cx],
    };
  }

  /** Achsen für einen Muskel entlang eines Gliedes (von a nach b): y = Längsrichtung, z = nach vorn. */
  static limbAxes(a, b) {
    const y = BodyGeometry.unit(BodyGeometry.sub(b, a));
    let z = [0, 0, 1];
    const d = BodyGeometry.dot(z, y);
    z = BodyGeometry.unit([z[0] - y[0] * d, z[1] - y[1] * d, z[2] - y[2] * d]);
    return { x: BodyGeometry.cross(y, z), y, z };
  }

  /** Fügt ein Ellipsoid hinzu. spec: { name, group, kind, stripes, c: Mitte, r: Radien, axes } */
  add(spec) {
    const k = this.scale;
    const partIndex = this.parts.length;
    this.parts.push({ name: spec.name, group: spec.group || null, kind: spec.kind || "muscle", stripes: spec.stripes ?? 6 });

    const { RINGS, SEGMENTS } = BodyGeometry;
    const c = spec.c.map((v) => v * k);
    const r = spec.r.map((v) => v * k);
    const { x: ax, y: ay, z: az } = spec.axes;
    const base = this.pos.length / 3;

    for (let i = 0; i <= RINGS; i++) {
      const theta = (i / RINGS) * Math.PI;
      for (let j = 0; j <= SEGMENTS; j++) {
        const phi = (j / SEGMENTS) * Math.PI * 2;
        const ux = Math.sin(theta) * Math.cos(phi), uy = Math.cos(theta), uz = Math.sin(theta) * Math.sin(phi);
        const px = ux * r[0], py = uy * r[1], pz = uz * r[2];
        // Normale eines Ellipsoids: Achsen mit 1/Radius gewichtet
        const nx = ux / r[0], ny = uy / r[1], nz = uz / r[2];
        const n = BodyGeometry.unit([
          ax[0] * nx + ay[0] * ny + az[0] * nz, ax[1] * nx + ay[1] * ny + az[1] * nz, ax[2] * nx + ay[2] * ny + az[2] * nz]);
        this.pos.push(c[0] + ax[0] * px + ay[0] * py + az[0] * pz,
          c[1] + ax[1] * px + ay[1] * py + az[1] * pz,
          c[2] + ax[2] * px + ay[2] * py + az[2] * pz);
        this.nrm.push(n[0], n[1], n[2]);
        this.phi.push(phi);
        this.vy.push(uy);
        this.owner.push(partIndex);
      }
    }
    const row = SEGMENTS + 1;
    for (let i = 0; i < RINGS; i++) {
      for (let j = 0; j < SEGMENTS; j++) {
        const a = base + i * row + j, b = a + 1, c2 = a + row, d = c2 + 1;
        this.tris.push(a, c2, b, b, c2, d);
      }
    }
  }

  /** Ellipsoid entlang einer Strecke a→b (Arm, Bein): von u0 bis u1 der Strecke,
   *  rw = Breite, rd = Tiefe, ox/oz = seitliche bzw. nach vorn/hinten verschobene Lage. */
  limb(a, b, u0, u1, rw, rd, ox, oz, spec) {
    const at = (u) => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
    const mid = at((u0 + u1) / 2);
    const half = BodyGeometry.len(BodyGeometry.sub(b, a)) * (u1 - u0) / 2;
    this.add({ ...spec, c: [mid[0] + ox, mid[1], mid[2] + oz], r: [rw, half, rd], axes: BodyGeometry.limbAxes(a, b) });
  }

  /** Ellipsoid mit freier Lage und Drehwinkeln (für den Rumpf). */
  blob(spec, c, r, rot = [0, 0, 0]) {
    this.add({ ...spec, c, r, axes: BodyGeometry.eulerAxes(...rot) });
  }

  /** Der ganze Körper. Maße in Metern, Körpergröße etwa 1,80 m (Frau etwas kleiner). */
  build() {
    const female = this.sex === "female";
    const P = female
      ? { sh: 0.178, hip: 0.106, mus: 0.8, leg: 0.95, glute: 1.18, chest: 0.72, waist: 0.82, scale: 0.95 }
      : { sh: 0.205, hip: 0.095, mus: 1, leg: 1, glute: 1, chest: 1, waist: 1, scale: 1 };
    this.scale = P.scale;

    // Kurznamen für die Muskelgruppen (müssen zu DEFAULT_MUSCLES in store.js passen)
    const G = {
      chest: "Brust", back: "Rücken", shoulder: "Schultern", biceps: "Bizeps", triceps: "Trizeps",
      abs: "Bauch", front: "Beinstrecker", rear: "Beinbeuger", glutes: "Gesäß", calves: "Waden",
      traps: "Trapez", lower: "Unterer Rücken", forearm: "Unterarme", neck: "Nacken", adduct: "Adduktoren", abduct: "Abduktoren",
    };
    const MUSCLE = (name, group, stripes = 7) => ({ name, group, kind: group ? "muscle" : "other", stripes });
    const CORE = { name: "Füllmasse", kind: "core", stripes: 0 };
    const BONE = (name) => ({ name, kind: "bone", stripes: 0 });
    const m = P.mus, am = P.mus * 1.3, lg = P.leg * 1.25;   // Arme und Beine kräftiger

    // ----- Rumpf, Kopf, Hals (nicht seitenweise) -----
    this.blob(CORE, [0, 1.27, -0.005], [P.sh * 0.82, 0.27, 0.105]);
    this.blob(CORE, [0, 1.38, 0], [P.sh * 0.86, 0.12, 0.1]);
    this.blob(CORE, [0, 1.1, 0], [0.11 * P.waist, 0.12, 0.08]);
    this.blob(CORE, [0, 0.97, -0.01], [P.hip + 0.05, 0.1, 0.09]);
    this.blob(CORE, [0, 1.545, -0.005], [0.045, 0.075, 0.045]);
    this.blob(BONE("Schädel"), [0, 1.7, 0.0], [0.083, 0.102, 0.098]);
    this.blob(BONE("Kiefer"), [0, 1.648, 0.03], [0.06, 0.042, 0.066]);

    // Bauchmuskeln in der Mitte (gerader Bauchmuskel: je Seite vier Segmente)
    // werden unten seitenweise gebaut.

    for (const s of [1, -1]) {
      const H = [s * P.hip, 0.92, 0], K = [s * (P.hip + 0.035), 0.5, 0.005], A = [s * (P.hip + 0.06), 0.08, 0];
      const S = [s * P.sh, 1.44, 0], E = [s * (P.sh + 0.085), 1.17, 0], W = [s * (P.sh + 0.16), 0.92, 0.025];

      // ----- Brust -----
      this.blob(MUSCLE("Großer Brustmuskel", G.chest), [s * 0.088, 1.345, 0.072], [0.108 * P.chest + 0.01, 0.07 * P.chest + 0.012, 0.05 * P.chest + 0.008], [0, 0, s * 0.3]);
      this.blob(MUSCLE("Großer Brustmuskel unten", G.chest), [s * 0.085, 1.29, 0.07], [0.09 * P.chest + 0.01, 0.045 * P.chest + 0.01, 0.042 * P.chest + 0.008], [0, 0, s * 0.1]);

      // ----- Schultern: vorderer, seitlicher, hinterer Teil -----
      const dx = s * (P.sh + 0.025);
      this.blob(MUSCLE("Schulter vorn", G.shoulder), [dx - s * 0.01, 1.425, 0.04], [0.05 * m + 0.01, 0.07, 0.05 * m + 0.01], [0, 0, s * -0.15]);
      this.blob(MUSCLE("Schulter seitlich", G.shoulder), [dx + s * 0.012, 1.415, 0.0], [0.048 * m + 0.012, 0.075, 0.052 * m + 0.012], [0, 0, s * -0.2]);
      this.blob(MUSCLE("Schulter hinten", G.shoulder), [dx - s * 0.008, 1.42, -0.04], [0.045 * m + 0.01, 0.065, 0.045 * m + 0.01], [0, 0, s * -0.15]);

      // ----- Arme -----
      this.limb(S, E, -0.02, 1.0, 0.033, 0.033, 0, 0, CORE);
      this.limb(S, E, 0.12, 0.8, 0.036 * am + 0.006, 0.034 * am + 0.006, 0, 0.022, MUSCLE("Bizeps", G.biceps));
      this.limb(S, E, 0.1, 0.72, 0.034 * am + 0.006, 0.03 * am + 0.006, s * 0.014, -0.026, MUSCLE("Trizeps lang", G.triceps));
      this.limb(S, E, 0.2, 0.9, 0.03 * am + 0.006, 0.03 * am + 0.006, s * 0.025, -0.012, MUSCLE("Trizeps seitlich", G.triceps));
      this.blob(BONE("Ellbogen"), [E[0], E[1], E[2] - 0.012], [0.024, 0.026, 0.026]);
      this.limb(E, W, 0.04, 0.55, 0.034 * am + 0.004, 0.03 * am + 0.004, 0, 0.004, MUSCLE("Unterarm oben", G.forearm));
      this.limb(E, W, 0.35, 0.98, 0.024 * am + 0.004, 0.022 * am + 0.004, 0, 0.002, MUSCLE("Unterarm unten", G.forearm));
      this.blob(BONE("Hand"), [W[0] + s * 0.01, W[1] - 0.042, W[2] + 0.008], [0.033, 0.07, 0.018], [0, 0, s * 0.12]);

      // ----- Rücken (hinten) -----
      this.blob(MUSCLE("Trapez oben", G.traps), [s * 0.065, 1.44, -0.07], [0.095, 0.075, 0.035], [0, 0, s * -0.3]);
      this.blob(MUSCLE("Trapez unten", G.traps), [s * 0.032, 1.3, -0.088], [0.06, 0.105, 0.026], [0, 0, s * -0.08]);
      this.blob(MUSCLE("Breiter Rückenmuskel", G.back), [s * 0.125, 1.22, -0.078], [0.07 * m + 0.015, 0.16, 0.036], [0, 0, s * -0.3]);
      this.blob(MUSCLE("Rundmuskel", G.back), [s * 0.148, 1.355, -0.075], [0.05, 0.03, 0.03], [0, 0, s * 0.2]);
      this.blob(MUSCLE("Rückenstrecker", G.lower), [s * 0.036, 1.06, -0.082], [0.032, 0.15, 0.03]);
      this.blob(MUSCLE("Untergrätenmuskel", G.back), [s * 0.115, 1.385, -0.085], [0.06, 0.04, 0.022], [0, 0, s * 0.1]);

      // ----- Bauch -----
      for (let i = 0; i < 4; i++) {
        this.blob(MUSCLE("Gerader Bauchmuskel", G.abs, 3), [s * 0.038, 1.235 - 0.052 * i, 0.078], [0.038, 0.03, 0.022]);
      }
      this.blob(MUSCLE("Schräger Bauchmuskel", G.abs), [s * 0.125, 1.11, 0.038], [0.045 * P.waist + 0.01, 0.115, 0.05], [0, 0, s * -0.15]);
      this.blob(MUSCLE("Sägemuskel", null), [s * 0.155, 1.27, 0.04], [0.035, 0.075, 0.035], [0, 0, s * -0.1]);
      this.blob(MUSCLE("Rippenmuskel", null), [s * 0.1, 1.2, 0.07], [0.04, 0.05, 0.03], [0, 0, s * -0.2]);

      // ----- Gesäß -----
      this.blob(MUSCLE("Großer Gesäßmuskel", G.glutes), [s * 0.092, 0.925, -0.088], [0.092 * P.glute, 0.092 * P.glute, 0.072 * P.glute], [0, 0, s * -0.1]);
      this.blob(MUSCLE("Mittlerer Gesäßmuskel", G.abduct), [s * 0.15, 1.0, -0.055], [0.05 * P.glute, 0.045, 0.045 * P.glute]);

      // ----- Oberschenkel: Beinkern, Vorder- und Rückseite, Innenseite -----
      this.limb(H, K, 0.02, 1.0, 0.058 * lg, 0.06 * lg, 0, 0, CORE);
      this.limb(H, K, 0.08, 0.86, 0.047 * lg, 0.042 * lg, 0, 0.042 * lg, MUSCLE("Gerader Oberschenkelmuskel", G.front));
      this.limb(H, K, 0.14, 0.92, 0.05 * lg, 0.05 * lg, s * 0.048 * lg, 0.012, MUSCLE("Äußerer Schenkelmuskel", G.front));
      this.limb(H, K, 0.4, 0.97, 0.044 * lg, 0.04 * lg, s * -0.03 * lg, 0.022, MUSCLE("Innerer Schenkelmuskel", G.front));
      this.limb(H, K, 0.12, 0.9, 0.042 * lg, 0.04 * lg, s * 0.03 * lg, -0.038 * lg, MUSCLE("Zweiköpfiger Schenkelmuskel", G.rear));
      this.limb(H, K, 0.1, 0.88, 0.042 * lg, 0.04 * lg, s * -0.012 * lg, -0.042 * lg, MUSCLE("Halbsehnenmuskel", G.rear));
      this.limb(H, K, 0.12, 0.7, 0.036 * lg, 0.04 * lg, s * -0.05 * lg, -0.004, MUSCLE("Schenkelanzieher", G.adduct));
      this.blob(BONE("Kniescheibe"), [K[0], K[1] + 0.005, K[2] + 0.05], [0.027, 0.032, 0.016]);

      // ----- Unterschenkel -----
      this.limb(K, A, 0.0, 1.0, 0.031, 0.031, 0, 0, BONE("Schienbein"));
      this.limb(K, A, 0.04, 0.52, 0.037 * lg, 0.037 * lg, s * -0.02 * lg, -0.038, MUSCLE("Wade innen", G.calves));
      this.limb(K, A, 0.05, 0.5, 0.034 * lg, 0.034 * lg, s * 0.02 * lg, -0.038, MUSCLE("Wade außen", G.calves));
      this.limb(K, A, 0.28, 0.72, 0.034 * lg, 0.03 * lg, 0, -0.026, MUSCLE("Schollenmuskel", G.calves));
      this.limb(K, A, 0.14, 0.82, 0.026 * lg, 0.024 * lg, s * 0.014, 0.028, MUSCLE("Vorderer Schienbeinmuskel", G.calves));

      // ----- Füße und Schlüsselbein -----
      this.blob(BONE("Fuß"), [s * (P.hip + 0.075), 0.035, 0.055], [0.045, 0.035, 0.11], [0, s * -0.12, 0]);
      this.blob(BONE("Schlüsselbein"), [s * 0.07, 1.468, 0.05], [0.065, 0.011, 0.013], [0, 0, s * 0.12]);
      this.blob(MUSCLE("Kopfwender", G.neck), [s * 0.035, 1.55, 0.022], [0.02, 0.055, 0.02], [0, 0, s * -0.3]);
    }
  }
}


/* ---------------------------------------------------------------------
   2. BodyRenderer
   Ein kleiner eigener 3D-Zeichner: Jedes Dreieck wird Pixel für Pixel in einen
   Bildspeicher gezeichnet, ein Tiefenspeicher sorgt dafür, dass vorn liegende
   Muskeln hinten liegende verdecken. Dazu kommt ein "Nummernspeicher":
   Er verrät, welches Teil an einer Stelle des Bildes liegt (zum Antippen).
   --------------------------------------------------------------------- */

class BodyRenderer {
  // Licht von links oben vorn (in Blickrichtung des Betrachters)
  static LIGHT = (() => { const v = [-0.35, 0.55, 0.76]; const l = Math.hypot(...v); return v.map((x) => x / l); })();
  static STRIPE_TABLE = Float32Array.from({ length: 512 }, (_, i) => 0.5 + 0.5 * Math.sin((i / 512) * Math.PI * 2));

  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.width = 0;
    this.height = 0;
    this.scale = 1;
    this.ids = null;            // Nummernspeicher des zuletzt gezeichneten Bildes
  }

  /** Zeichnet den Körper.
   *  model: BodyGeometry; colors: Float32Array (je Teil r,g,b, 0..255);
   *  view: { yaw, pitch, zoom, panX, panY }; cssWidth/cssHeight: Größe in CSS-Pixeln;
   *  quality: Pixel pro CSS-Pixel (kleiner = schneller). */
  render(model, colors, view, cssWidth, cssHeight, quality, theme) {
    const W = Math.max(2, Math.round(cssWidth * quality)), H = Math.max(2, Math.round(cssHeight * quality));
    if (W !== this.width || H !== this.height) this.allocate(W, H);
    this.scale = quality;

    const { pos, nrm, phi, vy, owner, tris, parts } = model;
    const n = pos.length / 3;
    const k = H * 0.46 * view.zoom;                         // Pixel pro Meter
    const cx = W / 2 + view.panX * quality, cy = H / 2 + view.panY * quality;
    const cYaw = Math.cos(view.yaw), sYaw = Math.sin(view.yaw);
    const cPit = Math.cos(view.pitch), sPit = Math.sin(view.pitch);
    const CENTER_Y = 0.9 * model.scale;                     // Drehpunkt in Körpermitte

    // --- alle Eckpunkte in Bildschirmkoordinaten umrechnen ---
    const sx = this.sx, sy = this.sy, sz = this.sz, nx = this.nx, ny = this.ny, nz = this.nz;
    for (let i = 0; i < n; i++) {
      const o = i * 3;
      const x = pos[o], y = pos[o + 1] - CENTER_Y, z = pos[o + 2];
      const x1 = x * cYaw + z * sYaw, z1 = -x * sYaw + z * cYaw;
      const y2 = y * cPit - z1 * sPit, z2 = y * sPit + z1 * cPit;
      sx[i] = cx + x1 * k; sy[i] = cy - y2 * k; sz[i] = z2;
      const ax = nrm[o], ay = nrm[o + 1], az = nrm[o + 2];
      const a1 = ax * cYaw + az * sYaw, c1 = -ax * sYaw + az * cYaw;
      nx[i] = a1; ny[i] = ay * cPit - c1 * sPit; nz[i] = ay * sPit + c1 * cPit;
    }

    // --- Bildspeicher leeren ---
    this.zbuf.fill(-1e9);
    this.pixels.fill(0);
    this.ids.fill(0);

    const [lx, ly, lz] = BodyRenderer.LIGHT;
    const stripe = BodyRenderer.STRIPE_TABLE;
    const tendon = theme.tendon;
    const zbuf = this.zbuf, pix = this.pixels, ids = this.ids;

    for (let t = 0; t < tris.length; t += 3) {
      const a = tris[t], b = tris[t + 1], c = tris[t + 2];
      // Rückseiten überspringen (Normale zeigt vom Betrachter weg)
      if (nz[a] + nz[b] + nz[c] < -0.6) continue;

      const x0 = sx[a], y0 = sy[a], x1 = sx[b], y1 = sy[b], x2 = sx[c], y2 = sy[c];
      const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
      if (area > -1e-6 && area < 1e-6) continue;
      const inv = 1 / area;
      const minX = Math.max(0, Math.floor(Math.min(x0, x1, x2))), maxX = Math.min(W - 1, Math.ceil(Math.max(x0, x1, x2)));
      const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2))), maxY = Math.min(H - 1, Math.ceil(Math.max(y0, y1, y2)));
      if (minX > maxX || minY > maxY) continue;

      const part = owner[a], info = parts[part];
      const base = part * 3;
      const r0 = colors[base], g0 = colors[base + 1], b0 = colors[base + 2];
      const withTendon = info.kind === "muscle" || info.kind === "other";
      const stripeAmount = withTendon ? 0.12 : 0;
      const stripes = info.stripes;
      const z0 = sz[a], z1 = sz[b], z2 = sz[c];
      const nx0 = nx[a], nx1 = nx[b], nx2 = nx[c], ny0 = ny[a], ny1 = ny[b], ny2 = ny[c], nz0 = nz[a], nz1 = nz[b], nz2 = nz[c];
      const ph0 = phi[a], ph1 = phi[b], ph2 = phi[c], v0 = vy[a], v1 = vy[b], v2 = vy[c];

      for (let y = minY; y <= maxY; y++) {
        const py = y + 0.5;
        for (let x = minX; x <= maxX; x++) {
          const px = x + 0.5;
          const w0 = ((x1 - px) * (y2 - py) - (x2 - px) * (y1 - py)) * inv;
          const w1 = ((x2 - px) * (y0 - py) - (x0 - px) * (y2 - py)) * inv;
          const w2 = 1 - w0 - w1;
          if (w0 < 0 || w1 < 0 || w2 < 0) continue;
          const z = w0 * z0 + w1 * z1 + w2 * z2;
          const idx = y * W + x;
          if (z <= zbuf[idx]) continue;
          zbuf[idx] = z;

          // Normale an dieser Stelle und Beleuchtung
          let qx = w0 * nx0 + w1 * nx1 + w2 * nx2, qy = w0 * ny0 + w1 * ny1 + w2 * ny2, qz = w0 * nz0 + w1 * nz1 + w2 * nz2;
          const ql = 1 / (Math.sqrt(qx * qx + qy * qy + qz * qz) || 1);
          qx *= ql; qy *= ql; qz *= ql;
          const diffuse = Math.max(0, qx * lx + qy * ly + qz * lz);
          const facing = qz > 0 ? qz : 0;
          // Rand etwas abdunkeln: gibt den Muskeln Kontur
          const edge = facing < 0.32 ? 0.58 + 0.42 * (facing / 0.32) : 1;
          let light = (0.4 + 0.72 * diffuse) * edge;

          let r = r0, g = g0, bl = b0;
          if (withTendon) {
            // Muskelfasern: feine Streifen längs des Muskels
            const ph = w0 * ph0 + w1 * ph1 + w2 * ph2;
            const s = stripe[((ph * (512 / 6.2831853) * stripes) | 0) & 511];
            light *= 1 - stripeAmount * s;
            // Sehnen: helle Enden des Muskels
            const v = w0 * v0 + w1 * v1 + w2 * v2;
            const av = v < 0 ? -v : v;
            if (av > 0.78) {
              const m = Math.min(1, (av - 0.78) / 0.2) * 0.62;
              r += (tendon[0] - r) * m; g += (tendon[1] - g) * m; bl += (tendon[2] - bl) * m;
            }
          }
          // Glanzlicht (leicht)
          const spec = diffuse > 0.8 ? (diffuse - 0.8) * 1.1 : 0;
          let R = r * light + spec * 255, G = g * light + spec * 255, B = bl * light + spec * 255;
          R = R > 255 ? 255 : R; G = G > 255 ? 255 : G; B = B > 255 ? 255 : B;
          pix[idx] = (255 << 24) | (B << 16) | (G << 8) | R;
          ids[idx] = part + 1;
        }
      }
    }

    this.ctx.putImageData(this.imageData, 0, 0);
  }

  /** Legt die Zeichenflächen in der benötigten Größe an. */
  allocate(W, H) {
    this.width = W;
    this.height = H;
    this.canvas.width = W;
    this.canvas.height = H;
    this.imageData = this.ctx.createImageData(W, H);
    this.pixels = new Uint32Array(this.imageData.data.buffer);
    this.zbuf = new Float32Array(W * H);
    this.ids = new Uint16Array(W * H);
  }

  /** Reserviert Arbeitsspeicher für die Eckpunkte (einmal je Modell). */
  prepare(vertexCount) {
    if (!this.sx || this.sx.length !== vertexCount) {
      for (const key of ["sx", "sy", "sz", "nx", "ny", "nz"]) this[key] = new Float32Array(vertexCount);
    }
  }

  /** Welches Teil liegt an dieser Stelle (CSS-Pixel)? Gibt die Teile-Nummer oder -1 zurück. */
  pick(cssX, cssY) {
    if (!this.ids) return -1;
    const x = Math.floor(cssX * this.scale), y = Math.floor(cssY * this.scale);
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return -1;
    // kleine Umgebung absuchen, damit man dünne Muskeln auch mit dem Finger trifft
    for (const radius of [0, 2, 4, 6]) {
      for (let dy = -radius; dy <= radius; dy += Math.max(1, radius)) {
        for (let dx = -radius; dx <= radius; dx += Math.max(1, radius)) {
          const xx = x + dx * (this.scale > 1 ? 1 : 1), yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= this.width || yy >= this.height) continue;
          const id = this.ids[yy * this.width + xx];
          if (id) return id - 1;
        }
      }
    }
    return -1;
  }
}


/* ---------------------------------------------------------------------
   3. BodyViewer
   Die Bedienoberfläche: Bild mit Fingerbedienung, Ansichts-Tasten, Legende
   und Detailfeld. Ein Finger dreht den Körper, zwei Finger verschieben und
   zoomen. Ein kurzer Tipp auf einen Muskel wählt seine Gruppe.
   --------------------------------------------------------------------- */

class BodyViewer {
  // Farbverlauf für die Trainingsintensität: wenig → viel
  static HEAT = [[255, 217, 90], [255, 145, 30], [214, 36, 30]];
  // Muskelgruppen, die sich am Körper darstellen lassen (Rest: Legende ohne Körperfarbe)
  static DRAWABLE = ["Brust", "Rücken", "Schultern", "Bizeps", "Trizeps", "Bauch",
    "Beinstrecker", "Beinbeuger", "Gesäß", "Waden",
    "Trapez", "Unterer Rücken", "Unterarme", "Nacken", "Adduktoren", "Abduktoren"];

  /** muscles: Auswertung [{ muscle, sets, reps, volume }]; sex: "male" | "female". */
  constructor(muscles, sex) {
    this.sex = sex === "female" ? "female" : "male";
    this.muscles = muscles;
    this.model = BodyGeometry.get(this.sex);
    this.view = BodyViewer.defaultView();
    this.selected = null;               // gewählte Muskelgruppe (Name) oder null
    this.pointers = new Map();
    this.frame = 0;
    this.idleTimer = 0;
    this.percentFormat = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 1 });
    this.countFormat = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 0 });
    this.element = this.buildElement();
  }

  static defaultView() {
    return { yaw: 0, pitch: 0.06, zoom: 1.25, panX: 0, panY: 0 };
  }

  // ---------- Farben ----------

  /** Anteil (0..1) der Wiederholungen jeder Gruppe am stärksten trainierten. */
  intensityByGroup() {
    const drawable = this.muscles.filter((m) => m.muscle && BodyViewer.DRAWABLE.includes(m.muscle));
    const max = Math.max(1, ...drawable.map((m) => m.reps));
    return new Map(drawable.map((m) => [m.muscle, m.reps / max]));
  }

  static heatColor(t) {
    const stops = BodyViewer.HEAT;
    const x = Math.min(1, Math.max(0, t)) * (stops.length - 1);
    const i = Math.min(stops.length - 2, Math.floor(x)), f = x - i;
    return stops[i].map((v, j) => v + (stops[i + 1][j] - v) * f);
  }

  /** Farben für alle Teile: trainierte Gruppen im Farbverlauf, der Rest in dezentem Grau. */
  theme() {
    const dark = window.matchMedia?.("(prefers-color-scheme: dark)").matches;
    const forced = document.documentElement.dataset.theme;
    const isDark = forced ? forced === "dark" : dark;
    return {
      muscle: isDark ? [140, 140, 148] : [150, 146, 150],
      core: isDark ? [70, 70, 78] : [112, 108, 116],
      bone: isDark ? [214, 208, 196] : [226, 218, 202],
      tendon: [232, 222, 204],
    };
  }

  buildColors() {
    const theme = this.theme();
    const intensity = this.intensityByGroup();
    const parts = this.model.parts;
    const colors = new Float32Array(parts.length * 3);
    parts.forEach((part, i) => {
      let color = theme.muscle;
      if (part.kind === "core") color = theme.core;
      else if (part.kind === "bone") color = theme.bone;
      else if (part.group && intensity.has(part.group)) color = BodyViewer.heatColor(0.12 + 0.88 * intensity.get(part.group));

      // Gewählte Gruppe hervorheben, alle anderen etwas zurücknehmen
      if (this.selected && part.kind !== "core" && part.kind !== "bone") {
        if (part.group === this.selected) color = color.map((v) => Math.min(255, v * 1.12 + 14));
        else color = color.map((v, j) => v * 0.55 + theme.core[j] * 0.45);
      }
      colors.set(color, i * 3);
    });
    this.themeColors = theme;
    return colors;
  }

  // ---------- Aufbau der Oberfläche ----------

  buildElement() {
    const el = (tag, attrs = {}, ...children) => {
      const node = document.createElement(tag);
      for (const [key, value] of Object.entries(attrs)) {
        if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
        else if (key === "class") node.className = value;
        else if (value !== false && value != null) node.setAttribute(key, value === true ? "" : value);
      }
      node.append(...children.flat(Infinity).filter((c) => c != null && c !== false));
      return node;
    };

    this.canvas = el("canvas", {
      class: "body-canvas", role: "img", tabindex: "0",
      "aria-label": "Körper mit farbig markierten Muskelgruppen. Mit einem Finger drehen, mit zwei Fingern verschieben und zoomen.",
    });
    this.renderer = new BodyRenderer(this.canvas);
    this.renderer.prepare(this.model.pos.length / 3);

    this.canvas.addEventListener("pointerdown", (e) => this.onDown(e));
    this.canvas.addEventListener("pointermove", (e) => this.onMove(e));
    this.canvas.addEventListener("pointerup", (e) => this.onUp(e));
    this.canvas.addEventListener("pointercancel", (e) => this.onUp(e, true));
    this.canvas.addEventListener("wheel", (e) => { e.preventDefault(); this.zoomBy(Math.exp(-e.deltaY * 0.0015)); }, { passive: false });
    this.canvas.addEventListener("keydown", (e) => this.onKey(e));

    const viewButton = (label, yaw) => el("button", { type: "button", class: "view-btn", onclick: () => this.animateTo({ yaw }) }, label);
    this.viewBar = el("div", { class: "view-bar", role: "group", "aria-label": "Ansicht" },
      viewButton("Vorne", 0), viewButton("Seite", Math.PI / 2), viewButton("Hinten", Math.PI),
      el("button", { type: "button", class: "view-btn", onclick: () => this.animateTo(BodyViewer.defaultView()) }, "Zentrieren"));

    this.legend = el("ul", { class: "body-legend" });
    this.detail = el("div", { class: "pie-detail", "aria-live": "polite" });
    this.note = el("p", { class: "muted small body-note" });
    this.stage = el("div", { class: "body-stage" }, this.canvas);

    this.refreshLegend();
    const root = el("div", { class: "body-viewer" }, this.stage, this.viewBar, this.legend, this.detail, this.note);

    // Größe beobachten (die Karte ist erst sichtbar, wenn der Bereich aufgeklappt wird)
    if (window.ResizeObserver) {
      this.observer = new ResizeObserver(() => this.draw(1));
      this.observer.observe(this.stage);
    }
    requestAnimationFrame(() => this.draw(1));
    return root;
  }

  // ---------- Zeichnen ----------

  /** Größe der Zeichenfläche in CSS-Pixeln: Seitenverhältnis 4:5. */
  size() {
    const width = this.stage.clientWidth;
    return { width, height: Math.round(width * 1.25) };
  }

  /** Zeichnet das Bild. quality 1 = schnell (beim Bewegen), sonst scharf in Gerätepixeln. */
  draw(forceFull = 0) {
    const { width, height } = this.size();
    if (!width) return;
    this.canvas.style.height = `${height}px`;
    const sharp = Math.min(window.devicePixelRatio || 1, 2);
    const interacting = this.pointers.size > 0 || this.animating;
    const quality = interacting && !forceFull ? Math.min(1, sharp) : sharp;
    this.renderer.render(this.model, this.colors ||= this.buildColors(), this.view, width, height, quality, this.themeColors || this.theme());
  }

  /** Zeichnet höchstens einmal pro Bildwechsel; danach, wenn Ruhe ist, einmal in voller Schärfe. */
  requestDraw() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
      clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => this.draw(1), 140);
    });
  }

  // ---------- Bedienung per Finger, Maus und Tastatur ----------

  onDown(event) {
    this.canvas.setPointerCapture?.(event.pointerId);
    this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    this.gesture = {
      startX: event.clientX, startY: event.clientY, startTime: performance.now(), moved: 0,
      multi: this.pointers.size > 1,
    };
    this.pinch = this.pinchState();
    this.animating = false;
  }

  pinchState() {
    if (this.pointers.size < 2) return null;
    const [a, b] = [...this.pointers.values()];
    return { distance: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
  }

  onMove(event) {
    const previous = this.pointers.get(event.pointerId);
    if (!previous) return;
    const next = { x: event.clientX, y: event.clientY };
    this.gesture.moved += Math.hypot(next.x - previous.x, next.y - previous.y);
    this.pointers.set(event.pointerId, next);

    if (this.pointers.size >= 2) {
      // Zwei Finger: verschieben und zoomen
      this.gesture.multi = true;
      const now = this.pinchState();
      if (this.pinch && now) {
        this.view.panX += now.cx - this.pinch.cx;
        this.view.panY += now.cy - this.pinch.cy;
        this.zoomBy(now.distance / (this.pinch.distance || 1), false);
      }
      this.pinch = now;
    } else {
      // Ein Finger: drehen (seitlich) und leicht kippen (nach oben/unten)
      this.view.yaw += (next.x - previous.x) * 0.012;
      this.view.pitch = Math.min(0.6, Math.max(-0.45, this.view.pitch + (next.y - previous.y) * 0.006));
    }
    this.requestDraw();
  }

  onUp(event, cancelled = false) {
    if (!this.pointers.has(event.pointerId)) return;
    const wasTap = !cancelled && !this.gesture.multi && this.gesture.moved < 8 && performance.now() - this.gesture.startTime < 500;
    this.pointers.delete(event.pointerId);
    this.pinch = this.pinchState();
    if (this.pointers.size === 1) {          // ein Finger bleibt: nicht plötzlich springen
      const [rest] = this.pointers.values();
      this.gesture.startX = rest.x;
    }
    if (wasTap) this.tap(event);
    this.requestDraw();
  }

  /** Tipp auf den Körper: Gruppe des getroffenen Teils wählen (oder Auswahl aufheben). */
  tap(event) {
    const rect = this.canvas.getBoundingClientRect();
    const index = this.renderer.pick(event.clientX - rect.left, event.clientY - rect.top);
    const part = index >= 0 ? this.model.parts[index] : null;
    this.select(part?.group && this.intensityByGroup().has(part.group) ? part.group : null);
  }

  zoomBy(factor, redraw = true) {
    this.view.zoom = Math.min(3.5, Math.max(0.6, this.view.zoom * factor));
    if (redraw) this.requestDraw();
  }

  onKey(event) {
    const step = { ArrowLeft: [-0.2, 0], ArrowRight: [0.2, 0], ArrowUp: [0, 0.1], ArrowDown: [0, -0.1] }[event.key];
    if (step) {
      event.preventDefault();
      this.view.yaw += step[0];
      this.view.pitch = Math.min(0.6, Math.max(-0.45, this.view.pitch + step[1]));
      this.requestDraw();
    } else if (event.key === "+" || event.key === "=") this.zoomBy(1.15);
    else if (event.key === "-") this.zoomBy(1 / 1.15);
  }

  /** Gleitet sanft zu einer Ansicht (z. B. "Hinten"). Dreht immer auf kürzestem Weg. */
  animateTo(target) {
    const from = { ...this.view };
    const to = { ...from, ...target };
    if (target.yaw !== undefined) {
      const turn = ((target.yaw - from.yaw + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
      to.yaw = from.yaw + turn;
    }
    const start = performance.now(), duration = 320;
    this.animating = true;
    const step = (now) => {
      if (!this.animating) return;
      const t = Math.min(1, (now - start) / duration), e = t * t * (3 - 2 * t);
      for (const key of ["yaw", "pitch", "zoom", "panX", "panY"]) this.view[key] = from[key] + (to[key] - from[key]) * e;
      if (t < 1) { this.draw(); requestAnimationFrame(step); }
      else { this.animating = false; this.draw(1); }
    };
    requestAnimationFrame(step);
  }

  // ---------- Auswahl, Legende, Details ----------

  select(group) {
    this.selected = this.selected === group ? null : group;
    this.colors = null;
    this.refreshLegend();
    this.draw(1);
  }

  refreshLegend() {
    const total = this.muscles.reduce((sum, m) => sum + m.reps, 0) || 1;
    const intensity = this.intensityByGroup();
    const rows = [...this.muscles].sort((a, b) => b.reps - a.reps);
    const swatch = (group) => {
      const i = document.createElement("i");
      i.className = "swatch";
      i.style.background = intensity.has(group)
        ? `rgb(${BodyViewer.heatColor(0.12 + 0.88 * intensity.get(group)).map(Math.round).join(",")})` : "#9aa3ad";
      return i;
    };

    this.legend.replaceChildren(...rows.map((m) => {
      const name = m.muscle || "Nicht zugeordnet";
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "legend-entry" + (m.muscle && m.muscle === this.selected ? " active" : "");
      button.setAttribute("aria-pressed", String(m.muscle === this.selected));
      const label = document.createElement("span");
      label.className = "grow";
      label.textContent = name;
      const share = document.createElement("span");
      share.className = "muted";
      share.textContent = `${this.percentFormat.format((m.reps / total) * 100)} %`;
      button.append(swatch(m.muscle), label, share);
      if (m.muscle && intensity.has(m.muscle)) button.addEventListener("click", () => this.select(m.muscle));
      else button.addEventListener("click", () => this.showDetail(m));
      item.append(button);
      return item;
    }));

    const selectedRow = this.muscles.find((m) => m.muscle && m.muscle === this.selected);
    this.showDetail(selectedRow || null);

    // Hinweis für Gruppen, die sich nicht am Körper darstellen lassen
    const hidden = this.muscles.filter((m) => !m.muscle || !BodyViewer.DRAWABLE.includes(m.muscle)).map((m) => m.muscle || "Nicht zugeordnet");
    this.note.textContent = hidden.length
      ? `Nicht am Körper darstellbar (eigene oder nicht zugeordnete Gruppen): ${hidden.join(", ")}.`
      : "";
    this.note.hidden = !hidden.length;
  }

  showDetail(row) {
    if (!row) { this.detail.replaceChildren(); return; }
    const total = this.muscles.reduce((sum, m) => sum + m.reps, 0) || 1;
    const facts = document.createElement("div");
    facts.className = "pie-facts";
    const title = document.createElement("strong");
    title.textContent = row.muscle || "Nicht zugeordnet";
    const list = document.createElement("dl");
    for (const [label, value] of [
      ["Anteil", `${this.percentFormat.format((row.reps / total) * 100)} %`],
      ["Wiederholungen", this.countFormat.format(row.reps)],
      ["Sätze", this.countFormat.format(row.sets)],
      ["Gesamtgewicht", `${this.countFormat.format(row.volume)} kg`],
    ]) {
      const dt = document.createElement("dt"); dt.textContent = label;
      const dd = document.createElement("dd"); dd.textContent = value;
      list.append(dt, dd);
    }
    facts.append(title, list);
    this.detail.replaceChildren(facts);
  }

  /** Aufräumen, wenn die Ansicht verschwindet. */
  destroy() {
    this.observer?.disconnect();
    cancelAnimationFrame(this.frame);
    clearTimeout(this.idleTimer);
    this.animating = false;
  }
}
