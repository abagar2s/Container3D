// src/App.js
// ---------------------------------------------
// Mini Yard Crane: multi containers + occupancy + 2 tiers + Entstapeln
// Ground: procedural asphalt covering the whole grid with per-cell stall lines.
// 40' spans same letter + next row (A1+A2, B2+B3, etc.).
// Tier rules: prefer Tier 1; Tier 2 only with support (20' needs 1 cell below; 40' needs both).
// Entstapeln: only if nothing sits above any of its cells.
// Pure React + three.js
// ---------------------------------------------

import React, { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

// ===== Yard Constants =====
const BAYS = 3;
const ROWS = 3;
const LETTERS = ["A", "B", "C"];

const BAY_W = 2.5;          // X spacing per bay (letter)
const ROW_D = 2.6;          // Z spacing per row (number)
const TIER_H = 2.3;         // tier step height
const CONTAINER_H = TIER_H * 0.9;
const CONTAINER_HALF_H = CONTAINER_H / 2;

const PLATE_THICKNESS = 0.05;
const TRAVEL_Y = 5.5;       // crane travel height
const CRANE_Z = -1.2;       // crane bridge Z in front of yard
const MAX_TIERS = 2;

// Gate spawn baseline (left of A1)
const GATE_START = new THREE.Vector3(-6, CONTAINER_HALF_H, 0);
const GATE_SPACING = 1.1;

// ===== Procedural Asphalt + Full-Grid Stall Markings =====
function makeAsphaltTextureWithStalls({
  widthM,        // total yard width (m)
  heightM,       // total yard depth (m)
  bays, rows,    // grid dims (BAYS x ROWS)
  bayWidthM, rowDepthM, // cell size (m)
  pxPerM = 80,   // resolution
  dashedCenter = false,
  stallColor = "#ffffff",
}) {
  const W = Math.max(512, Math.floor(widthM * pxPerM));
  const H = Math.max(512, Math.floor(heightM * pxPerM));
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const g = c.getContext("2d");

  // Base asphalt
  g.fillStyle = "#2a2a2a";
  g.fillRect(0, 0, W, H);

  // Speckle noise
  const speckles = Math.floor((W * H) / 250);
  for (let i = 0; i < speckles; i++) {
    const x = (Math.random() * W) | 0;
    const y = (Math.random() * H) | 0;
    const grey = (160 + Math.random() * 80) | 0; // 160..240
    g.fillStyle = `rgba(${grey},${grey},${grey},${Math.random() * 0.15})`;
    g.fillRect(x, y, 1, 1);
  }

  // Subtle darker blotches
  g.globalAlpha = 0.07;
  for (let i = 0; i < 40; i++) {
    const r = Math.random() * (Math.min(W, H) * 0.25);
    g.beginPath();
    g.ellipse(Math.random()*W, Math.random()*H, r, r*0.6, 0, 0, Math.PI*2);
    g.fillStyle = "#000";
    g.fill();
  }
  g.globalAlpha = 1;

  // Optional center dashed line along Z
  if (dashedCenter) {
    const lineW = Math.max(2, Math.floor(W * 0.01));
    const dashLen = Math.max(16, Math.floor(H * 0.05));
    const gap = Math.floor(dashLen * 0.8);
    const x = Math.floor(W / 2 - lineW / 2);
    g.fillStyle = "#ffd34d";
    for (let y = 0; y < H; y += dashLen + gap) g.fillRect(x, y, lineW, dashLen);
  }

  // Full-grid stall lines for each cell
  const cellW = bayWidthM * pxPerM;
  const cellH = rowDepthM * pxPerM;

  g.strokeStyle = stallColor;
  g.lineJoin = "miter";
  g.lineCap = "butt";

  // Slightly thicker border around entire yard
  g.lineWidth = Math.max(2, Math.floor(0.012 * Math.max(cellW, cellH)));
  g.strokeRect(0.5, 0.5, W - 1, H - 1);

  // Inner grid lines (verticals between bays, horizontals between rows)
  g.lineWidth = Math.max(1.5, Math.floor(0.009 * Math.max(cellW, cellH)));

  // Vertical separators (between bays)
  for (let b = 1; b < bays; b++) {
    const x = Math.round(b * cellW) + 0.5;
    g.beginPath();
    g.moveTo(x, 0);
    g.lineTo(x, H);
    g.stroke();
  }

  // Horizontal separators (between rows)
  for (let r = 1; r < rows; r++) {
    const y = Math.round(r * cellH) + 0.5;
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(W, y);
    g.stroke();
  }

  // Optional: small tick marks at each cell center (off by default)
  // for (let by = 0; by < bays; by++) {
  //   for (let ry = 0; ry < rows; ry++) {
  //     const cx = Math.round(by * cellW + cellW / 2);
  //     const cy = Math.round(ry * cellH + cellH / 2);
  //     g.lineWidth = 1;
  //     g.beginPath();
  //     g.moveTo(cx - 6, cy);
  //     g.lineTo(cx + 6, cy);
  //     g.moveTo(cx, cy - 6);
  //     g.lineTo(cx, cy + 6);
  //     g.stroke();
  //   }
  // }

  const map = new THREE.CanvasTexture(c);
  map.wrapS = THREE.ClampToEdgeWrapping;
  map.wrapT = THREE.ClampToEdgeWrapping;
  map.needsUpdate = true;

  // Bump from same canvas (subtle)
  const bumpCanvas = document.createElement("canvas");
  bumpCanvas.width = W; bumpCanvas.height = H;
  const gb = bumpCanvas.getContext("2d");
  gb.drawImage(c, 0, 0);
  const bumpMap = new THREE.CanvasTexture(bumpCanvas);
  bumpMap.wrapS = THREE.ClampToEdgeWrapping;
  bumpMap.wrapT = THREE.ClampToEdgeWrapping;
  bumpMap.needsUpdate = true;

  return { map, bumpMap };
}

// ===== Basics =====
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
function cellOrigin(bay, row) {
  const x = (bay - 1) * BAY_W;
  const z = (row - 1) * ROW_D;
  return new THREE.Vector3(x, 0, z);
}
function slotCenterAtTier(bay, row, tier = 1) {
  const p = cellOrigin(bay, row);
  p.y = PLATE_THICKNESS + CONTAINER_HALF_H + (tier - 1) * TIER_H;
  return p;
}
function easeInOut(t) {
  return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
}

// ===== Component =====
export default function App() {
  const mountRef = useRef(null);

  const three = useRef({ scene: null, camera: null, renderer: null, controls: null, anims: [] });
  const craneRef = useRef({ bridge: null, hook: null });

  // containers: [{id, name, mesh, sizeTEU, color, cells: [{bay,row,tier}, ...] }]
  const [containers, setContainers] = useState([]);
  const containersRef = useRef([]);

  // occupancy: "bay-row-tier" -> containerId
  const [occ, setOcc] = useState({});
  const occRef = useRef({});

  const [selectedId, setSelectedId] = useState(null);
  const [slot, setSlot] = useState("A1");
  const [busy, setBusy] = useState(false);

  const [newSize, setNewSize] = useState(1);
  const [newColor, setNewColor] = useState("#d7bde2");

  const gateIndexRef = useRef(0);

  useEffect(() => {
    const el = mountRef.current;

    // Scene / Camera / Renderer
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf3f4f6);

    const camera = new THREE.PerspectiveCamera(55, el.clientWidth / el.clientHeight, 0.1, 1000);
    camera.position.set(-8, 14, 18);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(el.clientWidth, el.clientHeight);
    el.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;

    // Lights
    scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 0.9));
    const dir = new THREE.DirectionalLight(0xffffff, 0.9);
    dir.position.set(20, 30, 10);
    scene.add(dir);

    // Subtle grid under asphalt (very faint)
    const grid = new THREE.GridHelper(30, 30, 0x666666, 0x999999);
    grid.material.transparent = true;
    grid.material.opacity = 0.08;
    const baseCell = cellOrigin(1, 1);
    grid.position.set(baseCell.x + BAY_W, 0, baseCell.z + ROW_D);
    scene.add(grid);

    const totalW = BAYS * BAY_W;
    const totalD = ROWS * ROW_D;

    // Ground plate
    const plate = new THREE.Mesh(
      new THREE.BoxGeometry(totalW, PLATE_THICKNESS, totalD),
      new THREE.MeshStandardMaterial({ color: 0xeeeeee })
    );
    plate.position.set(
      baseCell.x + totalW / 2 - BAY_W / 2,
      PLATE_THICKNESS / 2,
      baseCell.z + totalD / 2 - ROW_D / 2
    );
    scene.add(plate);

    // Asphalt mapped to the whole yard with full-grid stall lines
    const { map: asphaltMap, bumpMap } = makeAsphaltTextureWithStalls({
      widthM: totalW,
      heightM: totalD,
      bays: BAYS,
      rows: ROWS,
      bayWidthM: BAY_W,
      rowDepthM: ROW_D,
      pxPerM: 96,            // higher = crisper lines
      dashedCenter: false,   // set true to add a center road dashed line
      stallColor: "#ffffff", // grid line color
    });
    plate.material = new THREE.MeshStandardMaterial({
      map: asphaltMap,
      bumpMap,
      bumpScale: 0.015,
      roughness: 0.96,
      metalness: 0.0,
    });

    // Labels
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

    // Crane
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

    // Loop
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

    // Initial container at gate
    const first = addContainerToScene(scene, { sizeTEU: 1, color: "#d7bde2" }, gateIndexRef.current++);
    containersRef.current = [first];
    setContainers([dehydrate(first)]);
    setSelectedId(first.id);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      el.removeChild(renderer.domElement);
    };
  }, []);

  // ===== Helpers (scene/UI) =====
  function buildContainerMesh(sizeTEU = 1, color = "#d7bde2") {
    // 40' spans along Z (rows), not X.
    const widthX = BAY_W * 0.95;
    const depthZ = (sizeTEU === 2 ? ROW_D * 2 : ROW_D) * 0.95;
    const geom = new THREE.BoxGeometry(widthX, CONTAINER_H, depthZ);
    const mat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(color),
      roughness: 0.6,
      metalness: 0.1,
    });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.userData.sizeTEU = sizeTEU;
    mesh.userData.color = color;
    return mesh;
  }

  function makeLabelSprite(text) {
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

  function gatePositionForIndex(idx) {
    const offsetX = -idx * (BAY_W * GATE_SPACING + 0.2);
    return GATE_START.clone().add(new THREE.Vector3(offsetX, 0, 0));
  }

  function addContainerToScene(scene, { sizeTEU, color }, indexForQueue) {
    const mesh = buildContainerMesh(sizeTEU, color);
    mesh.position.copy(gatePositionForIndex(indexForQueue));
    scene.add(mesh);

    const id = `C${Math.random().toString(36).slice(2, 8)}`;
    const name = `${sizeTEU === 2 ? "40’" : "20’"} • ${id.toUpperCase()}`;
    return { id, name, sizeTEU, color, mesh, cells: [] };
  }

  function dehydrate(item) {
    return { id: item.id, name: item.name, sizeTEU: item.sizeTEU, color: item.color };
  }

  function handleAddContainer() {
    if (!three.current.scene) return;
    const scene = three.current.scene;
    const added = addContainerToScene(scene, { sizeTEU: Number(newSize), color: newColor }, gateIndexRef.current++);
    containersRef.current = [...containersRef.current, added];
    setContainers((prev) => [...prev, dehydrate(added)]);
    setSelectedId(added.id);
  }

  // ===== Occupancy + tiers =====
  const k = (bay, row, tier) => `${bay}-${row}-${tier}`;

  function cellsForSizeAt(sizeTEU, bay, row, tier) {
    if (sizeTEU === 1) return [{ bay, row, tier }];
    if (row >= ROWS) return null; // needs row+1
    return [{ bay, row, tier }, { bay, row: row + 1, tier }];
  }
  function isFreeFor(containerId, cells) {
    for (const c of cells) {
      const occBy = occRef.current[k(c.bay, c.row, c.tier)];
      if (occBy && occBy !== containerId) return false;
    }
    return true;
  }
  function hasSupportBelow(sizeTEU, bay, row) {
    if (sizeTEU === 1) return !!occRef.current[k(bay, row, 1)];
    if (row >= ROWS) return false;
    const id1 = occRef.current[k(bay, row, 1)];
    const id2 = occRef.current[k(bay, row + 1, 1)];
    return !!(id1 && id2);
  }
  function chooseTier(containerId, sizeTEU, bay, row) {
    const c1 = cellsForSizeAt(sizeTEU, bay, row, 1);
    if (c1 && isFreeFor(containerId, c1)) return { ok: true, tier: 1, cells: c1 };
    const c2 = cellsForSizeAt(sizeTEU, bay, row, 2);
    if (!c2) return { ok: false, reason: "Kein Platz (Rand) für 40’." };
    if (!isFreeFor(containerId, c2)) return { ok: false, reason: "Ziel auf Ebene 2 ist bereits belegt." };
    if (!hasSupportBelow(sizeTEU, bay, row)) {
      return {
        ok: false,
        reason: sizeTEU === 1
          ? "Für 20’ auf Ebene 2 fehlt die Stütze darunter."
          : "Für 40’ auf Ebene 2 müssen beide Zellen darunter belegt sein (ein 40’ oder zwei 20’).",
      };
    }
    return { ok: true, tier: 2, cells: c2 };
  }
  function occupy(containerId, newCells, prevCells = []) {
    const copy = { ...occRef.current };
    for (const c of prevCells) {
      const kk = k(c.bay, c.row, c.tier);
      if (copy[kk] === containerId) delete copy[kk];
    }
    for (const c of newCells) copy[k(c.bay, c.row, c.tier)] = containerId;
    occRef.current = copy;
    setOcc(copy);
  }

  // ===== Entstapeln =====
  function canRemove(entry) {
    const blockers = new Set();
    for (const c of entry.cells || []) {
      if (c.tier >= MAX_TIERS) continue;
      const aboveId = occRef.current[k(c.bay, c.row, c.tier + 1)];
      if (aboveId && aboveId !== entry.id) blockers.add(aboveId);
    }
    return { ok: blockers.size === 0, blockers: Array.from(blockers) };
  }

  // ===== Actions =====
  function placeAtSlot() {
    if (busy) return;
    const target = parseSlot(slot);
    if (!target) return alert("Bitte Slot im Format A1..C3 eingeben (z. B. A1).");
    if (!selectedId) return alert("Bitte zuerst einen Container auswählen oder hinzufügen.");

    const entry = containersRef.current.find((c) => c.id === selectedId);
    if (!entry) return alert("Ausgewählter Container nicht gefunden.");

    const decision = chooseTier(entry.id, entry.sizeTEU, target.bay, target.row);
    if (!decision.ok) return alert(decision.reason || "Platzierung nicht möglich.");

    const tier = decision.tier;
    const cells = decision.cells;
    setBusy(true);

    const cont = entry.mesh;
    const { bridge, hook } = craneRef.current;
    const topY = TRAVEL_Y;

    const topOver = slotCenterAtTier(target.bay, target.row, 1).clone();
    topOver.y = topY;

    let dropCenter = slotCenterAtTier(target.bay, target.row, tier).clone();
    if (entry.sizeTEU === 2) {
      const nextCenter = slotCenterAtTier(target.bay, target.row + 1, tier).clone();
      dropCenter = dropCenter.lerp(nextCenter, 0.5);
    }

    const pickTop = cont.position.clone(); pickTop.y = topY;
    const hookRest = dropCenter.clone(); hookRest.y = dropCenter.y + CONTAINER_HALF_H + 0.2; hookRest.z = CRANE_Z;

    animateTo(bridge, new THREE.Vector3(topOver.x, topY, CRANE_Z), 800);
    animateTo(hook, pickTop, 600, () => {
      animateTo(cont, pickTop, 600, () => {
        const topOverZ = entry.sizeTEU === 1 ? topOver.z : dropCenter.z;
        animateTo(hook, new THREE.Vector3(topOver.x, topOver.y, CRANE_Z), 300);
        animateTo(cont, new THREE.Vector3(topOver.x, topOver.y, topOverZ), 900, () => {
          animateTo(hook, hookRest, 600);
          animateTo(cont, dropCenter, 600, () => {
            occupy(entry.id, cells, entry.cells);
            entry.cells = cells;
            setBusy(false);
          });
        });
      });
    });
  }

  function removeSelected() {
    if (busy) return;
    if (!selectedId) return alert("Bitte zuerst einen Container auswählen.");
    const entry = containersRef.current.find((c) => c.id === selectedId);
    if (!entry) return alert("Ausgewählter Container nicht gefunden.");
    if (!entry.cells || entry.cells.length === 0) return alert("Dieser Container steht bereits am Gate (nicht im Yard).");

    const { ok, blockers } = canRemove(entry);
    if (!ok) {
      const names = blockers.map((bid) => containersRef.current.find((x) => x.id === bid)?.name || bid).join(", ");
      return alert("Entstapeln nicht möglich. Zuerst entfernen: " + names);
    }

    setBusy(true);

    const cont = entry.mesh;
    const { bridge, hook } = craneRef.current;
    const topY = TRAVEL_Y;

    let currentCenter = null;
    if (entry.cells.length === 1) {
      const c = entry.cells[0];
      currentCenter = slotCenterAtTier(c.bay, c.row, c.tier);
    } else {
      const c1 = entry.cells[0], c2 = entry.cells[1];
      currentCenter = slotCenterAtTier(c1.bay, c1.row, c1.tier).lerp(
        slotCenterAtTier(c2.bay, c2.row, c2.tier), 0.5
      );
    }
    const liftTop = currentCenter.clone(); liftTop.y = topY;

    const parkIndex = gateIndexRef.current++;
    const parkPos = gatePositionForIndex(parkIndex).clone();

    const hookRest = liftTop.clone(); hookRest.z = CRANE_Z;

    animateTo(bridge, new THREE.Vector3(liftTop.x, topY, CRANE_Z), 600);
    animateTo(hook, liftTop, 500, () => {
      animateTo(cont, liftTop, 500, () => {
        const flyTop = new THREE.Vector3(parkPos.x, topY, parkPos.z);
        animateTo(hook, new THREE.Vector3(liftTop.x, topY, CRANE_Z), 300);
        animateTo(cont, flyTop, 900, () => {
          const finalPos = parkPos.clone();
          animateTo(hook, new THREE.Vector3(flyTop.x, flyTop.y, CRANE_Z), 300);
          animateTo(cont, finalPos, 600, () => {
            occupy(entry.id, [], entry.cells);
            entry.cells = [];
            setBusy(false);
          });
        });
      });
    });
  }

  // ===== UI =====
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1fr 420px",
        gap: 16,
        height: "100vh",
        padding: 16,
        boxSizing: "border-box",
      }}
    >
      {/* 3D canvas */}
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
        <h2 style={{ margin: 0 }}>Hafenkran · Mini-Yard (A–C × 1–3) · 2 Ebenen</h2>

        {/* Add container */}
        <div
          style={{
            padding: 12,
            border: "1px solid #e5e5e5",
            borderRadius: 10,
            background: "#fafafa",
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 8,
          }}
        >
          <label style={{ fontSize: 13 }}>
            Größe:
            <select
              value={newSize}
              onChange={(e) => setNewSize(Number(e.target.value))}
              style={{ marginLeft: 8, padding: "6px 8px" }}
            >
              <option value={1}>20’ (1 TEU)</option>
              <option value={2}>40’ (2 TEU)</option>
            </select>
          </label>

          <label style={{ fontSize: 13 }}>
            Farbe:
            <input
              type="color"
              value={newColor}
              onChange={(e) => setNewColor(e.target.value)}
              style={{ marginLeft: 8, padding: 0, width: 44, height: 28, verticalAlign: "middle" }}
            />
          </label>

          <button
            onClick={handleAddContainer}
            style={{
              gridColumn: "1 / span 2",
              padding: "8px 12px",
              border: "1px solid #ddd",
              borderRadius: 8,
              background: "#f7f7f7",
              cursor: "pointer",
            }}
          >
            Neuen Container hinzufügen
          </button>
          <div style={{ gridColumn: "1 / span 2", fontSize: 12, color: "#666" }}>
            40’ belegt zwei Slots gleicher Buchstabe + nächste Zahl (z. B. A1+A2).
          </div>
        </div>

        {/* Select active container */}
        <label style={{ fontSize: 14 }}>
          Aktiver Container:{" "}
          <select
            value={selectedId || ""}
            onChange={(e) => setSelectedId(e.target.value)}
            style={{ marginLeft: 8, padding: "6px 8px", minWidth: 260 }}
          >
            {containers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>

        {/* Move / Remove */}
        <label style={{ fontSize: 14 }}>
          Zielslot (z. B. <b>A1</b>):{" "}
          <input
            value={slot}
            onChange={(e) => setSlot(e.target.value)}
            maxLength={2}
            style={{ width: 60, padding: "6px 8px", marginLeft: 8 }}
          />
        </label>

        <div style={{ display: "flex", gap: 8 }}>
          <button
            onClick={placeAtSlot}
            disabled={busy || !selectedId}
            style={{
              flex: 1,
              padding: "8px 12px",
              border: "1px solid #ddd",
              borderRadius: 8,
              background: busy ? "#eee" : "#f7f7f7",
              cursor: busy ? "not-allowed" : "pointer",
            }}
          >
            {busy ? "Kran arbeitet…" : "Zum Slot bewegen"}
          </button>

          <button
            onClick={removeSelected}
            disabled={busy || !selectedId}
            style={{
              flex: 1,
              padding: "8px 12px",
              border: "1px solid #ddd",
              borderRadius: 8,
              background: busy ? "#eee" : "#fff4f4",
              cursor: busy ? "not-allowed" : "pointer",
            }}
            title="Entstapeln: Container zurück zum Gate bringen"
          >
            {busy ? "…" : "Entstapeln (entfernen)"}
          </button>
        </div>

        <div style={{ fontSize: 13, color: "#555", lineHeight: 1.5 }}>
          • Boden: gesamte 3×3-Fläche als Asphalt mit weißen Stall-Linien pro Zelle.<br />
          • Tier 1 zuerst; Tier 2 nur mit Stützregeln.<br />
          • 40’: A1+A2, B2+B3, etc. (gleicher Buchstabe, +1 Reihe).<br />
          • Entstapeln: nur wenn nichts darüber steht.
        </div>
      </div>
    </div>
  );
}
