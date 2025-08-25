// src/App.js
// ---------------------------------------------
// Minimaler Hafenkran: Container in 3×3-Yard setzen
// Bays: A..C (x-Richtung), Reihen: 1..3 (z-Richtung)
// UI: Slot-Eingabe wie "A1" und Button zum Ausführen
// Keine Tailwind-Abhängigkeit – reines React + three.js
// ---------------------------------------------

import React, { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

// ===== Konstante Maße (alles sauber aufeinander abgestimmt) =====
const BAYS = 3;                 // A..C
const ROWS = 3;                 // 1..3
const LETTERS = ["A", "B", "C"];

const BAY_W = 2.5;              // Abstand pro Bay (X)
const ROW_D = 2.6;              // Abstand pro Reihe (Z)
const TIER_H = 2.3;             // "Etagenhöhe" – Schritt für Stapeln
const CONTAINER_H = TIER_H * 0.9;        // Box ist minimal kleiner als Etagenhöhe
const CONTAINER_HALF_H = CONTAINER_H / 2;

const PLATE_THICKNESS = 0.05;   // Bodengrundplatte (optisch)
const TRAVEL_Y = 5.5;           // Kranfahrt-Höhe (über Yard)
const CRANE_Z = -1.2;           // Kran-Brücke steht vor dem Yard (Z < 0)

// ===== Hilfsfunktionen =====

// "A1" -> { bay: 1..3, row: 1..3 } oder null bei ungültig
function parseSlot(slot) {
  if (!slot || slot.length < 2) return null;
  const bayLetter = slot[0].toUpperCase();
  const rowNum = parseInt(slot.slice(1), 10);
  const bayIdx = LETTERS.indexOf(bayLetter);
  if (bayIdx === -1 || isNaN(rowNum)) return null;
  const bay = bayIdx + 1;
  const row = rowNum;
  if (bay < 1 || bay > BAYS || row < 1 || row > ROWS) return null;
  return { bay, row };
}

// Weltkoordinate der ZELLENMITTE für eine (bay,row) + TIER
// WICHTIG: Y ist ein Zentrum! Für "auf dem Boden stehen" addieren wir
//          PLATE_THICKNESS + CONTAINER_HALF_H (siehe slotCenterAtTier unten).
function cellOrigin(bay, row) {
  const x = (bay - 1) * BAY_W;
  const z = (row - 1) * ROW_D;
  return new THREE.Vector3(x, 0, z);
}

// Zentrum einer Box, wenn sie auf TIER (1=unten) steht
function slotCenterAtTier(bay, row, tier = 1) {
  const p = cellOrigin(bay, row);
  // Bodenoberseite ist bei y = PLATE_THICKNESS
  // Box-Zentrum = Boden + halbe Boxhöhe + (tier-1)*TIER_H
  p.y = PLATE_THICKNESS + CONTAINER_HALF_H + (tier - 1) * TIER_H;
  return p;
}

// simple Easing
function easeInOut(t) {
  return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
}

// ===== Hauptkomponente =====
export default function App() {
  const mountRef = useRef(null);

  // Referenzen auf 3D-Objekte / Utilities
  const three = useRef({ scene: null, camera: null, renderer: null, controls: null, anims: [] });
  const craneRef = useRef({ bridge: null, hook: null });
  const containerRef = useRef(null);

  const [slot, setSlot] = useState("A1");  // Zielslot
  const [busy, setBusy] = useState(false); // Blockiert Animationen

  useEffect(() => {
    const el = mountRef.current;

    // --- Szene, Kamera, Renderer
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf6f8fa);

    const camera = new THREE.PerspectiveCamera(55, el.clientWidth / el.clientHeight, 0.1, 1000);
    camera.position.set(-8, 14, 18);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(el.clientWidth, el.clientHeight);
    el.appendChild(renderer.domElement);

    // Maussteuerung
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;

    // --- Licht
    scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 0.9));
    const dir = new THREE.DirectionalLight(0xffffff, 0.8);
    dir.position.set(20, 30, 10);
    scene.add(dir);

    // --- Grid + Bodenplatte
    const grid = new THREE.GridHelper(30, 30, 0x888888, 0xdddddd);
    // leicht verschoben, damit Yard auf dem Grid "sitzt"
    const baseCell = cellOrigin(1, 1);
    grid.position.set(baseCell.x + BAY_W, 0, baseCell.z + ROW_D);
    scene.add(grid);

    const totalW = BAYS * BAY_W;
    const totalD = ROWS * ROW_D;

    // Bodenplatte (dünner Klotz, damit wir eine klare "Oberkante" haben)
    const plate = new THREE.Mesh(
      new THREE.BoxGeometry(totalW, PLATE_THICKNESS, totalD),
      new THREE.MeshBasicMaterial({ color: 0xeeeeee, transparent: true, opacity: 0.85 })
    );
    // Mittelpunkt der Platte = halbe Dicke; wir zentrieren die Platte unter dem Yard
    plate.position.set(
      baseCell.x + totalW / 2 - BAY_W / 2,
      PLATE_THICKNESS / 2,
      baseCell.z + totalD / 2 - ROW_D / 2
    );
    scene.add(plate);

    // --- Zell-Linien (optische Rasterung)
    drawCellLines(scene);

    // --- Beschriftungen (Bays A..C, Reihen 1..3)
    for (let b = 1; b <= BAYS; b++) {
      const s = makeLabelSprite(LETTERS[b - 1]);
      const p = cellOrigin(b, 1);
      s.position.set(p.x, PLATE_THICKNESS + 0.12, p.z - ROW_D / 2 - 0.9);
      scene.add(s);
    }
    for (let r = 1; r <= ROWS; r++) {
      const s = makeLabelSprite(String(r));
      const p = cellOrigin(1, r);
      s.position.set(p.x - BAY_W / 2 - 0.9, PLATE_THICKNESS + 0.12, p.z);
      scene.add(s);
    }

    // --- Kran (Brücke + "Haken")
    const bridge = new THREE.Mesh(
      new THREE.BoxGeometry(totalW + 1.2, 0.15, 0.2),
      new THREE.MeshStandardMaterial({ color: 0x4682b4, metalness: 0.2, roughness: 0.5 })
    );
    bridge.position.set(plate.position.x, TRAVEL_Y + 0.0, CRANE_Z);
    scene.add(bridge);

    const hook = new THREE.Mesh(
      new THREE.CylinderGeometry(0.05, 0.05, 0.6, 16),
      new THREE.MeshStandardMaterial({ color: 0x333333 })
    );
    hook.rotation.z = Math.PI / 2;
    hook.position.set(bridge.position.x - totalW / 2, TRAVEL_Y - 0.5, CRANE_Z);
    scene.add(hook);

    craneRef.current = { bridge, hook };

    // --- Ein Container wartet am "Gate" links von A1
    const cont = buildContainerMesh(1); // 20'-Box
    cont.position.set(-6, CONTAINER_HALF_H, 0); // exakt auf "Bodenhöhe" zentriert
    scene.add(cont);
    containerRef.current = cont;

    // --- Render-Loop
    const onResize = () => {
      renderer.setSize(el.clientWidth, el.clientHeight);
      camera.aspect = el.clientWidth / el.clientHeight;
      camera.updateProjectionMatrix();
    };
    window.addEventListener("resize", onResize);

    let raf;
    const loop = (t) => {
      controls.update();
      three.current.anims = three.current.anims.filter((a) => !a.done);
      three.current.anims.forEach((a) => a.step(t));
      renderer.render(scene, camera);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    three.current = { scene, camera, renderer, controls, anims: [] };

    // Aufräumen
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      el.removeChild(renderer.domElement);
    };
  }, []);

  // ===== UI-Handler: Container zum Slot bewegen =====
  function placeAtSlot() {
    if (busy) return;
    const target = parseSlot(slot);
    if (!target) {
      alert("Bitte Slot im Format A1..C3 eingeben (z. B. A1)");
      return;
    }

    setBusy(true);

    const cont = containerRef.current;
    const { bridge, hook } = craneRef.current;

    // 1) Anhebepunkt über der Startposition (Gate)
    const pickTop = cont.position.clone();
    pickTop.y = TRAVEL_Y;

    // 2) Fahr-Position direkt ÜBER dem Zielslot
    const dropTop = slotCenterAtTier(target.bay, target.row, 1).clone();
    dropTop.y = TRAVEL_Y;

    // 3) Exakte Ablageposition (ZENTRUM der Box auf Bodenniveau)
    const dropDown = slotCenterAtTier(target.bay, target.row, 1).clone();

    // 4) Haken-Ruhelage knapp über der Box nach dem Absetzen
    const hookRest = dropDown.clone();
    hookRest.y = dropDown.y + CONTAINER_HALF_H + 0.2;
    hookRest.z = CRANE_Z; // Haken bleibt auf Kran-Z

    // --- Animationssequenz ---
    // Brücke fährt X-seitig in Position über dem Ziel
    animateTo(bridge, new THREE.Vector3(dropTop.x, TRAVEL_Y, CRANE_Z), 800);

    // Haken anheben -> Container anheben -> zum Ziel fahren -> absenken
    animateTo(hook, pickTop, 600, () => {
      animateTo(cont, pickTop, 600, () => {
        animateTo(hook, dropTop.clone().setZ(CRANE_Z), 900);
        animateTo(cont, dropTop, 900, () => {
          animateTo(hook, hookRest, 600);
          animateTo(cont, dropDown, 600, () => {
            setBusy(false);
          });
        });
      });
    });
  }

  // ===== three.js: Mesh & Zeichen-Helfer =====
  function buildContainerMesh(sizeTEU = 1) {
    const length = sizeTEU === 2 ? BAY_W * 2 : BAY_W;
    const geom = new THREE.BoxGeometry(length * 0.95, CONTAINER_H, BAY_W * 0.95);
    const mat = new THREE.MeshStandardMaterial({
      color: 0xd7bde2,
      roughness: 0.6,
      metalness: 0.1,
    });
    return new THREE.Mesh(geom, mat);
  }

  function makeLabelSprite(text) {
    // Beschriftung per Canvas -> als Sprite in die Szene
    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 128;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "rgba(255,255,255,0.95)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#111";
    ctx.font = "36px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, canvas.width / 2, canvas.height / 2);
    const tex = new THREE.CanvasTexture(canvas);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex }));
    sprite.scale.set(1.2, 0.5, 1);
    return sprite;
  }

  function drawCellLines(scene) {
    // Dünne Linien für die 3×3 Zellen
    const mat = new THREE.LineBasicMaterial({ color: 0xaaaaaa });
    const group = new THREE.Group();
    const origin = cellOrigin(1, 1);

    // Vertikale Linien (entlang Z), 4 Stück (0..3)
    for (let b = 0; b <= BAYS; b++) {
      const x = origin.x + b * BAY_W - BAY_W / 2;
      const geo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(x, PLATE_THICKNESS + 0.03, origin.z - ROW_D / 2),
        new THREE.Vector3(x, PLATE_THICKNESS + 0.03, origin.z + ROWS * ROW_D - ROW_D / 2),
      ]);
      group.add(new THREE.Line(geo, mat));
    }

    // Horizontale Linien (entlang X), 4 Stück (0..3)
    for (let r = 0; r <= ROWS; r++) {
      const z = origin.z + r * ROW_D - ROW_D / 2;
      const geo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(origin.x - BAY_W / 2, PLATE_THICKNESS + 0.03, z),
        new THREE.Vector3(origin.x + BAYS * BAY_W - BAY_W / 2, PLATE_THICKNESS + 0.03, z),
      ]);
      group.add(new THREE.Line(geo, mat));
    }
    scene.add(group);
  }

  // Generischer Tweener für Positionen
  function animateTo(obj, target, ms = 1000, onDone) {
    const start = obj.position.clone();
    const t0 = performance.now();
    const runner = {
      done: false,
      step: (t) => {
        const p = Math.min(1, (t - t0) / ms);
        const e = easeInOut(p);
        obj.position.lerpVectors(start, target, e);
        if (p >= 1) {
          runner.done = true;
          onDone && onDone();
        }
      },
    };
    three.current.anims.push(runner);
  }

  // ===== UI =====
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1fr 320px",
        gap: 16,
        height: "100vh",
        padding: 16,
        boxSizing: "border-box",
      }}
    >
      {/* 3D-Canvas */}
      <div
        ref={mountRef}
        style={{
          width: "100%",
          height: "100%",
          background: "#fff",
          borderRadius: 12,
          boxShadow: "0 2px 8px rgba(0,0,0,0.07)",
        }}
      />

      {/* Sidebar */}
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <h2 style={{ margin: 0 }}>Hafenkran · Mini-Yard (A–C × 1–3)</h2>

        <label style={{ fontSize: 14 }}>
          Zielslot (z. B. <b>A1</b>):{" "}
          <input
            value={slot}
            onChange={(e) => setSlot(e.target.value)}
            maxLength={2}
            style={{ width: 60, padding: "6px 8px", marginLeft: 8 }}
          />
        </label>

        <button
          onClick={placeAtSlot}
          disabled={busy}
          style={{
            padding: "8px 12px",
            border: "1px solid #ddd",
            borderRadius: 8,
            background: busy ? "#eee" : "#f7f7f7",
            cursor: busy ? "not-allowed" : "pointer",
          }}
        >
          {busy ? "Kran arbeitet…" : "Container zum Slot bewegen"}
        </button>

        <div style={{ fontSize: 13, color: "#555", lineHeight: 1.5 }}>
          • Bays: <b>A–C</b>, Reihen: <b>1–3</b> (insgesamt 3×3 Zellen).<br />
          • Kamera: Linke Maus – Orbit, Mausrad – Zoom, Rechte Maus – Pan.<br />
          • Die Box wird sauber auf die Bodenplatte gesetzt (keine „Versenkung“).
        </div>
      </div>
    </div>
  );
}
