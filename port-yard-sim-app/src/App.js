// src/App.js
// ---------------------------------------------
// Mini Yard Crane: multiple containers + occupancy + 2 tiers
// 40' spans same letter + next row (A1+A2, B2+B3, etc.)
// Tier rules:
//  - 20' on Tier 2: needs support below at that cell.
//  - 40' on Tier 2: needs support below on BOTH cells (one 40' or two 20').
// ---------------------------------------------

import React, { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

// ===== Constants =====
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
const MAX_TIERS = 2;        // we support 2 tiers for now

// Gate spawn baseline (left of A1)
const GATE_START = new THREE.Vector3(-6, CONTAINER_HALF_H, 0);
const GATE_SPACING = 1.1;

// ===== Helpers =====
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

// ===== Main Component =====
export default function App() {
  const mountRef = useRef(null);

  // three.js handles
  const three = useRef({ scene: null, camera: null, renderer: null, controls: null, anims: [] });
  const craneRef = useRef({ bridge: null, hook: null });

  // containers: [{id, name, mesh, sizeTEU, color, cells: [{bay,row,tier}, ...] }]
  const [containers, setContainers] = useState([]);
  const containersRef = useRef([]);

  // occupancy map: key "bay-row-tier" -> containerId
  const [occ, setOcc] = useState({});
  const occRef = useRef({});

  const [selectedId, setSelectedId] = useState(null);

  const [slot, setSlot] = useState("A1");
  const [busy, setBusy] = useState(false);

  // Add form
  const [newSize, setNewSize] = useState(1); // 1 TEU (20') or 2 TEU (40')
  const [newColor, setNewColor] = useState("#d7bde2");

  useEffect(() => {
    const el = mountRef.current;

    // --- Scene / Camera / Renderer
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf6f8fa);

    const camera = new THREE.PerspectiveCamera(55, el.clientWidth / el.clientHeight, 0.1, 1000);
    camera.position.set(-8, 14, 18);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(el.clientWidth, el.clientHeight);
    el.appendChild(renderer.domElement);

    // controls
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;

    // lights
    scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 0.9));
    const dir = new THREE.DirectionalLight(0xffffff, 0.8);
    dir.position.set(20, 30, 10);
    scene.add(dir);

    // grid + ground plate
    const grid = new THREE.GridHelper(30, 30, 0x888888, 0xdddddd);
    const baseCell = cellOrigin(1, 1);
    grid.position.set(baseCell.x + BAY_W, 0, baseCell.z + ROW_D);
    scene.add(grid);

    const totalW = BAYS * BAY_W;
    const totalD = ROWS * ROW_D;

    const plate = new THREE.Mesh(
      new THREE.BoxGeometry(totalW, PLATE_THICKNESS, totalD),
      new THREE.MeshBasicMaterial({ color: 0xeeeeee, transparent: true, opacity: 0.85 })
    );
    plate.position.set(
      baseCell.x + totalW / 2 - BAY_W / 2,
      PLATE_THICKNESS / 2,
      baseCell.z + totalD / 2 - ROW_D / 2
    );
    scene.add(plate);

    // cell lines & labels
    drawCellLines(scene);
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

    // crane (bridge + hook)
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

    // render loop
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

    // Spawn one initial 20' container
    const first = addContainerToScene(scene, { sizeTEU: 1, color: "#d7bde2" }, 0);
    containersRef.current = [first];
    setContainers([dehydrate(first)]);
    setSelectedId(first.id);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      el.removeChild(renderer.domElement);
    };
  }, []);

  // ===== Scene helpers =====
  function buildContainerMesh(sizeTEU = 1, color = "#d7bde2") {
    // 40' spans along Z (rows), not X.
    const widthX = BAY_W * 0.95; // constant width fits one bay
    const depthZ = (sizeTEU === 2 ? ROW_D * 2 : ROW_D) * 0.95; // 40' doubles depth
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

  function drawCellLines(scene) {
    const mat = new THREE.LineBasicMaterial({ color: 0xaaaaaa });
    const group = new THREE.Group();
    const origin = cellOrigin(1, 1);

    for (let b = 0; b <= BAYS; b++) {
      const x = origin.x + b * BAY_W - BAY_W / 2;
      const geo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(x, PLATE_THICKNESS + 0.03, origin.z - ROW_D / 2),
        new THREE.Vector3(x, PLATE_THICKNESS + 0.03, origin.z + ROWS * ROW_D - ROW_D / 2),
      ]);
      group.add(new THREE.Line(geo, mat));
    }

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

  // Basic tween for positions
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

  // ---- Container management (scene + state) ----
  function addContainerToScene(scene, { sizeTEU, color }, indexForQueue) {
    const mesh = buildContainerMesh(sizeTEU, color);
    // Gate queue spacing
    const offsetX = -indexForQueue * (BAY_W * GATE_SPACING + 0.2);
    mesh.position.copy(GATE_START.clone().add(new THREE.Vector3(offsetX, 0, 0)));
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
    const idx = containersRef.current.length;
    const added = addContainerToScene(scene, { sizeTEU: Number(newSize), color: newColor }, idx);
    containersRef.current = [...containersRef.current, added];
    setContainers((prev) => [...prev, dehydrate(added)]);
    setSelectedId(added.id);
  }

  // ===== Occupancy helpers (with tiers) =====
  const key = (bay, row, tier) => `${bay}-${row}-${tier}`;

  function cellsForSizeAt(sizeTEU, bay, row, tier) {
    if (sizeTEU === 1) return [{ bay, row, tier }];
    if (row >= ROWS) return null; // 40' needs row+1
    return [{ bay, row, tier }, { bay, row: row + 1, tier }];
  }

  function isFreeFor(containerId, cells) {
    for (const c of cells) {
      const k = key(c.bay, c.row, c.tier);
      const occBy = occRef.current[k];
      if (occBy && occBy !== containerId) return false;
    }
    return true;
  }

  // Support check for Tier 2
  function hasSupportBelow(sizeTEU, bay, row) {
    // We check Tier 1 occupancy under the would-be Tier 2 cells
    if (sizeTEU === 1) {
      const kBelow = key(bay, row, 1);
      return !!occRef.current[kBelow];
    }
    // 40': need BOTH cells supported at Tier 1
    if (row >= ROWS) return false;
    const k1 = key(bay, row, 1);
    const k2 = key(bay, row + 1, 1);
    const id1 = occRef.current[k1];
    const id2 = occRef.current[k2];
    // requirement: both present; they may be the same (one 40') or different (two 20')
    return !!(id1 && id2);
  }

  // Decide tier automatically: prefer Tier 1, else Tier 2 with support
  function chooseTier(containerId, sizeTEU, bay, row) {
    // Try Tier 1
    const cellsTier1 = cellsForSizeAt(sizeTEU, bay, row, 1);
    if (cellsTier1 && isFreeFor(containerId, cellsTier1)) {
      return { ok: true, tier: 1, cells: cellsTier1 };
    }
    // Try Tier 2
    const cellsTier2 = cellsForSizeAt(sizeTEU, bay, row, 2);
    if (!cellsTier2) return { ok: false, reason: "Kein Platz (Rand) für 40’." };
    if (!isFreeFor(containerId, cellsTier2))
      return { ok: false, reason: "Ziel auf Ebene 2 ist bereits belegt." };
    if (!hasSupportBelow(sizeTEU, bay, row)) {
      return {
        ok: false,
        reason:
          sizeTEU === 1
            ? "Für 20’ auf Ebene 2 fehlt die Stütze darunter."
            : "Für 40’ auf Ebene 2 müssen beide Zellen darunter belegt sein (ein 40’ oder zwei 20’).",
      };
    }
    return { ok: true, tier: 2, cells: cellsTier2 };
  }

  function occupy(containerId, newCells, prevCells = []) {
    // clear previous cells
    const occCopy = { ...occRef.current };
    for (const c of prevCells) {
      const k = key(c.bay, c.row, c.tier);
      if (occCopy[k] === containerId) delete occCopy[k];
    }
    // set new cells
    for (const c of newCells) {
      occCopy[key(c.bay, c.row, c.tier)] = containerId;
    }
    occRef.current = occCopy;
    setOcc(occCopy);
  }

  // ===== Actions =====
  function placeAtSlot() {
    if (busy) return;
    const target = parseSlot(slot);
    if (!target) {
      alert("Bitte Slot im Format A1..C3 eingeben (z. B. A1).");
      return;
    }
    if (!selectedId) {
      alert("Bitte zuerst einen Container auswählen oder hinzufügen.");
      return;
    }

    const entry = containersRef.current.find((c) => c.id === selectedId);
    if (!entry) {
      alert("Ausgewählter Container nicht gefunden.");
      return;
    }

    // Decide tier & check occupancy/support
    const decision = chooseTier(entry.id, entry.sizeTEU, target.bay, target.row);
    if (!decision.ok) {
      alert(decision.reason || "Platzierung nicht möglich.");
      return;
    }
    const tier = decision.tier;
    const cells = decision.cells;

    setBusy(true);

    const cont = entry.mesh;
    const { bridge, hook } = craneRef.current;

    // --- Compute target centers
    const topY = TRAVEL_Y;

    // Crane X aligns to bay center
    const topOver = slotCenterAtTier(target.bay, target.row, 1).clone();
    topOver.y = topY;

    // Container center at chosen tier:
    // 20’: center of (bay,row,tier)
    // 40’: midpoint between (bay,row,tier) and (bay,row+1,tier)
    let dropCenter = slotCenterAtTier(target.bay, target.row, tier).clone();
    if (entry.sizeTEU === 2) {
      const nextCenter = slotCenterAtTier(target.bay, target.row + 1, tier).clone();
      dropCenter = dropCenter.lerp(nextCenter, 0.5);
    }

    const pickTop = cont.position.clone();
    pickTop.y = topY;

    const hookRest = dropCenter.clone();
    hookRest.y = dropCenter.y + CONTAINER_HALF_H + 0.2;
    hookRest.z = CRANE_Z;

    // Move bridge to correct X first
    animateTo(bridge, new THREE.Vector3(topOver.x, topY, CRANE_Z), 800);

    // Hook + container choreography
    animateTo(hook, pickTop, 600, () => {
      animateTo(cont, pickTop, 600, () => {
        // Move along Z to above target path
        const topOverZ = entry.sizeTEU === 1 ? topOver.z : dropCenter.z;
        animateTo(hook, new THREE.Vector3(topOver.x, topOver.y, CRANE_Z), 400);
        animateTo(cont, new THREE.Vector3(topOver.x, topOver.y, topOverZ), 900, () => {
          animateTo(hook, hookRest, 600);
          animateTo(cont, dropCenter, 600, () => {
            // Update occupancy & remember our cells (with tiers)
            occupy(entry.id, cells, entry.cells);
            entry.cells = cells;
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
        gridTemplateColumns: "1fr 380px",
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
            style={{ marginLeft: 8, padding: "6px 8px", minWidth: 240 }}
          >
            {containers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>

        {/* Move to slot */}
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
          disabled={busy || !selectedId}
          style={{
            padding: "8px 12px",
            border: "1px solid #ddd",
            borderRadius: 8,
            background: busy ? "#eee" : "#f7f7f7",
            cursor: busy ? "not-allowed" : "pointer",
          }}
        >
          {busy ? "Kran arbeitet…" : "Aktiven Container zum Slot bewegen"}
        </button>

        <div style={{ fontSize: 13, color: "#555", lineHeight: 1.5 }}>
          • **Tier 1** zuerst, **Tier 2** nur wenn Tier 1 belegt ist und Stützregeln passen.<br />
          • 20’ auf Tier 2: Zelle darunter muss belegt sein.<br />
          • 40’ auf Tier 2: Beide Zellen darunter müssen belegt sein (ein 40’ oder zwei 20’).<br />
          • Letzte Reihe (x3) ist Startzelle für 40’ nicht zulässig (braucht +1 Reihe).<br />
          • Kamera: Linke Maus – Orbit, Mausrad – Zoom, Rechte Maus – Pan.
        </div>
      </div>
    </div>
  );
}
