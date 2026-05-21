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
const STORAGE_KEY      = 'hex3d_saved_configs';

const COLOR_WHITE      = '#ffffff';
const COLOR_BLACK      = '#000000';
const COLOR_DEFAULT_BG = '#1a3a4a';

const DEFAULT_INIT_VIEW = { longitude:-6.7, latitude:48.13, zoom:10, pitch:60, bearing:-20 };

const DEFAULT_LAYERS = [
  { id:'surface', label:'Surface',        altitude:0,     resolution:8, radiusKm:10, baseColor:'#4aaeff', palette:[[0,60,160],[40,130,220],[180,220,255]], visible:true },
  { id:'mid',     label:'Mid Altitude',   altitude:5000,  resolution:7, radiusKm:12, baseColor:'#14aabc', palette:[[0,100,120],[20,170,190],[160,235,245]], visible:true },
  { id:'upper',   label:'Upper Altitude', altitude:15000, resolution:7, radiusKm:18, baseColor:'#28c89b', palette:[[0,130,100],[40,200,160],[180,245,225]], visible:true },
];

// ── Mutable state ─────────────────────────────────────────
let CENTER_LAT   = DEFAULT_INIT_VIEW.latitude;
let CENTER_LNG   = DEFAULT_INIT_VIEW.longitude;
let FLAT_LAYERS  = deepClone(DEFAULT_LAYERS);
let ALL_DATA     = [];
let hovered      = [];
let SHOW_FLOW    = false;
let SHOW_MAP     = false;
let SHOW_AXIS    = false;
let SHOW_SCI     = false;
let SCI_SIDE     = 'left';
let SCI_SCALE    = 1.0;
let SCI_BG_COLOR = null; // null = default dark transparent
let BG_COLOR     = COLOR_WHITE;
let CENTER_COLOR = null;
let _idCounter   = 100;

let _lastHoverInfo = null;
let _lastHoverCfg  = null;

// Axis drag state
let _axisDragging  = false;
let _axisOffsetX   = 0; // custom offset from default anchor, in CSS px
let _axisOffsetY   = 0;

// ── Map viewport dimensions (excludes sidebar) ────────────
function mapW(){ return document.getElementById('map-viewport').clientWidth; }
function mapH(){ return document.getElementById('map-viewport').clientHeight; }

// ═══════════════════════════════════════════════════════════
//  UTILITIES
// ═══════════════════════════════════════════════════════════
function deepClone(o){ return JSON.parse(JSON.stringify(o)); }
function newLayerId(){ return 'L' + (_idCounter++); }
function hexToRgb(h){ return [parseInt(h.slice(1,3),16), parseInt(h.slice(3,5),16), parseInt(h.slice(5,7),16)]; }
function rgbToHex(r,g,b){ return '#'+[r,g,b].map(v=>v.toString(16).padStart(2,'0')).join(''); }

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
  return R*2*Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
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
  const ctr = h3.latLngToCell(lat,lng,res);
  const k = Math.ceil(rKm/(h3.getHexagonEdgeLengthAvg(res,'km')*1.5))+1;
  return h3.gridDisk(ctr,k).filter(c=>{ const[la,ln]=h3.cellToLatLng(c); return haversineKm(lat,lng,la,ln)<=rKm; });
}

function shrinkPoly(poly,cx,cy,f){ return poly.map(([x,y,z])=>[cx+(x-cx)*f, cy+(y-cy)*f, z]); }

