// src/App.js
// ---------------------------------------------
// Mini Yard Crane (production-tuned)
// - Multi containers (20’ / 40’), colors
// - 2 tiers (stacking) with support rules
// - Entstapeln (remove only if nothing above)
// - Full-grid procedural asphalt (no image files), sRGB, anisotropy
// - Hi-DPI renderer, ACES tone mapping
// - Reused geometries, promise-based cancelable tweens
// - Raycast click-to-select, target cell highlights, occupancy HUD
// ---------------------------------------------

import React, { useEffect, useRef, useState, useMemo } from "react";
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

// ===== Helpers (math/yard) =====
const k = (bay, row, tier) => `${bay}-${row}-${tier}`;

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
function lerpEase(p) {
  return p < 0.5 ? 2 * p * p : -1 + (4 - 2 * p) * p;
}

// ===== Procedural Asphalt (full-grid stalls) =====
function makeAsphaltTextureWithStalls({
  widthM, heightM,
  bays, rows,
  bayWidthM, rowDepthM,
  pxPerM = 96,
  dashedCenter = false,
  stallColor = "#ffffff",
}) {
  const W = Math.max(512, Math.floor(widthM * pxPerM));
  const H = Math.max(512, Math.floor(heightM * pxPerM));
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const g = c.getContext("2d");

  // base asphalt
  g.fillStyle = "#55585d";
  g.fillRect(0, 0, W, H);

  // speckles
  const speckles = Math.floor((W * H) / 250);
  for (let i = 0; i < speckles; i++) {
    const x = (Math.random() * W) | 0;
    const y = (Math.random() * H) | 0;
    const grey = (160 + Math.random() * 80) | 0; // 160..240
    g.fillStyle = `rgba(${grey},${grey},${grey},${Math.random() * 0.15})`;
    g.fillRect(x, y, 1, 1);
  }

  // blotches
  g.globalAlpha = 0.07;
  for (let i = 0; i < 40; i++) {
    const r = Math.random() * (Math.min(W, H) * 0.25);
    g.beginPath();
    g.ellipse(Math.random() * W, Math.random() * H, r, r * 0.6, 0, 0, Math.PI * 2);
    g.fillStyle = "#000";
    g.fill();
  }
  g.globalAlpha = 1;

  // optional road center
  if (dashedCenter) {
    const lineW = Math.max(2, Math.floor(W * 0.01));
    const dashLen = Math.max(16, Math.floor(H * 0.05));
    const gap = Math.floor(dashLen * 0.8);
    const x = Math.floor(W / 2 - lineW / 2);
    g.fillStyle = "#ffd34d";
    for (let y = 0; y < H; y += dashLen + gap) g.fillRect(x, y, lineW, dashLen);
  }

  // stall grid
  const cellW = bayWidthM * pxPerM;
  const cellH = rowDepthM * pxPerM;
  g.strokeStyle = stallColor;
  g.lineJoin = "miter";
  g.lineCap = "butt";

  // border
  g.lineWidth = Math.max(2, Math.floor(0.012 * Math.max(cellW, cellH)));
  g.strokeRect(0.5, 0.5, W - 1, H - 1);

  // inner lines
  g.lineWidth = Math.max(1.5, Math.floor(0.009 * Math.max(cellW, cellH)));
  for (let b = 1; b < bays; b++) {
    const x = Math.round(b * cellW) + 0.5;
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke();
  }
  for (let r = 1; r < rows; r++) {
    const y = Math.round(r * cellH) + 0.5;
    g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke();
  }

  const map = new THREE.CanvasTexture(c);
  map.colorSpace = THREE.SRGBColorSpace;
  map.wrapS = THREE.ClampToEdgeWrapping;
  map.wrapT = THREE.ClampToEdgeWrapping;
  map.needsUpdate = true;

  // light bump from same canvas
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

// ===== Geometry cache (reused) =====
const GEO20 = new THREE.BoxGeometry(BAY_W * 0.95, CONTAINER_H, ROW_D * 0.95);
const GEO40 = new THREE.BoxGeometry(BAY_W * 0.95, CONTAINER_H, ROW_D * 2 * 0.95);

// ===== React Component =====
export default function App() {
  const mountRef = useRef(null);

  // three handles
  const three = useRef({ scene: null, camera: null, renderer: null, controls: null, anims: [] });
  const craneRef = useRef({ bridge: null, hook: null });
  const highlightRef = useRef({ group: null, planes: [] }); // cell highlights
  const rayRef = useRef({ raycaster: new THREE.Raycaster(), mouse: new THREE.Vector2() });

  // state
  const [containers, setContainers] = useState([]);           // [{id, name, sizeTEU, color}]
  const containersRef = useRef([]);                           // same + mesh + cells
  const [occ, setOcc] = useState({});                         // "b-r-t" -> id
  const occRef = useRef({});
  const [selectedId, setSelectedId] = useState(null);
  const [slot, setSlot] = useState("A1");
  const [busy, setBusy] = useState(false);

  const [newSize, setNewSize] = useState(1);
  const [newColor, setNewColor] = useState("#d7bde2");

  const gateIndexRef = useRef(0);

  // memo yard size for asphalt
  const yardDims = useMemo(() => ({
    totalW: BAYS * BAY_W,
    totalD: ROWS * ROW_D,
  }), []);

  useEffect(() => {
    const el = mountRef.current;

    // --- Scene, Camera, Renderer
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf3f4f6);

    const camera = new THREE.PerspectiveCamera(55, el.clientWidth / el.clientHeight, 0.1, 1000);
    camera.position.set(-8, 14, 18);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(el.clientWidth, el.clientHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    el.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;

    // Lights
    scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 0.9));
    const dir = new THREE.DirectionalLight(0xffffff, 0.9);
    dir.position.set(20, 30, 10);
    scene.add(dir);

    // Subtle grid (optional)
    const grid = new THREE.GridHelper(30, 30, 0x666666, 0x999999);
    grid.material.transparent = true;
    grid.material.opacity = 0.08;
    const baseCell = cellOrigin(1, 1);
    grid.position.set(baseCell.x + BAY_W, 0, baseCell.z + ROW_D);
    scene.add(grid);

    // Ground plate
    const plate = new THREE.Mesh(
      new THREE.BoxGeometry(yardDims.totalW, PLATE_THICKNESS, yardDims.totalD),
      new THREE.MeshStandardMaterial({ color: 0xeeeeee })
    );
    plate.position.set(
      baseCell.x + yardDims.totalW / 2 - BAY_W / 2,
      PLATE_THICKNESS / 2,
      baseCell.z + yardDims.totalD / 2 - ROW_D / 2
    );
    scene.add(plate);

    // Asphalt (generate once)
    const { map: asphaltMap, bumpMap } = makeAsphaltTextureWithStalls({
      widthM: yardDims.totalW,
      heightM: yardDims.totalD,
      bays: BAYS,
      rows: ROWS,
      bayWidthM: BAY_W,
      rowDepthM: ROW_D,
      pxPerM: 96,
      dashedCenter: false,
      stallColor: "#ffffff",
    });
    // anisotropy for crisper at glancing angles
    const maxAniso = renderer.capabilities.getMaxAnisotropy?.() || 0;
    asphaltMap.anisotropy = Math.min(maxAniso, 8);
    bumpMap.anisotropy = Math.min(maxAniso, 2);

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
      new THREE.BoxGeometry(yardDims.totalW + 1.2, 0.15, 0.2),
      new THREE.MeshStandardMaterial({ color: 0x4682b4, metalness: 0.2, roughness: 0.5 })
    );
    bridge.position.set(plate.position.x, TRAVEL_Y + 0.0, CRANE_Z);
    scene.add(bridge);

    const hook = new THREE.Mesh(
      new THREE.CylinderGeometry(0.05, 0.05, 0.6, 16),
      new THREE.MeshStandardMaterial({ color: 0x333333 })
    );
    hook.rotation.z = Math.PI / 2;
    hook.position.set(bridge.position.x - yardDims.totalW / 2, TRAVEL_Y - 0.5, CRANE_Z);
    scene.add(hook);

    craneRef.current = { bridge, hook };

    // Target highlight planes (up to 2 cells)
    const hlGroup = new THREE.Group();
    hlGroup.visible = true;
    const planes = [0, 1].map(() => {
      const g = new THREE.PlaneGeometry(BAY_W * 0.96, ROW_D * 0.96);
      const m = new THREE.MeshBasicMaterial({
        color: 0x00ff66, transparent: true, opacity: 0.28, depthWrite: false,
      });
      const mesh = new THREE.Mesh(g, m);
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.y = PLATE_THICKNESS + 0.01;
      mesh.visible = false;
      hlGroup.add(mesh);
      return mesh;
    });
    scene.add(hlGroup);
    highlightRef.current = { group: hlGroup, planes };

    // Raycast for click-to-select
    const rayState = rayRef.current;
    const onPointerDown = (ev) => {
      const rect = renderer.domElement.getBoundingClientRect();
      rayState.mouse.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
      rayState.mouse.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
      rayState.raycaster.setFromCamera(rayState.mouse, camera);
      const meshes = containersRef.current.map((c) => c.mesh);
      const hits = rayState.raycaster.intersectObjects(meshes, false);
      if (hits.length) {
        const mesh = hits[0].object;
        const entry = containersRef.current.find((c) => c.mesh === mesh);
        if (entry) setSelectedId(entry.id);
      }
    };
    renderer.domElement.addEventListener("pointerdown", onPointerDown);

    // Resize
    const onResize = () => {
      renderer.setSize(el.clientWidth, el.clientHeight);
      camera.aspect = el.clientWidth / el.clientHeight;
      camera.updateProjectionMatrix();
    };
    window.addEventListener("resize", onResize);

    // RAF
    let raf;
    const loop = (t) => {
      controls.update();
      // run tweens
      three.current.anims = three.current.anims.filter((a) => !a.done);
      three.current.anims.forEach((a) => a.step(t));
      renderer.render(scene, camera);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    three.current = { scene, camera, renderer, controls, anims: [] };

    // Spawn one initial 20' container at gate
    const first = addContainerToScene(scene, { sizeTEU: 1, color: "#d7bde2" }, gateIndexRef.current++);
    containersRef.current = [first];
    setContainers([{ id: first.id, name: first.name, sizeTEU: first.sizeTEU, color: first.color }]);
    setSelectedId(first.id);

    // Cleanup
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      renderer.domElement.removeEventListener("pointerdown", onPointerDown);

      // dispose highlights
      planes.forEach((p) => {
        p.geometry.dispose();
        p.material.dispose();
      });

      // dispose asphalt textures
      plate.material.map?.dispose?.();
      plate.material.bumpMap?.dispose?.();
      plate.geometry.dispose();
      plate.material.dispose();

      // remove canvas
      el.removeChild(renderer.domElement);

      // dispose container meshes
      containersRef.current.forEach((c) => {
        c.mesh.material.dispose();
        // geometries are cached and disposed globally below
      });
      GEO20.dispose();
      GEO40.dispose();
    };
  }, [yardDims.totalD, yardDims.totalW]);

  // ===== Build helpers =====
  function buildContainerMesh(sizeTEU = 1, color = "#d7bde2") {
    const geom = sizeTEU === 2 ? GEO40 : GEO20;
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
    canvas.width = 256; canvas.height = 128;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "rgba(84, 80, 80, 0.95)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#111";
    ctx.font = "96px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, canvas.width / 2, canvas.height / 2);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex }));
    sprite.scale.set(1.2, 0.5, 1);
    return sprite;
  }
  const gatePositionForIndex = (idx) => {
    const offsetX = -idx * (BAY_W * GATE_SPACING + 0.2);
    return GATE_START.clone().add(new THREE.Vector3(offsetX, 0, 0));
  };
  function addContainerToScene(scene, { sizeTEU, color }, indexForQueue) {
    const mesh = buildContainerMesh(sizeTEU, color);
    mesh.position.copy(gatePositionForIndex(indexForQueue));
    scene.add(mesh);
    const id = `C${Math.random().toString(36).slice(2, 8)}`;
    const name = `${sizeTEU === 2 ? "40’" : "20’"} • ${id.toUpperCase()}`;
    return { id, name, sizeTEU, color, mesh, cells: [] };
  }

  // ===== Occupancy / rules =====
  function cellsForSizeAt(sizeTEU, bay, row, tier) {
    if (sizeTEU === 1) return [{ bay, row, tier }];
    if (row >= ROWS) return null; // 40' needs row+1
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
        reason:
          sizeTEU === 1
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
  function canRemove(entry) {
    const blockers = new Set();
    for (const c of entry.cells || []) {
      if (c.tier >= MAX_TIERS) continue;
      const aboveId = occRef.current[k(c.bay, c.row, c.tier + 1)];
      if (aboveId && aboveId !== entry.id) blockers.add(aboveId);
    }
    return { ok: blockers.size === 0, blockers: Array.from(blockers) };
  }

  // ===== Promise-based cancelable tween =====
  function tweenPosition(obj, target, ms = 1000) {
    const start = obj.position.clone();
    const t0 = performance.now();
    const token = (obj.userData.tweenToken || 0) + 1;
    obj.userData.tweenToken = token;
    return new Promise((resolve) => {
      const runner = {
        done: false,
        step: (t) => {
          if (obj.userData.tweenToken !== token) {
            runner.done = true; return resolve("canceled");
          }
          const p = Math.min(1, (t - t0) / ms);
          const e = lerpEase(p);
          obj.position.lerpVectors(start, target, e);
          if (p >= 1) { runner.done = true; resolve("ok"); }
        },
      };
      three.current.anims.push(runner);
    });
  }

  // ===== Highlights =====
  function showHighlights(cells, ok = true, autoHideMs = 1200) {
    const { planes } = highlightRef.current;
    planes.forEach((pl) => (pl.visible = false));
    cells.slice(0, planes.length).forEach((c, i) => {
      const pl = planes[i];
      const center = slotCenterAtTier(c.bay, c.row, 1); // draw on floor reference
      pl.position.x = center.x;
      pl.position.z = center.z;
      pl.material.color.set(ok ? 0x2ecc71 : 0xff4d4f);
      pl.visible = true;
    });
    if (autoHideMs > 0) {
      setTimeout(() => {
        planes.forEach((pl) => (pl.visible = false));
      }, autoHideMs);
    }
  }

  // ===== Actions =====
  async function placeAtSlot() {
    if (busy) return;
    const target = parseSlot(slot);
    if (!target) return alert("Bitte Slot im Format A1..C3 eingeben (z. B. A1).");
    if (!selectedId) return alert("Bitte zuerst einen Container auswählen oder hinzufügen.");

    const entry = containersRef.current.find((c) => c.id === selectedId);
    if (!entry) return alert("Ausgewählter Container nicht gefunden.");

    const decision = chooseTier(entry.id, entry.sizeTEU, target.bay, target.row);
    if (!decision.ok) {
      // visual "nope"
      const tentative = cellsForSizeAt(entry.sizeTEU, target.bay, target.row, 1) || [];
      showHighlights(tentative, false, 1400);
      return alert(decision.reason || "Platzierung nicht möglich.");
    }
    const { tier, cells } = decision;
    showHighlights(cells, true, 800);

    setBusy(true);
    const { bridge, hook } = craneRef.current;
    const cont = entry.mesh;
    const topY = TRAVEL_Y;

    // targets
    const topOver = slotCenterAtTier(target.bay, target.row, 1).clone(); topOver.y = topY;

    let dropCenter = slotCenterAtTier(target.bay, target.row, tier).clone();
    if (entry.sizeTEU === 2) {
      const nextCenter = slotCenterAtTier(target.bay, target.row + 1, tier).clone();
      dropCenter = dropCenter.lerp(nextCenter, 0.5);
    }

    const pickTop = cont.position.clone(); pickTop.y = topY;
    const hookRest = dropCenter.clone(); hookRest.y = dropCenter.y + CONTAINER_HALF_H + 0.2; hookRest.z = CRANE_Z;

    try {
      await tweenPosition(bridge, new THREE.Vector3(topOver.x, topY, CRANE_Z), 800);
      await tweenPosition(hook, pickTop, 600);
      await tweenPosition(cont, pickTop, 600);

      const topOverZ = entry.sizeTEU === 1 ? topOver.z : dropCenter.z;
      await tweenPosition(hook, new THREE.Vector3(topOver.x, topOver.y, CRANE_Z), 300);
      await tweenPosition(cont, new THREE.Vector3(topOver.x, topOver.y, topOverZ), 900);

      await tweenPosition(hook, hookRest, 600);
      await tweenPosition(cont, dropCenter, 600);

      occupy(entry.id, cells, entry.cells);
      entry.cells = cells;
    } finally {
      setBusy(false);
    }
  }

  async function removeSelected() {
    if (busy) return;
    if (!selectedId) return alert("Bitte zuerst einen Container auswählen.");
    const entry = containersRef.current.find((c) => c.id === selectedId);
    if (!entry) return alert("Ausgewählter Container nicht gefunden.");
    if (!entry.cells || entry.cells.length === 0) return alert("Dieser Container steht bereits am Gate (nicht im Yard).");

    const { ok, blockers } = canRemove(entry);
    if (!ok) {
      const names = blockers.map((bid) => containersRef.current.find((x) => x.id === bid)?.name || bid).join(", ");
      showHighlights(entry.cells, false, 1400);
      return alert("Entstapeln nicht möglich. Zuerst entfernen: " + names);
    }

    setBusy(true);
    const { bridge, hook } = craneRef.current;
    const cont = entry.mesh;
    const topY = TRAVEL_Y;

    // current center (handles 20’/40’)
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
    const flyTop = new THREE.Vector3(parkPos.x, topY, parkPos.z);
    const hookRest = new THREE.Vector3(liftTop.x, topY, CRANE_Z);

    try {
      await tweenPosition(bridge, new THREE.Vector3(liftTop.x, topY, CRANE_Z), 600);
      await tweenPosition(hook, liftTop, 500);
      await tweenPosition(cont, liftTop, 500);

      await tweenPosition(hook, hookRest, 300);
      await tweenPosition(cont, flyTop, 900);

      await tweenPosition(hook, new THREE.Vector3(flyTop.x, flyTop.y, CRANE_Z), 300);
      await tweenPosition(cont, parkPos, 600);

      occupy(entry.id, [], entry.cells);
      entry.cells = [];
      showHighlights([], true, 0);
    } finally {
      setBusy(false);
    }
  }

  function handleAddContainer() {
    if (!three.current.scene) return;
    const scene = three.current.scene;
    const added = addContainerToScene(scene, { sizeTEU: Number(newSize), color: newColor }, gateIndexRef.current++);
    containersRef.current = [...containersRef.current, added];
    setContainers((prev) => [...prev, { id: added.id, name: added.name, sizeTEU: added.sizeTEU, color: added.color }]);
    setSelectedId(added.id);
  }

  // ===== UI helpers =====
  const selectedEntry = containersRef.current.find((c) => c.id === selectedId);
  const selectedIs40InvalidRow = (() => {
    if (!selectedEntry) return false;
    if (selectedEntry.sizeTEU !== 2) return false;
    const p = parseSlot(slot);
    return p ? p.row >= ROWS : false;
  })();

  // Build occupancy HUD (3x3 for each tier)
  function HudGrid({ tier }) {
    const rows = [];
    for (let r = 1; r <= ROWS; r++) {
      const cols = [];
      for (let b = 1; b <= BAYS; b++) {
        const id = occ[k(b, r, tier)];
        const label = `${LETTERS[b - 1]}${r}`;
        cols.push(
          <div key={b} style={{
            border: "1px solid #ddd",
            padding: "4px 6px",
            fontSize: 12,
            background: id ? "#ffe9cc" : "#fafafa",
            whiteSpace: "nowrap",
          }}>
            <span style={{ opacity: 0.6 }}>{label}</span>
            <div style={{ fontWeight: 600, fontSize: 11, overflow: "hidden", textOverflow: "ellipsis" }}>
              {id ? (containersRef.current.find(c => c.id === id)?.name || id) : "frei"}
            </div>
          </div>
        );
      }
      rows.push(<div key={r} style={{ display: "grid", gridTemplateColumns: `repeat(${BAYS}, 1fr)` }}>{cols}</div>);
    }
    return <div style={{ display: "grid", gap: 4 }}>{rows}</div>;
  }

  // ===== UI =====
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1fr 460px",
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
      <div style={{ display: "flex", flexDirection: "column", gap: 12, overflow: "auto" }}>
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
            style={{ marginLeft: 8, padding: "6px 8px", minWidth: 280 }}
          >
            {containers.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </label>

        {/* Move / Remove */}
        <label style={{ fontSize: 14 }}>
          Zielslot (z. B. <b>A1</b>):{" "}
          <input
            value={slot}
            onChange={(e) => setSlot(e.target.value)}
            pattern="[A-Ca-c][1-3]"
            title="A1..C3"
            maxLength={2}
            style={{ width: 64, padding: "6px 8px", marginLeft: 8 }}
          />
        </label>
        {selectedIs40InvalidRow && (
          <div style={{ fontSize: 12, color: "#a94442" }}>
            40’ kann nicht in die letzte Reihe gestartet werden (benötigt +1 Reihe).
          </div>
        )}

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
            title="Bewege aktiven Container zum Slot (Tier 1 bevorzugt; Tier 2 mit Stütze)"
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

        {/* Occupancy HUD */}
        <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
          <h3 style={{ margin: "8px 0 0 0", fontSize: 14 }}>Belegung · Tier 1</h3>
          <HudGrid tier={1} />
          <h3 style={{ margin: "12px 0 0 0", fontSize: 14 }}>Belegung · Tier 2</h3>
          <HudGrid tier={2} />
        </div>

        <div style={{ fontSize: 12, color: "#666", lineHeight: 1.5, marginTop: 8 }}>
          • Klick auf einen Container in 3D wählt ihn aus.<br />
          • Grüne Highlights = Zielzellen; Rot = Blockiert.<br />
          • Tier 1 zuerst; Tier 2 nur mit Stützregeln (20’: 1 Zelle; 40’: beide Zellen).<br />
          • Entstapeln: nur wenn nichts darüber steht.
        </div>
      </div>
    </div>
  );
}
