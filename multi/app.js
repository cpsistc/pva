// ═══════════════════════════════════════════════════════════
//  CONSTANTS
// ═══════════════════════════════════════════════════════════
const GLOBAL_ALPHA     = 195;
const COVERAGE         = 0.97;
const HIGHLIGHT_HEXA   = [180, 220, 255, 160];
const ARROW_DECIMALS   = 1;
const ARROW_COLOR      = [255, 255, 255];
const ARROW_ALPHA      = 255;
const ARROW_REACH      = 0.60;
const ARROW_MAX_FACTOR = 0.30;
const ARROW_MIN_FACTOR = 0.03;
const LABEL_COLOR      = [255, 255, 255, 255];
const STORAGE_KEY      = 'hex3d_saved_configs_v2';

const COLOR_WHITE      = '#ffffff';
const COLOR_BLACK      = '#000000';
const COLOR_DEFAULT_BG = '#1a3a4a';

const DEFAULT_INIT_VIEW = { longitude:-6.7, latitude:48.13, zoom:9, pitch:60, bearing:-20 };

// 20 km offset in degrees (approximate, varies by latitude)
const KM_TO_DEG_LAT = 1 / 111.32; // ~0.00899 deg per km
function kmToLngDeg(km, lat) { return km / (111.32 * Math.cos(lat * Math.PI / 180)); }

const BASE_LAT = DEFAULT_INIT_VIEW.latitude;
const BASE_LNG = DEFAULT_INIT_VIEW.longitude;
const OFFSET_KM = 30;

// Default layer template (relative to each stack's center)
const DEFAULT_LAYERS_TEMPLATE = [
  { id:'surface', label:'Surface',       altitude:0,     resolution:8, radiusKm:10, baseColor:'#4aaeff', palette:[[0,60,160],[40,130,220],[180,220,255]], visible:true },
  { id:'mid',     label:'Mid Altitude',  altitude:5000,  resolution:7, radiusKm:12, baseColor:'#14aabc', palette:[[0,100,120],[20,170,190],[160,235,245]], visible:true },
  { id:'upper',   label:'Upper Altitude',altitude:15000, resolution:7, radiusKm:18, baseColor:'#28c89b', palette:[[0,130,100],[40,200,160],[180,245,225]], visible:true },
];

// Build 5 initial stacks (center + 4 cardinal directions at ±20km)
function buildDefaultStacks() {
  const dLat = OFFSET_KM * KM_TO_DEG_LAT;
  const dLng = kmToLngDeg(OFFSET_KM, BASE_LAT);
  const positions = [
    { name:'Center',     lat: BASE_LAT,         lng: BASE_LNG },
    { name:'North',      lat: BASE_LAT + dLat,  lng: BASE_LNG },
    { name:'South',      lat: BASE_LAT - dLat,  lng: BASE_LNG },
    { name:'West',       lat: BASE_LAT,         lng: BASE_LNG - dLng },
    { name:'East',       lat: BASE_LAT,         lng: BASE_LNG + dLng },
  ];
  return positions.map((p, i) => ({
    id: 'stack_' + i,
    name: p.name,
    lat: p.lat,
    lng: p.lng,
    visible: true,
    layers: deepClone(DEFAULT_LAYERS_TEMPLATE).map(l => ({
      ...l,
      id: l.id + '_s' + i,
    })),
  }));
}

// ── Mutable state ─────────────────────────────────────────
let STACKS        = buildDefaultStacks();
let SELECTED_STACK_ID = null; // id of currently selected stack
let ALL_DATA      = []; // flat array: { stackId, layerIdx, data[] }
let hoveredMap    = {}; // { stackId_layerIdx: cellId | null }
let SHOW_FLOW     = false;
let SHOW_MAP      = false;
let BG_COLOR      = COLOR_WHITE;
let CENTER_COLOR  = null; // null = use gradient
let _idCounter    = 1000;

// ═══════════════════════════════════════════════════════════
//  UTILITIES
// ═══════════════════════════════════════════════════════════
function deepClone(o){ return JSON.parse(JSON.stringify(o)); }
function newLayerId(){ return 'L' + (_idCounter++); }

function hexToRgb(h){ return [parseInt(h.slice(1,3),16), parseInt(h.slice(3,5),16), parseInt(h.slice(5,7),16)]; }
function rgbToHex(r,g,b){ return '#' + [r,g,b].map(v=>v.toString(16).padStart(2,'0')).join(''); }
function generatePalette(hex){
  const [r,g,b] = hexToRgb(hex);
  return [
    [Math.round(r*.28), Math.round(g*.28), Math.round(b*.28)],
    [r, g, b],
    [Math.round(r+(255-r)*.55), Math.round(g+(255-g)*.55), Math.round(b+(255-b)*.55)],
  ];
}