function getNeighbourFlow(cell){
  const nb = h3.gridDisk(cell,1).filter(c=>c!==cell);
  const raw = nb.map(n=>Math.max(0.01, stableValue(cell+':'+n)));
  const sum = raw.reduce((a,b)=>a+b,0);
  return nb.map((c,i)=>{ const[la,ln]=h3.cellToLatLng(c); return{cell:c,pct:(raw[i]/sum)*100,lat:la,lng:ln}; });
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

function buildData(cfg){
  const centerCell = h3.latLngToCell(CENTER_LAT, CENTER_LNG, cfg.resolution);
  return getCellsInRadius(CENTER_LAT, CENTER_LNG, cfg.radiusKm, cfg.resolution).map(cell=>{
    const [cLat,cLng] = h3.cellToLatLng(cell);
    const tDist = Math.min(haversineKm(CENTER_LAT,CENTER_LNG,cLat,cLng)/cfg.radiusKm, 1);
    const isCenter = (cell === centerCell);
    return {
      cell,
      poly3d: shrinkPoly(cellToXYZ(cell,cfg.altitude), cLng, cLat, COVERAGE),
      poly2d: h3.cellToBoundary(cell).map(([la,ln])=>[ln,la]),
      rgb: lerpColor(cfg.palette, tDist), alpha:GLOBAL_ALPHA, tDist, cLat, cLng, isCenter,
    };
  });
}

// ═══════════════════════════════════════════════════════════
//  DECK.GL LAYER FACTORIES
// ═══════════════════════════════════════════════════════════
const { Deck, PolygonLayer, TextLayer, MapView } = deck;

function makeFlatLayer(cfg, data, idx){
  if(!cfg.visible) return null;
  return new PolygonLayer({
    id:`flat-${cfg.id}`, data, pickable:true, filled:true, stroked:false, extruded:false, positionFormat:'XYZ',
    getPolygon: d => hovered[idx]===d.cell ? d.poly2d.map(([ln,la])=>[ln,la,cfg.altitude]) : d.poly3d,
    getFillColor: d => {
      if(hovered[idx]===d.cell) return HIGHLIGHT_HEXA;
      if(d.isCenter && CENTER_COLOR !== null) return [...hexToRgb(CENTER_COLOR), d.alpha];
      return [...d.rgb, d.alpha];
    },
    onHover: info => {
      const prev = hovered[idx];
      hovered[idx] = info.object?.cell ?? null;
      if(prev !== hovered[idx]) render();
      _lastHoverInfo = info.object ? info : null;
      _lastHoverCfg  = info.object ? cfg  : null;
      showTip(info, cfg);
      updateSciHexPanel();
    },
    onClick: info => {
      if(!info.object) return;
      navigator.clipboard.writeText(info.object.cell);
      const el  = document.getElementById('tooltip');
      const cid = el.querySelector('.cell-id');
      if(cid){ cid.textContent='✓ Copied!'; setTimeout(()=>{ cid.textContent=info.object.cell; }, 1200); }
    },
    updateTriggers:{ getFillColor:[hovered[idx],CENTER_COLOR], getPolygon:hovered[idx] },
  });
}

function makePrismLayer(cfg, data, lo, hi, idx, valid){
  const cell  = (valid && cfg.visible) ? hovered[idx] : null;
  const items = cell ? data.filter(d=>d.cell===cell) : [];
  const elevation = (valid && hi>lo) ? hi-lo : 0;
  return new PolygonLayer({
    id:`prism-${cfg.id}`, data:items, pickable:false, filled:true, stroked:false, extruded:true, wireframe:false, positionFormat:'XYZ',
    getPolygon:  d => d.poly2d.map(([ln,la])=>[ln,la,lo]),
    getElevation: elevation,
    getFillColor: d => [...d.rgb, 125],
    updateTriggers:{ data:cell, lo, hi },
  });
}

function makeArrowLayer(cfg, data, idx){
  if(!SHOW_FLOW || !cfg.visible) return null;
  const cell = hovered[idx]; if(!cell) return null;
  const hov  = data.find(d=>d.cell===cell); if(!hov) return null;
  const flow = getNeighbourFlow(cell);
  const alt  = cfg.altitude + 10;
  const eM   = h3.getHexagonEdgeLengthAvg(cfg.resolution,'m');
  const maxW = eM*ARROW_MAX_FACTOR, minW = eM*ARROW_MIN_FACTOR;
  const ad   = flow.map(f=>({ polygon:makeArrowPoly(hov.cLng,hov.cLat,f.lng,f.lat, minW+(f.pct/100)*(maxW-minW), alt), pct:f.pct }));
  const cr=eM*0.4, dpm=1/111000, cl=Math.cos(hov.cLat*Math.PI/180);
  ad.push({ polygon:Array.from({length:32},(_,i)=>{ const a=(i/32)*2*Math.PI; return [hov.cLng+(Math.cos(a)*cr*dpm)/cl, hov.cLat+Math.sin(a)*cr*dpm, alt]; }), pct:0 });
  return new PolygonLayer({ id:`arrows-${cfg.id}`, data:ad, pickable:false, filled:true, stroked:false, extruded:false, positionFormat:'XYZ', getPolygon:d=>d.polygon, getFillColor:[...ARROW_COLOR,ARROW_ALPHA], updateTriggers:{data:cell} });
}

function makeArrowLabelLayer(cfg, data, idx){
  if(!SHOW_FLOW || !cfg.visible) return null;
  const cell = hovered[idx]; if(!cell) return null;
  const hov  = data.find(d=>d.cell===cell); if(!hov) return null;
  const flow = getNeighbourFlow(cell);
  const textSize = h3.getHexagonEdgeLengthAvg(cfg.resolution,'m') * 0.30;
  return new TextLayer({
    id:`lbl-${cfg.id}`,
    data: flow.map(f=>({ position:[f.lng,f.lat,cfg.altitude+200], text:f.pct.toFixed(ARROW_DECIMALS)+'%' })),
    pickable:false, getPosition:d=>d.position, getText:d=>d.text,
    sizeUnits:'meters', getSize:textSize,
    getColor:LABEL_COLOR, fontFamily:'JetBrains Mono,monospace', fontWeight:'bold',
    billboard:true, getTextAnchor:'middle', getAlignmentBaseline:'center',
    fontSettings:{sdf:true}, outlineWidth:3, outlineColor:[0,0,0,200],
    updateTriggers:{data:cell},
  });
}

// ═══════════════════════════════════════════════════════════
//  3D AXES  (canvas overlay inside map-viewport)
// ═══════════════════════════════════════════════════════════
function getOrCreateAxisCanvas(){
  let c = document.getElementById('axis-canvas');
  if(!c){
    c = document.createElement('canvas');
    c.id = 'axis-canvas';
    c.style.cssText = 'position:absolute;inset:0;z-index:2;pointer-events:none;';
    document.getElementById('map-viewport').appendChild(c);
  }
  return c;
}

function drawAxisOverlay(){
  const c = getOrCreateAxisCanvas();
  const W = mapW(), H = mapH();
  const dpr = window.devicePixelRatio || 1;
  c.width  = W * dpr; c.height = H * dpr;
  c.style.width = W+'px'; c.style.height = H+'px';

  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  if(!SHOW_AXIS) return;

  // Default anchor: equidistant from left and bottom edges of map viewport
  const LEN = 70;
  const D   = LEN + 30;
  const defaultX = D, defaultY = H - D;
  const anchorX = defaultX + _axisOffsetX;
  const anchorY = defaultY + _axisOffsetY;
  // Store for hit-testing in drag handler
  drawAxisOverlay._anchorX = anchorX;
  drawAxisOverlay._anchorY = anchorY;

  const bearing  = (currentViewState.bearing || 0) * Math.PI / 180;
  const pitch    = (currentViewState.pitch   || 0) * Math.PI / 180;
  const cosPitch = Math.cos(pitch);
  const sinPitch = Math.sin(pitch);

  function project(dx, dy, dz){
    const rx =  dx * Math.cos(-bearing) + dy * Math.sin(-bearing);
    const ry = -dx * Math.sin(-bearing) + dy * Math.cos(-bearing);
    return { sx: anchorX + rx*LEN, sy: anchorY + (-ry*cosPitch - dz*sinPitch)*LEN };
  }

  const bg = hexToRgb(BG_COLOR);
  const glowColor = `rgba(${255-bg[0]},${255-bg[1]},${255-bg[2]},0.55)`;

  const O = { sx:anchorX, sy:anchorY };
  const axes = [
    { dir:[1,0,0], label:'X', color:'#ff4444' },
    { dir:[0,1,0], label:'Y', color:'#44dd66' },
    { dir:[0,0,1], label:'Z', color:'#4499ff' },
  ];
  const proj = axes.map(ax=>({...ax, E:project(...ax.dir)}));
  proj.sort((a,b)=>(b.E.sy-O.sy)-(a.E.sy-O.sy));

  proj.forEach(({E, color, label})=>{
    const angle = Math.atan2(E.sy-O.sy, E.sx-O.sx);
    ctx.save(); ctx.shadowColor=glowColor; ctx.shadowBlur=10;
    ctx.beginPath(); ctx.moveTo(O.sx,O.sy); ctx.lineTo(E.sx,E.sy);
    ctx.strokeStyle=color; ctx.lineWidth=3; ctx.lineCap='round'; ctx.stroke();
    ctx.restore();
    ctx.beginPath(); ctx.moveTo(O.sx,O.sy); ctx.lineTo(E.sx,E.sy);
    ctx.strokeStyle=color; ctx.lineWidth=2.5; ctx.lineCap='round'; ctx.stroke();
    const hw=9;
    ctx.beginPath(); ctx.moveTo(E.sx,E.sy);
    ctx.lineTo(E.sx-hw*Math.cos(angle-0.40), E.sy-hw*Math.sin(angle-0.40));
    ctx.lineTo(E.sx-hw*Math.cos(angle+0.40), E.sy-hw*Math.sin(angle+0.40));
    ctx.closePath(); ctx.fillStyle=color; ctx.fill();
    const lx=E.sx+12*Math.cos(angle), ly=E.sy+12*Math.sin(angle)+4;
    ctx.font='bold 13px "JetBrains Mono",monospace';
    ctx.save(); ctx.shadowColor=glowColor; ctx.shadowBlur=8;
    ctx.fillStyle=color; ctx.fillText(label,lx,ly); ctx.restore();
    ctx.fillStyle=color; ctx.fillText(label,lx,ly);
  });
  ctx.save(); ctx.shadowColor=glowColor; ctx.shadowBlur=10;
  ctx.beginPath(); ctx.arc(O.sx,O.sy,5,0,Math.PI*2);
  ctx.fillStyle='#ffffff'; ctx.fill(); ctx.restore();
  ctx.beginPath(); ctx.arc(O.sx,O.sy,5,0,Math.PI*2);
  ctx.fillStyle='#ffffff'; ctx.fill();
}

// ═══════════════════════════════════════════════════════════
//  RENDER
// ═══════════════════════════════════════════════════════════
function render(){
  const layers=[], GAP=5;
  const byAlt=[...FLAT_LAYERS].sort((a,b)=>a.altitude-b.altitude);
  FLAT_LAYERS.forEach((cfg,i)=>{
    let lo=0,hi=0,valid=false;
    if(cfg.altitude!==0){
      if(cfg.altitude>0){
        const below=byAlt.filter(l=>l.altitude<cfg.altitude);
        if(below.length){ const nb=below[below.length-1]; const a=nb.altitude+GAP,b=cfg.altitude-GAP; if(b>a){lo=a;hi=b;valid=true;} }
      } else {
        const above=byAlt.filter(l=>l.altitude>cfg.altitude);
        if(above.length){ const nb=above[0]; const a=cfg.altitude+GAP,b=nb.altitude-GAP; if(b>a){lo=a;hi=b;valid=true;} }
      }
    }
    layers.push(makePrismLayer(cfg,ALL_DATA[i],lo,hi,i,valid));
    const flat=makeFlatLayer(cfg,ALL_DATA[i],i); if(flat) layers.push(flat);
    const a=makeArrowLayer(cfg,ALL_DATA[i],i); if(a) layers.push(a);
    const l=makeArrowLabelLayer(cfg,ALL_DATA[i],i); if(l) layers.push(l);
  });
  deckgl.setProps({layers});
  drawAxisOverlay();
}

// ═══════════════════════════════════════════════════════════
//  TOOLTIP
// ═══════════════════════════════════════════════════════════
function showTip(info, cfg){
  const el=document.getElementById('tooltip');
  if(SHOW_SCI){ el.style.display='none'; return; }
  if(!info.object){ el.style.display='none'; return; }
  const d=info.object;
  el.innerHTML=`
    <div class="tip-label">Layer</div><div class="tip-val">${cfg.label}</div>
    <div class="tip-label">Altitude</div><div class="tip-val">${(cfg.altitude/1000).toFixed(1)} km</div>
    <div class="tip-label">Distance from center</div><div class="tip-val">${(d.tDist*cfg.radiusKm).toFixed(1)} km</div>
    <div class="tip-label">H3 cell</div><div class="tip-val cell-id" style="font-size:9px;letter-spacing:.05em">${d.cell}</div>`;
  el.style.display='block';
}

// ═══════════════════════════════════════════════════════════
//  SCIENTIFIC FIGURE PANELS
// ═══════════════════════════════════════════════════════════
function applySciScale(scale){
  SCI_SCALE = scale;
  document.getElementById('sci-column').style.setProperty('--sci-scale', scale);
  document.getElementById('sci-column').style.width = Math.round(260 * scale) + 'px';
}

// ── Sci panel adaptive colors ─────────────────────────────
// Computes perceived luminance of the blended panel+map background
// and sets text and border colors for maximum readability.
function sciPanelTextColors(){
  // Panel bg: SCI_BG_COLOR at alpha 0.72, over map BG_COLOR
  const panelRgb = SCI_BG_COLOR === null
    ? [8,10,20]
    : hexToRgb(SCI_BG_COLOR);
  const bgRgb = hexToRgb(BG_COLOR);
  const a = 0.72;
  // Alpha composite
  const blended = panelRgb.map((c,i) => Math.round(c*a + bgRgb[i]*(1-a)));
  // Relative luminance (WCAG formula)
  const lum = blended.map(c => {
    const s = c/255;
    return s <= 0.04045 ? s/12.92 : Math.pow((s+0.055)/1.055, 2.4);
  });
  const L = 0.2126*lum[0] + 0.7152*lum[1] + 0.0722*lum[2];
  // Dark bg → light text; light bg → dark text
  const isDark = L < 0.35;
  return {
    text:      isDark ? 'rgba(255,255,255,0.92)' : 'rgba(0,0,0,0.85)',
    textMuted: isDark ? 'rgba(255,255,255,0.50)' : 'rgba(0,0,0,0.45)',
    textDim:   isDark ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.30)',
    border:    isDark ? 'rgba(255,255,255,0.15)'  : 'rgba(0,0,0,0.18)',
    divider:   isDark ? 'rgba(255,255,255,0.10)'  : 'rgba(0,0,0,0.12)',
    titleBorder: isDark ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.22)',
  };
}

function applySciColors(){
  const c = sciPanelTextColors();
  const bgAlpha = SCI_BG_COLOR === null
    ? 'rgba(8,10,20,0.72)'
    : hexToRgba(SCI_BG_COLOR, 0.72);

  document.querySelectorAll('.sci-panel').forEach(p => {
    p.style.background   = bgAlpha;
    p.style.color        = c.text;
    p.style.borderColor  = c.border;
  });
  document.querySelectorAll('.sci-panel-title').forEach(el => {
    el.style.color       = c.textMuted;
    el.style.borderBottomColor = c.titleBorder;
  });
  document.querySelectorAll('.sci-meta-key, .sci-hex-key, .sci-layer-props').forEach(el => {
    el.style.color = c.textDim;
  });
  document.querySelectorAll('.sci-meta-val, .sci-hex-val, .sci-layer-name').forEach(el => {
    el.style.color = c.text;
  });
  document.querySelectorAll('.sci-layer-row').forEach(el => {
    el.style.borderBottomColor = c.divider;
  });
  // meta divider in sci-meta-block
  const mb = document.getElementById('sci-meta-block');
  if(mb) mb.style.borderBottomColor = c.divider;
}

function applySciBackground(colorHex){
  SCI_BG_COLOR = colorHex;
  if(colorHex !== null)
    document.getElementById('sci-bg-picker').value = colorHex;
  applySciColors();
}