function haversineKm(la1,lo1,la2,lo2){
  const R=6371, r=Math.PI/180;
  const a = Math.sin((la2-la1)*r/2)**2 + Math.cos(la1*r)*Math.cos(la2*r)*Math.sin((lo2-lo1)*r/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}
function lerpColor(p,t){
  const n=p.length-1, i=Math.min(Math.floor(t*n),n-1), f=t*n-i;
  return p[i].map((c,k)=>Math.round(c+f*(p[i+1][k]-c)));
}
function stableValue(s){
  let h=0; for(let i=0;i<s.length;i++) h=(h*31+s.charCodeAt(i))>>>0; return (h%1000)/1000;
}
function cellToXYZ(cell,alt){ return h3.cellToBoundary(cell).map(([la,ln])=>[ln,la,alt]); }
function getCellsInRadius(lat,lng,rKm,res){
  const ctr = h3.latLngToCell(lat, lng, res);
  const k = Math.ceil(rKm/(h3.getHexagonEdgeLengthAvg(res,'km')*1.5))+1;
  return h3.gridDisk(ctr,k).filter(c=>{ const [la,ln]=h3.cellToLatLng(c); return haversineKm(lat,lng,la,ln)<=rKm; });
}
function shrinkPoly(poly,cx,cy,f){ return poly.map(([x,y,z])=>[cx+(x-cx)*f, cy+(y-cy)*f, z]); }

function getNeighbourFlow(cell){
  const nb = h3.gridDisk(cell,1).filter(c=>c!==cell);
  const raw = nb.map(n=>Math.max(0.01, stableValue(cell+':'+n)));
  const sum = raw.reduce((a,b)=>a+b,0);
  return nb.map((c,i)=>{ const [la,ln]=h3.cellToLatLng(c); return {cell:c, pct:(raw[i]/sum)*100, lat:la, lng:ln}; });
}

function makeArrowPoly(fLng,fLat,tLng,tLat,wM,alt){
  const cl=Math.cos(fLat*Math.PI/180);
  const dx=(tLng-fLng)*cl, dy=tLat-fLat, len=Math.sqrt(dx*dx+dy*dy);
  const ux=dx/len, uy=dy/len, px=-uy, py=ux;
  const hw=(wM/2)/111000, hwT=hw*2.2;
  const sf=0.18, ef=ARROW_REACH, tf=ef+0.1;
  const sx=fLng+(ux*len*sf)/cl, sy=fLat+uy*len*sf;
  const ex=fLng+(ux*len*ef)/cl, ey=fLat+uy*len*ef;
  const tx=fLng+(ux*len*tf)/cl, ty=fLat+uy*len*tf;
  return [[sx+(px/cl)*hw,sy+py*hw,alt],[ex+(px/cl)*hwT,ey+py*hwT,alt],[tx,ty,alt],[ex-(px/cl)*hwT,ey-py*hwT,alt],[sx-(px/cl)*hw,sy-py*hw,alt]];
}

function buildData(cfg, stackLat, stackLng){
  const centerCell = h3.latLngToCell(stackLat, stackLng, cfg.resolution);
  return getCellsInRadius(stackLat, stackLng, cfg.radiusKm, cfg.resolution).map(cell=>{
    const [cLat,cLng] = h3.cellToLatLng(cell);
    const tDist = Math.min(haversineKm(stackLat, stackLng, cLat, cLng) / cfg.radiusKm, 1);
    const isCenter = (cell === centerCell);
    return {
      cell,
      poly3d: shrinkPoly(cellToXYZ(cell, cfg.altitude), cLng, cLat, COVERAGE),
      poly2d: h3.cellToBoundary(cell).map(([la,ln])=>[ln,la]),
      rgb: lerpColor(cfg.palette, tDist),
      alpha: GLOBAL_ALPHA, tDist, cLat, cLng, isCenter,
    };
  });
}

// ── Helpers to get a stack and its flat index context ─────
function getStack(id){ return STACKS.find(s=>s.id===id); }
function getSelectedStack(){ return SELECTED_STACK_ID ? getStack(SELECTED_STACK_ID) : null; }

// Hover key: stackId + layerIndex within that stack
function hovKey(stackId, layerIdx){ return stackId + '::' + layerIdx; }

// ═══════════════════════════════════════════════════════════
//  DECK.GL
// ═══════════════════════════════════════════════════════════
const { Deck, PolygonLayer, TextLayer, MapView } = deck;

function makeFlatLayer(cfg, data, stackId, layerIdx){
  if(!cfg.visible) return null;
  const key = hovKey(stackId, layerIdx);
  return new PolygonLayer({
    id: `flat-${cfg.id}`,
    data, pickable:true, filled:true, stroked:false, extruded:false, positionFormat:'XYZ',
    getPolygon: d => hoveredMap[key]===d.cell
      ? d.poly2d.map(([ln,la])=>[ln,la,cfg.altitude])
      : d.poly3d,
    getFillColor: d => {
      if(hoveredMap[key]===d.cell) return HIGHLIGHT_HEXA;
      if(d.isCenter && CENTER_COLOR !== null) return [...hexToRgb(CENTER_COLOR), d.alpha];
      return [...d.rgb, d.alpha];
    },
    onHover: info => {
      const prev = hoveredMap[key];
      hoveredMap[key] = info.object?.cell ?? null;
      if(prev !== hoveredMap[key]) render();
      showTip(info, cfg);
    },
    onClick: info => {
      if(!info.object) return;
      navigator.clipboard.writeText(info.object.cell);
      const el = document.getElementById('tooltip');
      const cid = el.querySelector('.cell-id');
      if(cid){ cid.textContent='✓ Copied!'; setTimeout(()=>{ cid.textContent=info.object.cell; }, 1200); }
    },
    updateTriggers: { getFillColor:[hoveredMap[key],CENTER_COLOR], getPolygon:hoveredMap[key] },
  });
}

function makePrismLayer(cfg, data, lo, hi, stackId, layerIdx, valid){
  const key = hovKey(stackId, layerIdx);
  const cell = (valid && cfg.visible) ? hoveredMap[key] : null;
  const items = cell ? data.filter(d=>d.cell===cell) : [];
  const elevation = (valid && hi > lo) ? hi - lo : 0;
  return new PolygonLayer({
    id: `prism-${cfg.id}`,
    data:items, pickable:false, filled:true, stroked:false, extruded:true, wireframe:false, positionFormat:'XYZ',
    getPolygon: d => d.poly2d.map(([ln,la])=>[ln,la,lo]),
    getElevation: elevation,
    getFillColor: d => [...d.rgb, 125],
    updateTriggers: { data:cell, lo, hi },
  });
}

function makeArrowLayer(cfg, data, stackId, layerIdx){
  if(!SHOW_FLOW || !cfg.visible) return null;
  const key = hovKey(stackId, layerIdx);
  const cell = hoveredMap[key]; if(!cell) return null;
  const hov = data.find(d=>d.cell===cell); if(!hov) return null;
  const flow = getNeighbourFlow(cell);
  const alt = cfg.altitude + 10;
  const eM = h3.getHexagonEdgeLengthAvg(cfg.resolution, 'm');
  const maxW=eM*ARROW_MAX_FACTOR, minW=eM*ARROW_MIN_FACTOR;
  const ad = flow.map(f=>({ polygon:makeArrowPoly(hov.cLng,hov.cLat,f.lng,f.lat,minW+(f.pct/100)*(maxW-minW),alt), pct:f.pct }));
  const cr=eM*0.4, dpm=1/111000, cl=Math.cos(hov.cLat*Math.PI/180);
  ad.push({ polygon:Array.from({length:32},(_,i)=>{ const a=(i/32)*2*Math.PI; return [hov.cLng+(Math.cos(a)*cr*dpm)/cl, hov.cLat+Math.sin(a)*cr*dpm, alt]; }), pct:0 });
  return new PolygonLayer({ id:`arrows-${cfg.id}`, data:ad, pickable:false, filled:true, stroked:false, extruded:false, positionFormat:'XYZ', getPolygon:d=>d.polygon, getFillColor:[...ARROW_COLOR,ARROW_ALPHA], updateTriggers:{data:cell} });
}

function makeArrowLabelLayer(cfg, data, stackId, layerIdx){
  if(!SHOW_FLOW || !cfg.visible) return null;
  const key = hovKey(stackId, layerIdx);
  const cell = hoveredMap[key]; if(!cell) return null;
  const hov = data.find(d=>d.cell===cell); if(!hov) return null;
  const flow = getNeighbourFlow(cell);
  const edgeM = h3.getHexagonEdgeLengthAvg(cfg.resolution, 'm');
  const textSize = edgeM * 0.30;
  return new TextLayer({
    id: `lbl-${cfg.id}`,
    data: flow.map(f=>({ position:[f.lng,f.lat,cfg.altitude+200], text:f.pct.toFixed(ARROW_DECIMALS)+'%' })),
    pickable:false, getPosition:d=>d.position, getText:d=>d.text,
    sizeUnits:'meters', getSize:textSize,
    getColor:LABEL_COLOR, fontFamily:'JetBrains Mono,monospace', fontWeight:'bold',
    billboard:true, getTextAnchor:'middle', getAlignmentBaseline:'center',
    fontSettings:{sdf:true}, outlineWidth:3, outlineColor:[0,0,0,200], updateTriggers:{data:cell},
  });
}

function render(){
  const layers = [];
  const GAP = 5;

  STACKS.forEach(stack => {
    if(!stack.visible) return;

    const byAlt = [...stack.layers].sort((a,b)=>a.altitude-b.altitude);
    const stackData = ALL_DATA.filter(d=>d.stackId===stack.id);

    stack.layers.forEach((cfg, layerIdx) => {
      const dataEntry = stackData.find(d=>d.layerIdx===layerIdx);
      if(!dataEntry) return;
      const data = dataEntry.data;

      // Prism
      let prismLo=0, prismHi=0, prismValid=false;
      if(cfg.altitude !== 0){
        if(cfg.altitude > 0){
          const below = byAlt.filter(l=>l.altitude < cfg.altitude);
          if(below.length){
            const neighbour = below[below.length-1];
            const lo = neighbour.altitude + GAP;
            const hi = cfg.altitude - GAP;
            if(hi > lo){ prismLo=lo; prismHi=hi; prismValid=true; }
          }
        } else {
          const above = byAlt.filter(l=>l.altitude > cfg.altitude);
          if(above.length){
            const neighbour = above[0];
            const lo = cfg.altitude + GAP;
            const hi = neighbour.altitude - GAP;
            if(hi > lo){ prismLo=lo; prismHi=hi; prismValid=true; }
          }
        }
      }
      layers.push(makePrismLayer(cfg, data, prismLo, prismHi, stack.id, layerIdx, prismValid));

      const flat = makeFlatLayer(cfg, data, stack.id, layerIdx); if(flat) layers.push(flat);
      const a = makeArrowLayer(cfg, data, stack.id, layerIdx); if(a) layers.push(a);
      const l = makeArrowLabelLayer(cfg, data, stack.id, layerIdx); if(l) layers.push(l);
    });
  });

  deckgl.setProps({ layers });
}

function showTip(info, cfg){
  const el = document.getElementById('tooltip');
  if(!info.object){ el.style.display='none'; return; }
  const d = info.object;
  // Find the stack for context
  const stackInfo = STACKS.find(s => s.layers.some(l => l.id === cfg.id));
  const stackLabel = stackInfo ? `<div class="tip-label">Stack</div><div class="tip-val">${stackInfo.name}</div>` : '';
  el.innerHTML = `${stackLabel}
    <div class="tip-label">Layer</div><div class="tip-val">${cfg.label}</div>
    <div class="tip-label">Altitude</div><div class="tip-val">${(cfg.altitude/1000).toFixed(1)} km</div>
    <div class="tip-label">Distance from center</div><div class="tip-val">${(d.tDist*cfg.radiusKm).toFixed(1)} km</div>
    <div class="tip-label">H3 cell</div><div class="tip-val cell-id" style="font-size:9px;letter-spacing:.05em">${d.cell}</div>`;
  el.style.display = 'block';
}

// ═══════════════════════════════════════════════════════════
//  REBUILD STATE
// ═══════════════════════════════════════════════════════════
function rebuildState(){
  // Rebuild ALL_DATA for all stacks
  ALL_DATA = [];
  STACKS.forEach(stack => {
    stack.layers.forEach((cfg, layerIdx) => {
      ALL_DATA.push({
        stackId: stack.id,
        layerIdx,
        data: buildData(cfg, stack.lat, stack.lng),
      });
    });
  });
  buildStacksList();
  buildLayerEditor();
  render();
}

// ═══════════════════════════════════════════════════════════
//  STACKS UI
// ═══════════════════════════════════════════════════════════
function buildStacksList(){
  const cont = document.getElementById('stacks-list'); cont.innerHTML = '';
  // Sort alphabetically by name
  const sorted = [...STACKS].sort((a,b)=>a.name.localeCompare(b.name));

  sorted.forEach(stack => {
    const row = document.createElement('div');
    row.className = 'stack-row' + (stack.id === SELECTED_STACK_ID ? ' selected' : '');
    row.dataset.stackId = stack.id;

    // Colored checkbox using the midpoint color of first visible layer
    const firstLayer = stack.layers.find(l=>l.visible) || stack.layers[0];
    const mid = firstLayer ? lerpColor(firstLayer.palette, .5) : [120,120,120];
    const colorHex = rgbToHex(...mid);

    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.className = 'stack-vis-check';
    chk.checked = stack.visible;
    chk.style.color = colorHex;
    chk.style.borderColor = stack.visible ? colorHex : 'rgba(255,255,255,0.22)';
    chk.style.background = stack.visible ? colorHex + '22' : 'transparent';
    chk.addEventListener('change', e => {
      e.stopPropagation();
      stack.visible = chk.checked;
      render();
      buildStacksList();
    });

    const name = document.createElement('div');
    name.className = 'stack-name';
    name.textContent = stack.name;

    const coords = document.createElement('div');
    coords.className = 'stack-coords';
    coords.textContent = `${stack.lat.toFixed(2)}, ${stack.lng.toFixed(2)}`;

    const delBtn = document.createElement('button');
    delBtn.className = 'btn-del-stack';
    delBtn.title = 'Delete stack';
    delBtn.textContent = '✕';
    delBtn.addEventListener('click', e => {
      e.stopPropagation();
      if(STACKS.length <= 1){ return; } // keep at least one
      STACKS = STACKS.filter(s=>s.id!==stack.id);
      if(SELECTED_STACK_ID === stack.id) SELECTED_STACK_ID = null;
      rebuildState();
      updateStackConfigPanel();
    });

    row.appendChild(chk);
    row.appendChild(name);
    row.appendChild(coords);
    row.appendChild(delBtn);

    row.addEventListener('click', (e) => {
      if(e.target === chk || e.target === delBtn) return;
      if(SELECTED_STACK_ID === stack.id){
        // Deselect
        SELECTED_STACK_ID = null;
      } else {
        SELECTED_STACK_ID = stack.id;
      }
      buildStacksList();
      updateStackConfigPanel();
    });

    cont.appendChild(row);
  });
}

function updateStackConfigPanel(){
  const panel = document.getElementById('stack-config-panel');
  const stack = getSelectedStack();

  if(!stack){
    panel.style.display = 'none';
    return;
  }

  panel.style.display = 'block';
  document.getElementById('stack-config-name').textContent = stack.name;
  document.getElementById('inp-lat').value = stack.lat.toFixed(5);
  document.getElementById('inp-lng').value = stack.lng.toFixed(5);
  document.getElementById('inp-stack-name').value = stack.name;
  buildLayerEditor();
}

function addStack(){
  const ref = STACKS[0];
  const newLat = ref ? ref.lat + 0.05 : BASE_LAT;
  const newLng = ref ? ref.lng + 0.05 : BASE_LNG;
  const stackIdx = _idCounter++;
  const newStack = {
    id: 'stack_' + stackIdx,
    name: 'Stack ' + STACKS.length,
    lat: newLat,
    lng: newLng,
    visible: true,
    layers: deepClone(DEFAULT_LAYERS_TEMPLATE).map(l => ({ ...l, id: l.id + '_s' + stackIdx })),
  };
  STACKS.push(newStack);
  SELECTED_STACK_ID = newStack.id;
  rebuildState();
  updateStackConfigPanel();
}

// ═══════════════════════════════════════════════════════════
//  LAYER EDITOR (for selected stack)
// ═══════════════════════════════════════════════════════════
function buildLayerEditor(){
  const cont = document.getElementById('layer-editor'); cont.innerHTML = '';
  const stack = getSelectedStack(); if(!stack) return;

  stack.layers.forEach((cfg, idx) => {
    const mid = lerpColor(cfg.palette, .5);
    const colorHex = rgbToHex(...mid);
    const card = document.createElement('div'); card.className = 'layer-card';

    card.innerHTML = `
      <div class="layer-card-header">
        <input type="checkbox" class="layer-vis-check" ${cfg.visible?'checked':''}>
        <div class="card-label">${cfg.label}</div>
        <div class="card-sub">${(cfg.altitude/1e3).toFixed(0)}km·r${cfg.resolution}</div>
        <span class="toggle-arrow">▶</span>
        <button class="btn-del" title="Delete">✕</button>
      </div>
      <div class="layer-card-body">
        <div class="field-row"><label>Label</label><input type="text" class="f-label" value="${cfg.label}"></div>
        <div class="field-row">
          <label>Altitude</label>
          <div class="number-input-wrapper">
            <input type="number" class="f-alt" value="${cfg.altitude}" min="0" step="500">
            <div class="spinner-btns">
              <div class="spinner-btn" data-delta="-500">−</div>
              <div class="spinner-btn" data-delta="500">+</div>
            </div>
          </div>
        </div>
        <div class="field-row">
          <label>Res</label>
          <div class="number-input-wrapper">
            <input type="number" class="f-res" value="${cfg.resolution}" min="0" max="15" step="1">
            <div class="spinner-btns">
              <div class="spinner-btn" data-delta="-1">−</div>
              <div class="spinner-btn" data-delta="1">+</div>
            </div>
          </div>
        </div>
        <div class="field-row">
          <label>Radius km</label>
          <div class="number-input-wrapper">
            <input type="number" class="f-rad" value="${cfg.radiusKm}" min="1" step="1">
            <div class="spinner-btns">
              <div class="spinner-btn" data-delta="-1">−</div>
              <div class="spinner-btn" data-delta="1">+</div>
            </div>
          </div>
        </div>
        <div class="field-row">
          <label>Color</label>
          <input type="color" class="f-color" value="${cfg.baseColor||rgbToHex(...mid)}">
          <span style="font-size:9px;color:rgba(255,255,255,0.28)">base hue</span>
        </div>
        <button class="apply-btn">Apply</button>
      </div>`;

    // Color the checkbox
    const visChk = card.querySelector('.layer-vis-check');
    visChk.style.background = cfg.visible ? colorHex : 'transparent';
    visChk.style.borderColor = colorHex;
    visChk.addEventListener('change', e => {
      e.stopPropagation();
      cfg.visible = visChk.checked;
      visChk.style.background = cfg.visible ? colorHex : 'transparent';
      render();
    });

    const hdr = card.querySelector('.layer-card-header');
    const body = card.querySelector('.layer-card-body');
    const arrow = card.querySelector('.toggle-arrow');
    hdr.addEventListener('click', e => {
      if(e.target.classList.contains('btn-del') || e.target.classList.contains('layer-vis-check')) return;
      const o = body.classList.toggle('open');
      arrow.style.transform = o ? 'rotate(90deg)' : 'rotate(0)';
    });

    card.querySelector('.btn-del').addEventListener('click', () => {
      stack.layers.splice(idx, 1);
      rebuildState();
    });

    const applyBtn = card.querySelector('.apply-btn');
    applyBtn.addEventListener('click', () => {
      const label    = card.querySelector('.f-label').value.trim();
      const altitude = parseFloat(card.querySelector('.f-alt').value);
      const resolution = parseInt(card.querySelector('.f-res').value);
      const radiusKm = parseFloat(card.querySelector('.f-rad').value);
      const baseColor = card.querySelector('.f-color').value;
      if(label) cfg.label = label;
      if(!isNaN(altitude))   cfg.altitude   = altitude;
      if(!isNaN(resolution)) cfg.resolution = Math.min(15, Math.max(0, resolution));
      if(!isNaN(radiusKm))   cfg.radiusKm   = radiusKm;
      if(baseColor){ cfg.baseColor = baseColor; cfg.palette = generatePalette(baseColor); }
      rebuildState();
    });

    card.querySelectorAll('.layer-card-body input').forEach(inp => {
      inp.addEventListener('keydown', e => { if(e.key==='Enter') applyBtn.click(); });
    });

    card.querySelector('.f-color').addEventListener('input', e => {
      const m = lerpColor(generatePalette(e.target.value), .5);
      // Update checkbox preview color
      const vc = card.querySelector('.layer-vis-check');
      const hex = rgbToHex(...m);
      vc.style.borderColor = hex;
      if(vc.checked) vc.style.background = hex;
    });

    cont.appendChild(card);
  });
}

// ═══════════════════════════════════════════════════════════
//  NUMBER SPINNERS (delegated)
// ═══════════════════════════════════════════════════════════
document.addEventListener('click', e => {
  if(!e.target.classList.contains('spinner-btn')) return;
  const wrapper = e.target.closest('.number-input-wrapper'); if(!wrapper) return;
  const inp = wrapper.querySelector('input[type=number]');
  const delta = parseFloat(e.target.dataset.delta);
  inp.value = (parseFloat(inp.value)||0) + delta;
  inp.dispatchEvent(new Event('input', {bubbles:true}));
});

// ═══════════════════════════════════════════════════════════
//  BACKGROUND / WATER COLOR
// ═══════════════════════════════════════════════════════════
function applyBgColor(){
  document.getElementById('map').style.background = BG_COLOR;
  if(map.isStyleLoaded()){ map.setPaintProperty('water','fill-color', BG_COLOR); }
  document.getElementById('bg-color-picker').value = BG_COLOR;
}
function updateBgLabel(){
  document.getElementById('bg-section-label').textContent = SHOW_MAP ? 'Water color' : 'Background color';
}

// ═══════════════════════════════════════════════════════════
//  CENTER COLOR
// ═══════════════════════════════════════════════════════════
function getDefaultCenterColor(){
  for(const stack of STACKS){
    const ref = stack.layers.find(l=>l.visible) || stack.layers[0];
    if(ref) return rgbToHex(...lerpColor(ref.palette, 0));
  }
  return COLOR_BLACK;
}
function applyCenterColor(colorHex){
  CENTER_COLOR = colorHex;
  document.getElementById('center-color-picker').value = colorHex || getDefaultCenterColor();
  render();
}
function resetCenterColorToDefault(){
  CENTER_COLOR = null;
  document.getElementById('center-color-picker').value = COLOR_WHITE;
  render();
}

// ═══════════════════════════════════════════════════════════
//  MAP VISIBILITY
// ═══════════════════════════════════════════════════════════
function applyMapVisibility(){
  document.getElementById('basemap').style.opacity = SHOW_MAP ? '1' : '0';
  deckgl.setProps({ controller:{ maxPitch: SHOW_MAP ? 60 : 179 } });
  updateBgLabel(); applyBgColor();
}

// ═══════════════════════════════════════════════════════════
//  APPLY STACK POSITION
// ═══════════════════════════════════════════════════════════
function applyStackPosition(){
  const stack = getSelectedStack(); if(!stack) return;
  const lat = parseFloat(document.getElementById('inp-lat').value);
  const lng = parseFloat(document.getElementById('inp-lng').value);
  if(isNaN(lat)||isNaN(lng)) return;
  stack.lat = Math.max(-90, Math.min(90, lat));
  stack.lng = Math.max(-180, Math.min(180, lng));
  rebuildState();
  buildStacksList();
  document.getElementById('inp-lat').value = stack.lat;
  document.getElementById('inp-lng').value = stack.lng;
}

function applyStackName(){
  const stack = getSelectedStack(); if(!stack) return;
  const name = document.getElementById('inp-stack-name').value.trim();
  if(!name) return;
  stack.name = name;
  document.getElementById('stack-config-name').textContent = name;
  buildStacksList();
}

// ═══════════════════════════════════════════════════════════
//  VIEW RESET
// ═══════════════════════════════════════════════════════════
function resetView(){
  const { FlyToInterpolator } = deck;
  const DURATION = 700;
  // Find overall bounding box of all visible stacks
  const visStacks = STACKS.filter(s=>s.visible);
  if(!visStacks.length) return;

  const lats = visStacks.map(s=>s.lat);
  const lngs = visStacks.map(s=>s.lng);
  const centerLat = (Math.min(...lats)+Math.max(...lats))/2;
  const centerLng = (Math.min(...lngs)+Math.max(...lngs))/2;

  const maxRadius = Math.max(
    haversineKm(centerLat, centerLng, Math.max(...lats), centerLng),
    haversineKm(centerLat, centerLng, centerLat, Math.max(...lngs)),
    ...visStacks.flatMap(s => s.layers.filter(l=>l.visible).map(l=>l.radiusKm))
  ) || 20;
  // add ~30% to include outermost stacks' radii fully
  const viewRadius = maxRadius * 1.5;

  const cosLat = Math.cos(centerLat * Math.PI / 180);
  const viewSize = Math.min(window.innerWidth, window.innerHeight);
  const zoom = Math.log2((40075 * cosLat * 0.40 * viewSize) / (256 * 2 * viewRadius));

  currentViewState = {
    ...currentViewState,
    longitude: centerLng, latitude: centerLat,
    zoom: Math.max(3, Math.min(zoom, 16)),
    pitch: 60, bearing: DEFAULT_INIT_VIEW.bearing,
    transitionDuration: DURATION,
    transitionInterpolator: new FlyToInterpolator({ speed: 1.5 }),
  };
  deckgl.setProps({ viewState: currentViewState });
  map.flyTo({ center:[centerLng,centerLat], zoom:currentViewState.zoom, pitch:60, bearing:currentViewState.bearing, duration:DURATION });
}

// ═══════════════════════════════════════════════════════════
//  SAVE / LOAD / RESTORE
// ═══════════════════════════════════════════════════════════
function loadSavedConfigs(){ try{ return JSON.parse(localStorage.getItem(STORAGE_KEY)||'[]'); }catch(e){ return []; } }
function persistConfigs(list){ localStorage.setItem(STORAGE_KEY, JSON.stringify(list)); }

function saveConfig(name){
  if(!name||!name.trim()) return;
  const list = loadSavedConfigs();
  const entry = {
    id: Date.now(), name: name.trim(), date: new Date().toLocaleDateString('fr-FR'),
    stacks: deepClone(STACKS),
    opts: { showFlow:SHOW_FLOW, showMap:SHOW_MAP, bgColor:BG_COLOR, centerColor:CENTER_COLOR },
  };
  const ex = list.findIndex(c=>c.name===entry.name);
  if(ex>=0) list[ex]=entry; else list.push(entry);
  persistConfigs(list); buildSavePanel();
}

function loadConfig(id){
  const entry = loadSavedConfigs().find(c=>c.id===id); if(!entry) return;
  // Support both old format (layers) and new (stacks)
  if(entry.stacks){
    STACKS = deepClone(entry.stacks);
    STACKS.forEach(s=>{ s.layers.forEach(l=>{ if(l.visible===undefined) l.visible=true; }); if(s.visible===undefined) s.visible=true; });
  } else if(entry.layers) {
    // Legacy single-stack fallback
    STACKS = [{
      id:'stack_legacy', name:'Imported', lat:entry.opts?.centerLat||BASE_LAT,
      lng:entry.opts?.centerLng||BASE_LNG, visible:true,
      layers:deepClone(entry.layers).map(l=>{ if(l.visible===undefined) l.visible=true; return l; }),
    }];
  }
  SELECTED_STACK_ID = null;
  if(entry.opts){
    SHOW_FLOW = entry.opts.showFlow ?? SHOW_FLOW;
    SHOW_MAP  = entry.opts.showMap  ?? SHOW_MAP;
    BG_COLOR  = entry.opts.bgColor  ?? BG_COLOR;
    CENTER_COLOR = entry.opts.centerColor !== undefined ? entry.opts.centerColor : CENTER_COLOR;
    document.getElementById('chk-flow').checked = SHOW_FLOW;
    document.getElementById('chk-map').checked  = SHOW_MAP;
    applyMapVisibility();
  }
  rebuildState();
  updateStackConfigPanel();
  setTimeout(resetView, 50);
}

function deleteConfig(id){ persistConfigs(loadSavedConfigs().filter(c=>c.id!==id)); buildSavePanel(); }

function restoreDefaults(){
  const stack = getSelectedStack();
  if(stack){
    stack.layers = deepClone(DEFAULT_LAYERS_TEMPLATE).map(l=>({ ...l, id: l.id + '_' + stack.id }));
  } else {
    STACKS = buildDefaultStacks();
    SELECTED_STACK_ID = null;
    updateStackConfigPanel();
  }
  rebuildState();
}

function buildSavePanel(){
  const cont = document.getElementById('save-panel'); cont.innerHTML = '';
  const list = loadSavedConfigs();
  if(!list.length){
    const h = document.createElement('div'); h.className='empty-hint'; h.textContent='No saved configurations yet.'; cont.appendChild(h); return;
  }
  list.forEach(entry=>{
    const row = document.createElement('div'); row.className='saved-config-row';
    row.innerHTML = `<div class="saved-config-name" title="${entry.name}">${entry.name}</div>
      <div class="saved-config-date">${entry.date}</div>
      <button class="btn-icon btn-load" title="Load">↓</button>
      <button class="btn-icon btn-erase" title="Delete">✕</button>`;
    row.querySelector('.btn-load').addEventListener('click', ()=>loadConfig(entry.id));
    row.querySelector('.btn-erase').addEventListener('click', ()=>deleteConfig(entry.id));
    cont.appendChild(row);
  });
}

// ═══════════════════════════════════════════════════════════
//  COLLAPSIBLE PANELS
// ═══════════════════════════════════════════════════════════
function setupCollapsible(titleId, bodyId, startOpen = false){
  const title = document.getElementById(titleId);
  const body  = document.getElementById(bodyId);
  const arrow = title.querySelector('.toggle-arrow');
  let open = startOpen;

  // Apply initial visual state
  body.style.display = open ? 'block' : 'none';
  arrow.style.transform = open ? 'rotate(90deg)' : 'rotate(0)';
  title.classList.toggle('open', open);

  title.addEventListener('click', ()=>{
    open = !open;
    body.style.display = open ? 'block' : 'none';
    arrow.style.transform = open ? 'rotate(90deg)' : 'rotate(0)';
    title.classList.toggle('open', open);
  });
}

// ═══════════════════════════════════════════════════════════
//  EVENT WIRING
// ═══════════════════════════════════════════════════════════
document.getElementById('btn-show-all-stacks').addEventListener('click', ()=>{
  STACKS.forEach(s=>{ s.visible=true; s.layers.forEach(l=>l.visible=true); });
  rebuildState();
});
document.getElementById('btn-hide-all-stacks').addEventListener('click', ()=>{
  STACKS.forEach(s=>{ s.visible=false; s.layers.forEach(l=>l.visible=false); });
  rebuildState();
});
document.getElementById('btn-add-stack').addEventListener('click', addStack);

document.getElementById('chk-flow').addEventListener('change', e=>{ SHOW_FLOW=e.target.checked; render(); });
document.getElementById('chk-map').addEventListener('change',  e=>{ SHOW_MAP=e.target.checked; applyMapVisibility(); });

document.getElementById('bg-color-picker').addEventListener('input',  e=>{ BG_COLOR=e.target.value; applyBgColor(); });
document.getElementById('btn-bg-white').addEventListener('click',    ()=>{ BG_COLOR=COLOR_WHITE; applyBgColor(); });
document.getElementById('btn-bg-default').addEventListener('click',  ()=>{ BG_COLOR=COLOR_DEFAULT_BG; applyBgColor(); });

document.getElementById('center-color-picker').addEventListener('input', e=>{ CENTER_COLOR=e.target.value; render(); });
document.getElementById('btn-center-black').addEventListener('click',   ()=>applyCenterColor(COLOR_BLACK));
document.getElementById('btn-center-default').addEventListener('click', ()=>resetCenterColorToDefault());

document.getElementById('btn-apply-center').addEventListener('click', applyStackPosition);
['inp-lat','inp-lng'].forEach(id=>{
  document.getElementById(id).addEventListener('keydown', e=>{ if(e.key==='Enter') applyStackPosition(); });
});

document.getElementById('btn-apply-stack-name').addEventListener('click', applyStackName);
document.getElementById('inp-stack-name').addEventListener('keydown', e=>{ if(e.key==='Enter') applyStackName(); });

document.getElementById('btn-deselect-stack').addEventListener('click', ()=>{
  SELECTED_STACK_ID = null;
  buildStacksList();
  updateStackConfigPanel();
});

document.getElementById('btn-add-layer').addEventListener('click', ()=>{
  const stack = getSelectedStack(); if(!stack) return;
  const last = stack.layers[stack.layers.length-1] || {altitude:0,resolution:7,radiusKm:10};
  const colors=['#e74c3c','#9b59b6','#f39c12','#1abc9c','#e67e22','#3498db'];
  const base = colors[stack.layers.length % colors.length];
  stack.layers.push({
    id: newLayerId(), label:'New Layer',
    altitude:(last.altitude||0)+5000, resolution:last.resolution,
    radiusKm:last.radiusKm+5, baseColor:base, palette:generatePalette(base), visible:true,
  });
  rebuildState();
  // Auto-open the last card
  const cards = document.querySelectorAll('.layer-card');
  if(cards.length){ const c=cards[cards.length-1]; c.querySelector('.layer-card-body').classList.add('open'); c.querySelector('.toggle-arrow').style.transform='rotate(90deg)'; }
});

document.getElementById('btn-restore').addEventListener('click', restoreDefaults);
document.getElementById('btn-reset-view').addEventListener('click', resetView);

document.getElementById('btn-save-cfg').addEventListener('click', ()=>{
  const name = document.getElementById('cfg-name-input').value.trim();
  if(!name){ document.getElementById('cfg-name-input').focus(); return; }
  saveConfig(name); document.getElementById('cfg-name-input').value = '';
});
document.getElementById('cfg-name-input').addEventListener('keydown', e=>{ if(e.key==='Enter') document.getElementById('btn-save-cfg').click(); });

// ═══════════════════════════════════════════════════════════
//  INIT MAP + DECK
// ═══════════════════════════════════════════════════════════
const map = new maplibregl.Map({
  container: 'basemap',
  style: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
  center: [DEFAULT_INIT_VIEW.longitude, DEFAULT_INIT_VIEW.latitude],
  zoom: DEFAULT_INIT_VIEW.zoom,
  pitch: DEFAULT_INIT_VIEW.pitch,
  bearing: DEFAULT_INIT_VIEW.bearing,
  interactive: false,
});

let currentViewState = { ...DEFAULT_INIT_VIEW };

const deckgl = new Deck({
  canvas: 'deck-canvas', width:'100%', height:'100%',
  viewState: currentViewState,
  controller: { maxPitch:60 },
  views: new MapView({ repeat:false }),
  layers: [],
  onViewStateChange: ({viewState})=>{
    currentViewState = viewState;
    deckgl.setProps({ viewState: currentViewState });
    map.jumpTo({ center:[viewState.longitude,viewState.latitude], zoom:viewState.zoom, pitch:viewState.pitch, bearing:viewState.bearing });
  },
});

map.on('load', ()=>{
  document.getElementById('chk-flow').checked = SHOW_FLOW;
  document.getElementById('chk-map').checked  = SHOW_MAP;
  applyMapVisibility(); applyBgColor(); updateBgLabel();
  document.getElementById('center-color-picker').value = COLOR_WHITE;
  setupCollapsible('global-panel-title', 'global-panel-body', true);
  setupCollapsible('saves-panel-title', 'saves-panel-body', false);
  buildSavePanel();
  rebuildState();
  updateStackConfigPanel();
  setTimeout(resetView, 100);
});