function hexToRgba(hex, a){
  const [r,g,b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}

function updateSciPanel(){
  if(!SHOW_SCI) return;
  document.getElementById('sci-center-val').textContent =
    `${CENTER_LAT.toFixed(4)}° N, ${CENTER_LNG.toFixed(4)}° E`;
  const body=document.getElementById('sci-layers-body'); body.innerHTML='';
  [...FLAT_LAYERS].sort((a,b)=>b.altitude-a.altitude).forEach(cfg=>{
    if(!cfg.visible) return;
    const mid=lerpColor(cfg.palette,0.5);
    const row=document.createElement('div'); row.className='sci-layer-row';
    row.innerHTML=`
      <div class="sci-layer-swatch" style="background:rgb(${mid})"></div>
      <div class="sci-layer-name">${cfg.label}</div>
      <div class="sci-layer-props">${(cfg.altitude/1e3).toFixed(0)} km · rés.${cfg.resolution} · r ${cfg.radiusKm} km</div>`;
    body.appendChild(row);
  });
  if(SHOW_SCI) applySciColors();
}

function updateSciHexPanel(){
  const panel=document.getElementById('sci-hex-panel');
  const body=document.getElementById('sci-hex-body');
  if(!SHOW_SCI||!_lastHoverInfo||!_lastHoverCfg){ panel.classList.remove('visible'); return; }
  panel.classList.add('visible');
  const d=_lastHoverInfo.object, cfg=_lastHoverCfg;
  const edgeKm=h3.getHexagonEdgeLengthAvg(cfg.resolution,'km').toFixed(2);
  const areaKm2=h3.getHexagonAreaAvg(cfg.resolution,'km2').toFixed(2);
  body.innerHTML=`
    <div class="sci-hex-cell"><div class="sci-hex-key">Couche</div><div class="sci-hex-val">${cfg.label}</div></div>
    <div class="sci-hex-cell"><div class="sci-hex-key">Altitude</div><div class="sci-hex-val">${(cfg.altitude/1000).toFixed(1)} km</div></div>
    <div class="sci-hex-cell"><div class="sci-hex-key">Latitude</div><div class="sci-hex-val">${d.cLat.toFixed(4)}°</div></div>
    <div class="sci-hex-cell"><div class="sci-hex-key">Longitude</div><div class="sci-hex-val">${d.cLng.toFixed(4)}°</div></div>
    <div class="sci-hex-cell"><div class="sci-hex-key">Dist. centre</div><div class="sci-hex-val">${(d.tDist*cfg.radiusKm).toFixed(2)} km</div></div>
    <div class="sci-hex-cell"><div class="sci-hex-key">Résolution</div><div class="sci-hex-val">H3-${cfg.resolution}</div></div>
    <div class="sci-hex-cell"><div class="sci-hex-key">Arête moy.</div><div class="sci-hex-val">${edgeKm} km</div></div>
    <div class="sci-hex-cell"><div class="sci-hex-key">Aire moy.</div><div class="sci-hex-val">${areaKm2} km²</div></div>
    <div class="sci-hex-cell" style="grid-column:1/-1">
      <div class="sci-hex-key">Identifiant H3</div>
      <div class="sci-hex-val" style="font-size:calc(var(--sci-scale,1)*8.5px);letter-spacing:.05em;word-break:break-all">${d.cell}</div>
    </div>`;
  // Reapply colors to newly created elements
  if(SHOW_SCI) applySciColors();
}

function setSciPanelVisible(on){
  SHOW_SCI=on;
  const col=document.getElementById('sci-column');
  const opts=document.getElementById('sci-options');
  if(on){
    col.classList.add('active');
    col.classList.toggle('side-right', SCI_SIDE==='right');
    col.classList.toggle('side-left',  SCI_SIDE==='left');
    if(opts) opts.style.display='flex';
    document.getElementById('tooltip').style.display='none';
    applySciBackground(SCI_BG_COLOR);
    updateSciPanel(); updateSciHexPanel();
  } else {
    col.classList.remove('active');
    if(opts) opts.style.display='none';
  }
}

function applySciSide(side){
  SCI_SIDE=side;
  const col=document.getElementById('sci-column');
  col.classList.toggle('side-right', side==='right');
  col.classList.toggle('side-left',  side==='left');
  // Move tooltip to opposite side when sci panel is shown
  const tip=document.getElementById('tooltip');
  tip.style.left  = (side==='left')  ? 'auto' : '14px';
  tip.style.right = (side==='left')  ? '14px' : 'auto';
}

// ═══════════════════════════════════════════════════════════
//  LAYER EDITOR
// ═══════════════════════════════════════════════════════════
function rebuildState(){
  hovered=new Array(FLAT_LAYERS.length).fill(null);
  ALL_DATA=FLAT_LAYERS.map(cfg=>buildData(cfg));
  buildLayerEditor(); render(); updateSciPanel();
}

function applyLayerEdit(idx,f){
  const c=FLAT_LAYERS[idx];
  if(f.label) c.label=f.label;
  if(!isNaN(f.altitude)) c.altitude=f.altitude;
  if(!isNaN(f.resolution)) c.resolution=Math.min(15,Math.max(0,f.resolution));
  if(!isNaN(f.radiusKm)) c.radiusKm=f.radiusKm;
  if(f.baseColor){ c.baseColor=f.baseColor; c.palette=generatePalette(f.baseColor); }
  rebuildState();
}

function deleteLayer(idx){ FLAT_LAYERS.splice(idx,1); rebuildState(); }

function addLayer(){
  const last=FLAT_LAYERS[FLAT_LAYERS.length-1]||{altitude:0,resolution:7,radiusKm:10};
  const colors=['#e74c3c','#9b59b6','#f39c12','#1abc9c','#e67e22','#3498db'];
  const base=colors[FLAT_LAYERS.length%colors.length];
  const newId = newLayerId();
  FLAT_LAYERS.push({id:newId,label:'New Layer',altitude:(last.altitude||0)+5000,resolution:last.resolution,radiusKm:last.radiusKm+5,baseColor:base,palette:generatePalette(base),visible:true});
  rebuildState();
  const cards=document.querySelectorAll('.layer-card');
  const newIdx = [...document.querySelectorAll('.layer-card')].findIndex(c => c.dataset.layerId === newId);
  const target = newIdx >= 0 ? cards[newIdx] : cards[0];
  if(target){ target.querySelector('.layer-card-body').classList.add('open'); target.querySelector('.toggle-arrow').style.transform='rotate(90deg)'; }
}

function buildLayerEditor(){
  const cont=document.getElementById('layer-editor'); cont.innerHTML='';
  // Sort descending by altitude for display, but keep original index for edits
  const sorted=[...FLAT_LAYERS].sort((a,b)=>b.altitude-a.altitude);
  sorted.forEach((cfg)=>{
    const idx=FLAT_LAYERS.indexOf(cfg);
    const mid=lerpColor(cfg.palette,.5);
    const colorHex=rgbToHex(...mid);
    const card=document.createElement('div'); card.className='layer-card'; card.dataset.layerId=cfg.id;
    card.innerHTML=`
      <div class="layer-card-header">
        <input type="checkbox" class="layer-vis-check" ${cfg.visible?'checked':''}>
        <div class="card-label">${cfg.label}</div>
        <div class="card-sub">${(cfg.altitude/1e3).toFixed(0)}km·r${cfg.resolution}</div>
        <span class="toggle-arrow">▶</span>
        <button class="btn-del" title="Delete">✕</button>
      </div>
      <div class="layer-card-body">
        <div class="field-row"><label>Label</label><input type="text" class="f-label" value="${cfg.label}"></div>
        <div class="field-row"><label>Altitude</label>
          <div class="number-input-wrapper">
            <input type="number" class="f-alt" value="${cfg.altitude}" min="0" step="500">
            <div class="spinner-btns"><div class="spinner-btn" data-delta="-500">−</div><div class="spinner-btn" data-delta="500">+</div></div>
          </div>
        </div>
        <div class="field-row"><label>Res</label>
          <div class="number-input-wrapper">
            <input type="number" class="f-res" value="${cfg.resolution}" min="0" max="15" step="1">
            <div class="spinner-btns"><div class="spinner-btn" data-delta="-1">−</div><div class="spinner-btn" data-delta="1">+</div></div>
          </div>
        </div>
        <div class="field-row"><label>Radius km</label>
          <div class="number-input-wrapper">
            <input type="number" class="f-rad" value="${cfg.radiusKm}" min="1" step="1">
            <div class="spinner-btns"><div class="spinner-btn" data-delta="-1">−</div><div class="spinner-btn" data-delta="1">+</div></div>
          </div>
        </div>
        <div class="field-row"><label>Color</label>
          <input type="color" class="f-color" value="${cfg.baseColor||colorHex}">
          <span style="font-size:9px;color:rgba(255,255,255,0.28)">base hue</span>
        </div>
        <button class="apply-btn">Apply</button>
      </div>`;

    // Set colored checkbox appearance
    const visChk=card.querySelector('.layer-vis-check');
    visChk.style.borderColor=colorHex;
    visChk.style.background=cfg.visible?colorHex:'transparent';
    visChk.addEventListener('change',e=>{
      e.stopPropagation();
      cfg.visible=visChk.checked;
      visChk.style.background=cfg.visible?colorHex:'transparent';
      render(); updateSciPanel();
    });

    const hdr=card.querySelector('.layer-card-header');
    const body=card.querySelector('.layer-card-body');
    const arrow=card.querySelector('.toggle-arrow');
    hdr.addEventListener('click',e=>{
      if(e.target.classList.contains('btn-del')||e.target.classList.contains('layer-vis-check')) return;
      const o=body.classList.toggle('open'); arrow.style.transform=o?'rotate(90deg)':'rotate(0)';
    });
    card.querySelector('.btn-del').addEventListener('click',()=>deleteLayer(idx));
    const applyBtn=card.querySelector('.apply-btn');
    applyBtn.addEventListener('click',()=>{
      applyLayerEdit(idx,{
        label:card.querySelector('.f-label').value.trim(),
        altitude:parseFloat(card.querySelector('.f-alt').value),
        resolution:parseInt(card.querySelector('.f-res').value),
        radiusKm:parseFloat(card.querySelector('.f-rad').value),
        baseColor:card.querySelector('.f-color').value,
      });
    });
    card.querySelectorAll('.layer-card-body input').forEach(inp=>{ inp.addEventListener('keydown',e=>{ if(e.key==='Enter') applyBtn.click(); }); });
    card.querySelector('.f-color').addEventListener('input',e=>{
      const m=lerpColor(generatePalette(e.target.value),.5);
      const hex=rgbToHex(...m);
      visChk.style.borderColor=hex;
      if(visChk.checked) visChk.style.background=hex;
    });
    cont.appendChild(card);
  });
}

// ── Number spinners ───────────────────────────────────────
document.addEventListener('click',e=>{
  if(!e.target.classList.contains('spinner-btn')) return;
  const wrapper=e.target.closest('.number-input-wrapper'); if(!wrapper) return;
  const inp=wrapper.querySelector('input[type=number]');
  inp.value=(parseFloat(inp.value)||0)+parseFloat(e.target.dataset.delta);
  inp.dispatchEvent(new Event('input',{bubbles:true}));
});

// ═══════════════════════════════════════════════════════════
//  BACKGROUND / WATER COLOR
// ═══════════════════════════════════════════════════════════
function applyBgColor(){
  document.getElementById('map-viewport').style.background=BG_COLOR;
  if(map.isStyleLoaded()) map.setPaintProperty('water','fill-color',BG_COLOR);
  document.getElementById('bg-color-picker').value=BG_COLOR;
}
function updateBgLabel(){
  document.getElementById('bg-section-label').textContent=SHOW_MAP?'Water color':'Background color';
}

// ═══════════════════════════════════════════════════════════
//  CENTER COLOR
// ═══════════════════════════════════════════════════════════
function getDefaultCenterColor(){
  const ref=FLAT_LAYERS.find(l=>l.visible)||FLAT_LAYERS[0];
  if(!ref) return COLOR_BLACK;
  return rgbToHex(...lerpColor(ref.palette,0));
}
function applyCenterColor(colorHex){
  CENTER_COLOR=colorHex;
  document.getElementById('center-color-picker').value=colorHex||getDefaultCenterColor();
  render();
}
function resetCenterColorToDefault(){
  CENTER_COLOR=null;
  document.getElementById('center-color-picker').value=COLOR_WHITE;
  render();
}

// ═══════════════════════════════════════════════════════════
//  MAP VISIBILITY
// ═══════════════════════════════════════════════════════════
function applyMapVisibility(){
  document.getElementById('basemap').style.opacity=SHOW_MAP?'1':'0';
  deckgl.setProps({controller:{maxPitch:SHOW_MAP?60:179}});
  updateBgLabel(); applyBgColor();
}

// ═══════════════════════════════════════════════════════════
//  CENTER POSITION
// ═══════════════════════════════════════════════════════════
function applyCenter(lat,lng){
  CENTER_LAT=lat; CENTER_LNG=lng;
  document.getElementById('inp-lat').value=lat;
  document.getElementById('inp-lng').value=lng;
  currentViewState={
    ...currentViewState, longitude:lng, latitude:lat,
    transitionDuration:600,
    transitionInterpolator:new deck.FlyToInterpolator({speed:1.5}),
  };
  deckgl.setProps({viewState:currentViewState});
  map.flyTo({center:[lng,lat],duration:600});
  rebuildState(); updateSciPanel();
}

// ═══════════════════════════════════════════════════════════
//  VIEW RESET
// ═══════════════════════════════════════════════════════════
function resetView(){
  const {FlyToInterpolator}=deck, DURATION=700;
  const visibleLayers=FLAT_LAYERS.filter(c=>c.visible);
  const maxRadius=visibleLayers.length?Math.max(...visibleLayers.map(c=>c.radiusKm)):20;
  const cosLat=Math.cos(CENTER_LAT*Math.PI/180);
  const viewSize=Math.min(mapW(),mapH());
  const zoom=Math.log2((40075*cosLat*0.40*viewSize)/(256*2*maxRadius));
  currentViewState={
    ...currentViewState, longitude:CENTER_LNG, latitude:CENTER_LAT,
    zoom, pitch:60, bearing:DEFAULT_INIT_VIEW.bearing,
    transitionDuration:DURATION, transitionInterpolator:new FlyToInterpolator({speed:1.5}),
  };
  deckgl.setProps({viewState:currentViewState});
  map.flyTo({center:[CENTER_LNG,CENTER_LAT],zoom,pitch:60,bearing:currentViewState.bearing,duration:DURATION});
}

// ═══════════════════════════════════════════════════════════
//  SAVE / LOAD / RESTORE
// ═══════════════════════════════════════════════════════════
function loadSavedConfigs(){ try{ return JSON.parse(localStorage.getItem(STORAGE_KEY)||'[]'); } catch(e){ return []; } }
function persistConfigs(list){ localStorage.setItem(STORAGE_KEY,JSON.stringify(list)); }

function saveConfig(name){
  if(!name||!name.trim()) return;
  const list=loadSavedConfigs();
  const entry={
    id:Date.now(), name:name.trim(), date:new Date().toLocaleDateString('fr-FR'),
    layers:deepClone(FLAT_LAYERS),
    opts:{showFlow:SHOW_FLOW,showMap:SHOW_MAP,bgColor:BG_COLOR,centerLat:CENTER_LAT,centerLng:CENTER_LNG,centerColor:CENTER_COLOR},
  };
  const ex=list.findIndex(c=>c.name===entry.name);
  if(ex>=0) list[ex]=entry; else list.push(entry);
  persistConfigs(list); buildSavePanel();
}

function loadConfig(id){
  const entry=loadSavedConfigs().find(c=>c.id===id); if(!entry) return;
  FLAT_LAYERS=deepClone(entry.layers);
  FLAT_LAYERS.forEach(c=>{ if(c.visible===undefined) c.visible=true; });
  if(entry.opts){
    SHOW_FLOW=entry.opts.showFlow??SHOW_FLOW;
    SHOW_MAP=entry.opts.showMap??SHOW_MAP;
    BG_COLOR=entry.opts.bgColor??BG_COLOR;
    CENTER_COLOR=entry.opts.centerColor!==undefined?entry.opts.centerColor:CENTER_COLOR;
    document.getElementById('chk-flow').checked=SHOW_FLOW;
    document.getElementById('chk-map').checked=SHOW_MAP;
    applyMapVisibility();
    if(entry.opts.centerLat!=null){
      CENTER_LAT=entry.opts.centerLat; CENTER_LNG=entry.opts.centerLng;
      document.getElementById('inp-lat').value=CENTER_LAT;
      document.getElementById('inp-lng').value=CENTER_LNG;
    }
    rebuildState();
  } else { rebuildState(); }
  setTimeout(resetView,50);
}

function deleteConfig(id){ persistConfigs(loadSavedConfigs().filter(c=>c.id!==id)); buildSavePanel(); }
function restoreDefaults(){ FLAT_LAYERS=deepClone(DEFAULT_LAYERS); rebuildState(); }

function buildSavePanel(){
  const cont=document.getElementById('save-panel'); cont.innerHTML='';
  const list=loadSavedConfigs();
  if(!list.length){ const h=document.createElement('div'); h.className='empty-hint'; h.textContent='No saved configurations yet.'; cont.appendChild(h); return; }
  list.forEach(entry=>{
    const row=document.createElement('div'); row.className='saved-config-row';
    row.innerHTML=`
      <div class="saved-config-name" title="${entry.name}">${entry.name}</div>
      <div class="saved-config-date">${entry.date}</div>
      <button class="btn-icon btn-load" title="Load">↓</button>
      <button class="btn-icon btn-erase" title="Delete">✕</button>`;
    row.querySelector('.btn-load').addEventListener('click',()=>loadConfig(entry.id));
    row.querySelector('.btn-erase').addEventListener('click',()=>deleteConfig(entry.id));
    cont.appendChild(row);
  });
}

// ═══════════════════════════════════════════════════════════
//  SAVE VIEW — captures the current frame exactly as shown
// ═══════════════════════════════════════════════════════════
async function saveCurrentView(){
  const W = mapW(), H = mapH();

  deckgl.redraw(true);
  await new Promise(r => setTimeout(r, 60));

  const out = document.createElement('canvas');
  out.width  = W;
  out.height = H;
  const ctx  = out.getContext('2d');

  // Background
  ctx.fillStyle = BG_COLOR;
  ctx.fillRect(0, 0, W, H);

  // Basemap
  if(SHOW_MAP){
    try { const mc = map.getCanvas(); ctx.drawImage(mc, 0, 0, mc.width, mc.height, 0, 0, W, H); } catch(e){}
  }

  // Deck.gl
  try { const dc = document.getElementById('deck-canvas'); ctx.drawImage(dc, 0, 0, dc.width, dc.height, 0, 0, W, H); } catch(e){}

  // Axis
  if(SHOW_AXIS){
    const axCanvas = document.getElementById('axis-canvas');
    if(axCanvas) try { ctx.drawImage(axCanvas, 0, 0, axCanvas.width, axCanvas.height, 0, 0, W, H); } catch(e){}
  }

  // Sci panels
  if(SHOW_SCI){
    const vpRect = document.getElementById('map-viewport').getBoundingClientRect();
    for(const pid of ['sci-layers-panel', 'sci-hex-panel']){
      const el = document.getElementById(pid);
      if(!el || (pid === 'sci-hex-panel' && !el.classList.contains('visible'))) continue;
      try {
        const img = await html2canvas(el, { backgroundColor:null, scale:1, logging:false, useCORS:true });
        const rect = el.getBoundingClientRect();
        ctx.drawImage(img, rect.left - vpRect.left, rect.top - vpRect.top);
      } catch(e){ console.warn('sci panel capture failed', e); }
    }
  }

  out.toBlob(blob => {
    const url = URL.createObjectURL(blob);
    const a   = document.createElement('a');
    a.href     = url;
    a.download = `hex3d_${new Date().toISOString().slice(0,19).replace(/[:T]/g,'-')}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
    showSaveNotif();
  }, 'image/png');
}

function showSaveNotif(){
  const n=document.getElementById('save-notif');
  n.classList.add('show');
  setTimeout(()=>n.classList.remove('show'),2400);
}

// ═══════════════════════════════════════════════════════════
//  KEYBOARD SHORTCUTS
// ═══════════════════════════════════════════════════════════
document.addEventListener('contextmenu',e=>e.preventDefault());
document.addEventListener('keydown',e=>{
  if(e.ctrlKey&&!e.shiftKey&&!e.altKey&&e.key==='s'){ e.preventDefault(); saveCurrentView(); }
  if(e.ctrlKey&&!e.shiftKey&&!e.altKey&&(e.key==='0'||e.code==='Digit0')){ e.preventDefault(); resetView(); }
});

// ── Ctrl+scroll wheel zoom ────────────────────────────────
document.getElementById('map-viewport').addEventListener('wheel', e => {
  if(!e.ctrlKey) return;
  e.preventDefault();
  const zoomDelta = e.deltaY < 0 ? 0.08 : -0.08;
  currentViewState = {
    ...currentViewState,
    zoom: Math.max(0, Math.min(24, (currentViewState.zoom||0) + zoomDelta)),
  };
  deckgl.setProps({viewState: currentViewState});
  map.jumpTo({center:[currentViewState.longitude,currentViewState.latitude],zoom:currentViewState.zoom,pitch:currentViewState.pitch,bearing:currentViewState.bearing});
}, { passive: false });

// ── Axis drag (pointer events on map-viewport) ────────────
const DRAG_RADIUS = 14; // px from origin center to start drag
{

  document.getElementById('map-viewport').addEventListener('pointerdown', e => {
    if(!SHOW_AXIS) return;
    const ax = drawAxisOverlay._anchorX, ay = drawAxisOverlay._anchorY;
    if(ax === undefined) return;
    const vpRect = document.getElementById('map-viewport').getBoundingClientRect();
    const mx = e.clientX - vpRect.left, my = e.clientY - vpRect.top;
    if(Math.hypot(mx - ax, my - ay) > DRAG_RADIUS) return;
    _axisDragging = true;
    // Disable deck.gl controller so the drag doesn't also pan/rotate the map
    deckgl.setProps({ controller: false });
    e.target.setPointerCapture(e.pointerId);
    e.stopPropagation();
    e.preventDefault();
  });

  document.getElementById('map-viewport').addEventListener('pointermove', e => {
    if(_axisDragging){
      e.stopPropagation();
      const vpRect = document.getElementById('map-viewport').getBoundingClientRect();
      const mx = e.clientX - vpRect.left, my = e.clientY - vpRect.top;
      const W = mapW(), H = mapH();
      const LEN = 70, D = LEN + 30;
      _axisOffsetX = Math.max(-D + LEN, Math.min(W - D - LEN*2, mx - D));
      _axisOffsetY = Math.max(-(H - D) + LEN, Math.min(H - D - LEN, my - (H - D)));
      drawAxisOverlay();
      return;
    }
    // Show grab cursor when hovering near axis origin
    if(!SHOW_AXIS) return;
    const ax = drawAxisOverlay._anchorX, ay = drawAxisOverlay._anchorY;
    if(ax === undefined) return;
    const vpRect = document.getElementById('map-viewport').getBoundingClientRect();
    const mx = e.clientX - vpRect.left, my = e.clientY - vpRect.top;
    const axisCanvas = document.getElementById('axis-canvas');
    if(axisCanvas) axisCanvas.style.cursor = Math.hypot(mx-ax, my-ay) <= DRAG_RADIUS ? 'grab' : '';
  });

  document.getElementById('map-viewport').addEventListener('pointerup', e => {
    if(_axisDragging){
      _axisDragging = false;
      e.target.releasePointerCapture(e.pointerId);
      // Re-enable the deck.gl controller, respecting current SHOW_MAP pitch limit
      deckgl.setProps({ controller: { maxPitch: SHOW_MAP ? 60 : 179 } });
    }
  });
}

// ═══════════════════════════════════════════════════════════
//  EVENT WIRING
// ═══════════════════════════════════════════════════════════
document.getElementById('btn-show-all').addEventListener('click',()=>{ FLAT_LAYERS.forEach(c=>c.visible=true); buildLayerEditor(); render(); updateSciPanel(); });
document.getElementById('btn-hide-all').addEventListener('click',()=>{ FLAT_LAYERS.forEach(c=>c.visible=false); buildLayerEditor(); render(); updateSciPanel(); });
document.getElementById('chk-flow').addEventListener('change',e=>{ SHOW_FLOW=e.target.checked; render(); });
document.getElementById('chk-map').addEventListener('change',e=>{ SHOW_MAP=e.target.checked; applyMapVisibility(); });
document.getElementById('chk-axis').addEventListener('change',e=>{ SHOW_AXIS=e.target.checked; drawAxisOverlay(); });
document.getElementById('chk-sci').addEventListener('change',e=>{ setSciPanelVisible(e.target.checked); });
document.querySelectorAll('input[name=sci-side]').forEach(r=>{
  r.addEventListener('change',e=>{ applySciSide(e.target.value); });
});
document.getElementById('sci-scale').addEventListener('input',e=>{
  const v=parseInt(e.target.value);
  document.getElementById('sci-scale-val').textContent=v+'%';
  applySciScale(v/100);
});
document.getElementById('sci-bg-picker').addEventListener('input',e=>{ applySciBackground(e.target.value); });
document.getElementById('btn-sci-bg-white').addEventListener('click',()=>{ applySciBackground('#ffffff'); });
document.getElementById('btn-sci-bg-default').addEventListener('click',()=>{ applySciBackground(null); document.getElementById('sci-bg-picker').value='#080a14'; });

document.getElementById('bg-color-picker').addEventListener('input',e=>{ BG_COLOR=e.target.value; applyBgColor(); drawAxisOverlay(); if(SHOW_SCI) applySciColors(); });
document.getElementById('btn-bg-white').addEventListener('click',()=>{ BG_COLOR=COLOR_WHITE; applyBgColor(); drawAxisOverlay(); if(SHOW_SCI) applySciColors(); });
document.getElementById('btn-bg-default').addEventListener('click',()=>{ BG_COLOR=COLOR_DEFAULT_BG; applyBgColor(); drawAxisOverlay(); if(SHOW_SCI) applySciColors(); });

document.getElementById('center-color-picker').addEventListener('input',e=>{ CENTER_COLOR=e.target.value; render(); });
document.getElementById('btn-center-black').addEventListener('click',()=>{ applyCenterColor(COLOR_BLACK); });
document.getElementById('btn-center-default').addEventListener('click',()=>{ resetCenterColorToDefault(); });

document.getElementById('btn-apply-center').addEventListener('click',()=>{
  const lat=parseFloat(document.getElementById('inp-lat').value);
  const lng=parseFloat(document.getElementById('inp-lng').value);
  if(isNaN(lat)||isNaN(lng)) return;
  applyCenter(Math.max(-90,Math.min(90,lat)),Math.max(-180,Math.min(180,lng)));
});
['inp-lat','inp-lng'].forEach(id=>{
  document.getElementById(id).addEventListener('keydown',e=>{ if(e.key==='Enter') document.getElementById('btn-apply-center').click(); });
});

document.getElementById('btn-reset-view').addEventListener('click',resetView);
document.getElementById('btn-save-view').addEventListener('click',saveCurrentView);
document.getElementById('btn-add-layer').addEventListener('click',addLayer);
document.getElementById('btn-restore').addEventListener('click',restoreDefaults);

document.getElementById('btn-save-cfg').addEventListener('click',()=>{
  const name=document.getElementById('cfg-name-input').value.trim();
  if(!name){ document.getElementById('cfg-name-input').focus(); return; }
  saveConfig(name); document.getElementById('cfg-name-input').value='';
});
document.getElementById('cfg-name-input').addEventListener('keydown',e=>{ if(e.key==='Enter') document.getElementById('btn-save-cfg').click(); });



// ═══════════════════════════════════════════════════════════
//  INIT
// ═══════════════════════════════════════════════════════════
const map = new maplibregl.Map({
  container: 'basemap',
  style: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
  center: [CENTER_LNG, CENTER_LAT],
  zoom: DEFAULT_INIT_VIEW.zoom, pitch: DEFAULT_INIT_VIEW.pitch, bearing: DEFAULT_INIT_VIEW.bearing,
  interactive: false,
  preserveDrawingBuffer: true,
});

let currentViewState = { ...DEFAULT_INIT_VIEW };

const deckgl = new Deck({
  canvas: 'deck-canvas', width: '100%', height: '100%',
  viewState: currentViewState,
  controller: { maxPitch:60 },
  views: new MapView({repeat:false}),
  layers: [],
  glOptions: { preserveDrawingBuffer: true },
  onViewStateChange: ({viewState}) => {
    currentViewState = viewState;
    deckgl.setProps({viewState: currentViewState});
    map.jumpTo({center:[viewState.longitude,viewState.latitude],zoom:viewState.zoom,pitch:viewState.pitch,bearing:viewState.bearing});
    drawAxisOverlay();
  },
});

map.on('load', ()=>{
  document.getElementById('chk-flow').checked = SHOW_FLOW;
  document.getElementById('chk-map').checked  = SHOW_MAP;
  document.getElementById('chk-axis').checked = SHOW_AXIS;
  document.getElementById('chk-sci').checked  = SHOW_SCI;
  applyMapVisibility(); applyBgColor(); updateBgLabel(); rebuildState();
  document.getElementById('center-color-picker').value = COLOR_WHITE;
  buildSavePanel();
  drawAxisOverlay();
});
