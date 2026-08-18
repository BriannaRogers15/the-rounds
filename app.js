let restaurants = [];
let visits = [];
let profiles = [];
let activeProfileId = null;
let activeCategory = 'All';
let activeSubTag = null;
let dataLoaded = false;
let sortBy = 'name';
let userLocation = null;
let locationRequested = false;
let searchQuery = '';
let unvisitedOnly = false;
let gemsOnly = false;
let recentOnly = false;
let viewMode = 'grid';
let leafletMap = null;
let mapRenderToken = 0;
let currentPage = 'areas';   // 'areas' = neighborhood landing, 'listings' = classic page
let activeArea = null;       // {type:'neighborhood'|'town'|'other', name} or null = everywhere
let showGhosts = false;      // landing toggle: reveal neighborhoods with no listings yet
let hoodGeo = null;          // Chicago neighborhood boundary GeoJSON, loaded once (block silhouettes + assigning new listings)
let townGeo = null;          // suburb municipal boundary GeoJSON (Census TIGERweb), for suburb block silhouettes

const $ = (sel, root=document) => root.querySelector(sel);
const $$ = (sel, root=document) => Array.from(root.querySelectorAll(sel));

function uid(){ return Date.now().toString(36) + Math.random().toString(36).slice(2,7); }

function distanceMiles(lat1, lng1, lat2, lng2){
  const R = 3958.8;
  const dLat = (lat2-lat1) * Math.PI/180;
  const dLng = (lng2-lng1) * Math.PI/180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function requestUserLocation(){
  if(locationRequested) return;
  locationRequested = true;
  if(!navigator.geolocation){ return; }
  navigator.geolocation.getCurrentPosition(
    (pos)=>{
      userLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      renderContent();
    },
    ()=>{ /* denied or unavailable — falls back to unsorted-by-distance */ },
    { timeout: 8000 }
  );
}

function sortName(n){
  return n.replace(/^the\s+/i, '');
}
function sortRestaurants(list){
  const arr = [...list];
  if(sortBy === 'name'){
    arr.sort((a,b)=> sortName(a.name).localeCompare(sortName(b.name)));
  } else if(sortBy === 'date'){
    arr.sort((a,b)=> (b.createdAt||0) - (a.createdAt||0));
  } else if(sortBy === 'rating'){
    arr.sort((a,b)=>{
      const ra = avgRating(visitsFor(a.id));
      const rb = avgRating(visitsFor(b.id));
      if(ra==null && rb==null) return 0;
      if(ra==null) return 1;
      if(rb==null) return -1;
      return rb - ra;
    });
  } else if(sortBy === 'distance' && userLocation){
    arr.sort((a,b)=>{
      const da = (a.lat!=null && a.lng!=null) ? distanceMiles(userLocation.lat, userLocation.lng, a.lat, a.lng) : Infinity;
      const db = (b.lat!=null && b.lng!=null) ? distanceMiles(userLocation.lat, userLocation.lng, b.lat, b.lng) : Infinity;
      return da - db;
    });
  }
  return arr;
}

/* Storage abstraction: window.storage only exists inside Claude's own
   preview sandbox. Once this file is hosted standalone (GitHub Pages,
   installed as a PWA, opened as a local file), that API doesn't exist —
   so we fall back to localStorage, which every real browser supports. */
const store = {
  async get(key){
    if(window.storage){
      return await window.storage.get(key);
    }
    const raw = localStorage.getItem('rounds:' + key);
    return raw != null ? { key, value: raw } : null;
  },
  async set(key, value){
    if(window.storage){
      return await window.storage.set(key, value);
    }
    localStorage.setItem('rounds:' + key, value);
    return { key, value };
  }
};

async function loadData(){
  try{
    const r = await store.get('restaurants');
    restaurants = r && r.value ? JSON.parse(r.value) : [];
  }catch(e){ restaurants = []; }
  try{
    const v = await store.get('visits');
    visits = v && v.value ? JSON.parse(v.value) : [];
  }catch(e){ visits = []; }
  try{
    const p = await store.get('profiles');
    profiles = p && p.value ? JSON.parse(p.value) : [];
  }catch(e){ profiles = []; }
  try{
    const ap = await store.get('activeProfile');
    activeProfileId = ap && ap.value ? ap.value : null;
  }catch(e){ activeProfileId = null; }
  if(activeProfileId && !profiles.some(p => p.id === activeProfileId)) activeProfileId = null;
  if(!activeProfileId && profiles.length) activeProfileId = profiles[0].id;
  dataLoaded = true;
}

/* One-time migration: older entries had a single `category` string.
   Convert those to a `categories` array so a place can live in
   multiple guides. Safe to re-run — no-op once migrated. */
async function migrateCategories(){
  let changed = false;
  restaurants.forEach(r=>{
    if(!Array.isArray(r.categories)){
      r.categories = r.category ? [r.category] : [];
      delete r.category;
      changed = true;
    }
  });
  if(changed) await saveRestaurants();
}

async function saveRestaurants(){
  try{ await store.set('restaurants', JSON.stringify(restaurants)); }
  catch(e){ console.error('Could not save restaurants', e); }
}
async function saveVisits(){
  try{ await store.set('visits', JSON.stringify(visits)); }
  catch(e){ console.error('Could not save visits', e); }
}
async function saveProfiles(){
  try{
    await store.set('profiles', JSON.stringify(profiles));
    await store.set('activeProfile', activeProfileId || '');
  }catch(e){ console.error('Could not save profiles', e); }
}
function activeProfile(){
  return profiles.find(p => p.id === activeProfileId) || null;
}

/* ---------- Backup / restore ----------
   Everything lives in this browser's localStorage — one "Clear Website
   Data" would erase every visit ever logged. Export writes the whole
   ledger to a JSON file; restore replaces this device's data with it. */
function exportBackup(){
  const payload = {
    app: 'the-rounds',
    version: 1,
    exportedAt: new Date().toISOString(),
    restaurants, visits, profiles, activeProfileId,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `the-rounds-backup-${new Date().toISOString().slice(0,10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(()=> URL.revokeObjectURL(a.href), 5000);
}
async function importBackup(file){
  let data;
  try{ data = JSON.parse(await file.text()); }
  catch(e){ alert("That file isn't readable as a backup."); return; }
  if(data.app !== 'the-rounds' || !Array.isArray(data.restaurants) || !Array.isArray(data.visits)){
    alert("That file doesn't look like a The Rounds backup.");
    return;
  }
  const summary = `${data.restaurants.length} listings, ${data.visits.length} visits, ${(data.profiles||[]).length} reviewer${(data.profiles||[]).length===1?'':'s'}`;
  if(!confirm(`Restore this backup (${summary})? It replaces everything currently on this device.`)) return;
  restaurants = data.restaurants;
  visits = data.visits;
  profiles = Array.isArray(data.profiles) ? data.profiles : [];
  activeProfileId = data.activeProfileId && profiles.some(p=>p.id===data.activeProfileId)
    ? data.activeProfileId
    : (profiles[0] ? profiles[0].id : null);
  await saveRestaurants();
  await saveVisits();
  await saveProfiles();
  // Backups from before the area fields existed still restore cleanly.
  await assignAreas();
  if(hoodGeo) await assignNeighborhoods(hoodGeo);
  renderAll();
}

function visitsFor(restaurantId){
  return visits.filter(v => v.restaurantId === restaurantId).sort((a,b)=> b.date.localeCompare(a.date));
}
function avgRating(list){
  if(!list.length) return null;
  return list.reduce((s,v)=>s+v.rating,0) / list.length;
}
function starString(n){
  const full = Math.round(n);
  return '★'.repeat(full) + '☆'.repeat(5-full);
}
function fmtDate(d){
  const dt = new Date(d + 'T00:00:00');
  return dt.toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' });
}

function categories(){
  const set = new Set();
  restaurants.forEach(r => (r.categories||[]).forEach(c => set.add(c)));
  return Array.from(set).sort();
}

/* Two-level tabs, two ways a tag can nest under a parent umbrella:
   1) Pattern match — anything containing "bar" (but not "Bars" itself)
      auto-nests under "Bars", no config needed, scales as you tag more.
   2) Explicit map — cuisine-style groupings that can't be guessed from
      the tag text (e.g. "Burgers" isn't detectably "American"). Extend
      this list any time you want another umbrella; just tell me the
      grouping and I'll add it here. */
const PARENT_GROUPS = {
  // One Sandwiches sub-tag — hoagies, wraps, cheesesteaks, bagels are all
  // sandwiches. Brianna's guides define the granularity; don't split finer.
  'American': ['Burgers', 'Chicken', 'Steakhouses', 'BBQ', 'Seafood', 'Soul Food', 'Sandwiches'],
  // Countries are main guides (all flags at one level); Ramen and Sushi
  // are kinds of Japanese food, so they nest under Japanese the way
  // Burgers nest under American. The old regional umbrellas (Asian,
  // Latin American, Caribbean, European) are gone.
  'Japanese': ['Ramen', 'Sushi'],
  'Desserts': ['Ice Cream', 'Bakery', 'Frozen Yogurt'],
  'Special Events': ['Dinner Dates', 'Happy Hour', 'Late Night', 'Breakfast', 'Brunch', 'Rooftop'],
  'Italian': ['Pizza'],
};
function groupForTag(tag){
  const lower = tag.toLowerCase();
  if(Object.values(PARENT_GROUPS).some(children => children.some(c=>c.toLowerCase()===lower))){
    for(const parent in PARENT_GROUPS){
      if(PARENT_GROUPS[parent].some(c=>c.toLowerCase()===lower)) return parent;
    }
  }
  if(Object.keys(PARENT_GROUPS).some(p=>p.toLowerCase()===lower)) return null;
  if(lower === 'bars') return null;
  if(/bar/i.test(tag)) return 'Bars';
  return null;
}
/* Badge tags mark a property of a restaurant (a staple, a gem) rather than
   a category — they render as a 💎 corner badge + a tools-row filter,
   never as a guide in the rail or a chip on the card. */
const BADGE_TAGS = new Set(['Chicago Gems']);
function isGem(r){ return (r.categories || []).includes('Chicago Gems'); }

function topLevelLabels(){
  const cats = categories();
  const labels = new Set();
  cats.forEach(c=>{
    if(BADGE_TAGS.has(c)) return;
    const g = groupForTag(c);
    labels.add(g || c);
  });
  return Array.from(labels).sort();
}
function isGroupLabel(label){
  return categories().some(c => groupForTag(c) === label);
}
function childTagsOf(group){
  return categories().filter(c => groupForTag(c) === group).sort();
}
/* Read-only tag display helper: shows each tag's parent cuisine group
   alongside it (e.g. Pizza -> also show Italian Cuisine), without
   mutating the restaurant's actual stored categories. Not used for the
   editable tag row in the detail modal, since a synthesized parent tag
   has no real delete action behind it. */
function displayTags(categories){
  const tags = (categories || []).filter(t => !BADGE_TAGS.has(t));
  const parents = [];
  tags.forEach(t=>{
    const parent = groupForTag(t);
    if(parent && !parents.includes(parent) && !tags.includes(parent)) parents.push(parent);
  });
  return [...parents, ...tags];
}
function restaurantMatchesLabel(r, label, subTag){
  const tags = r.categories || [];
  if(isGroupLabel(label)){
    if(subTag) return tags.includes(subTag);
    return tags.some(t => groupForTag(t) === label || t === label);
  }
  return tags.includes(label);
}

function addTagToRestaurant(id, tag){
  const r = restaurants.find(x=>x.id===id);
  if(!r) return false;
  const clean = tag.trim();
  if(!clean) return false;
  if(!r.categories) r.categories = [];
  const exists = r.categories.some(c => c.toLowerCase() === clean.toLowerCase());
  if(exists) return false;
  r.categories.push(clean);
  return true;
}
function removeTagFromRestaurant(id, tag){
  const r = restaurants.find(x=>x.id===id);
  if(!r) return;
  r.categories = (r.categories||[]).filter(c => c !== tag);
}

/* ---------- Per-restaurant menus ---------- */
/* Older visits stored `ate` as one free-typed string; newer ones store an
   array of dishes picked off the restaurant's menu. Read through this
   helper so both render the same. */
function ateList(v){
  if(Array.isArray(v.ate)) return v.ate;
  return v.ate ? [v.ate] : [];
}
function menuOf(r){ return r.menu || []; }
/* Groups a spot's stored dishes under the curated section headers
   (Appetizers, Entrees, Drinks...) from MENU_LOOKUP. Grouping happens at
   render time, so stored menus never need migrating: dishes the curation
   doesn't know (user-added) land under "More", and spots without curated
   sections render as one unnamed group. */
function menuGroupsFor(r){
  const menu = menuOf(r);
  if(!menu.length) return [];
  const entry = MENU_LOOKUP.find(e => e.name.toLowerCase() === r.name.toLowerCase());
  if(!entry || !entry.sections) return [{title:null, dishes:menu}];
  const dishSection = {};
  Object.entries(entry.sections).forEach(([sec, ds])=> ds.forEach(d => dishSection[d.toLowerCase()] = sec));
  const grouped = {};
  const extra = [];
  menu.forEach(d=>{
    const sec = dishSection[d.toLowerCase()];
    if(sec) (grouped[sec] = grouped[sec] || []).push(d);
    else extra.push(d);
  });
  const out = Object.keys(entry.sections).filter(s=>grouped[s]).map(s=>({title:s, dishes:grouped[s]}));
  if(extra.length) out.push({title:'More', dishes:extra});
  return out;
}
/* Shared renderer for the log-visit checklist: section headers + checkbox
   rows, 2 columns (3 for big menus). */
function dishChecklistHtml(r){
  const menu = menuOf(r);
  const groups = menuGroupsFor(r);
  return `<div class="dish-checklist ${menu.length > 40 ? 'cols3' : ''}">${groups.map(g=>`
    ${g.title ? `<div class="dish-group-title">${escapeHtml(g.title)}</div>` : ''}
    ${g.dishes.map(d=>`<label class="dish-check"><input type="checkbox" data-dish="${escapeHtml(d)}"><span>${escapeHtml(d)}</span></label>`).join('')}`).join('')}</div>`;
}
function addDishToMenu(restaurantId, dish){
  const r = restaurants.find(x=>x.id===restaurantId);
  if(!r) return false;
  const clean = dish.trim();
  if(!clean) return false;
  if(!r.menu) r.menu = [];
  if(r.menu.some(d => d.toLowerCase() === clean.toLowerCase())) return false;
  r.menu.push(clean);
  r.menu.sort((a,b)=> a.localeCompare(b));
  return true;
}

/* ---------- Areas: neighborhoods + suburb regions ---------- */
/* Suburb town -> region. Towns not listed still work — they land in an
   "Other Suburbs" group until added here. */
const CITY_REGION = {
  // South
  'Oak Lawn':'South Suburbs','Homewood':'South Suburbs','Dolton':'South Suburbs','Harvey':'South Suburbs',
  'Matteson':'South Suburbs','Burnham':'South Suburbs','Chicago Heights':'South Suburbs','Sauk Village':'South Suburbs',
  'Burbank':'South Suburbs','Evergreen Park':'South Suburbs','Blue Island':'South Suburbs','Calumet City':'South Suburbs',
  'Lansing':'South Suburbs','Tinley Park':'South Suburbs','Orland Park':'South Suburbs','Oak Forest':'South Suburbs',
  'Country Club Hills':'South Suburbs','Hazel Crest':'South Suburbs','Markham':'South Suburbs','South Holland':'South Suburbs',
  'Riverdale':'South Suburbs','Flossmoor':'South Suburbs','Olympia Fields':'South Suburbs','Park Forest':'South Suburbs',
  'Frankfort':'South Suburbs','Mokena':'South Suburbs','New Lenox':'South Suburbs','Joliet':'South Suburbs',
  'Alsip':'South Suburbs','Palos Heights':'South Suburbs','Palos Hills':'South Suburbs','Hickory Hills':'South Suburbs',
  'Worth':'South Suburbs','Midlothian':'South Suburbs','Crestwood':'South Suburbs','Bridgeview':'South Suburbs',
  'Justice':'South Suburbs','Summit':'South Suburbs','Bedford Park':'South Suburbs','Lemont':'South Suburbs',
  'Steger':'South Suburbs','Crete':'South Suburbs','Monee':'South Suburbs','University Park':'South Suburbs',
  'Richton Park':'South Suburbs','Lynwood':'South Suburbs','Glenwood':'South Suburbs','Thornton':'South Suburbs',
  'Posen':'South Suburbs','Robbins':'South Suburbs','Dixmoor':'South Suburbs','Phoenix':'South Suburbs',
  'East Hazel Crest':'South Suburbs','Lockport':'South Suburbs','Romeoville':'South Suburbs',
  // West
  'Berwyn':'West Suburbs','Cicero':'West Suburbs','Oak Park':'West Suburbs','Forest Park':'West Suburbs',
  'River Forest':'West Suburbs','Maywood':'West Suburbs','Bellwood':'West Suburbs','Melrose Park':'West Suburbs',
  'Franklin Park':'West Suburbs','Elmwood Park':'West Suburbs','River Grove':'West Suburbs','Berkeley':'West Suburbs',
  'Hillside':'West Suburbs','Westchester':'West Suburbs','Broadview':'West Suburbs','La Grange':'West Suburbs',
  'La Grange Park':'West Suburbs','Western Springs':'West Suburbs','Brookfield':'West Suburbs','Riverside':'West Suburbs',
  'North Riverside':'West Suburbs','Lyons':'West Suburbs','Stickney':'West Suburbs','Oak Brook':'West Suburbs',
  'Oakbrook Terrace':'West Suburbs','Elmhurst':'West Suburbs','Villa Park':'West Suburbs','Lombard':'West Suburbs',
  'Glen Ellyn':'West Suburbs','Wheaton':'West Suburbs','Downers Grove':'West Suburbs','Westmont':'West Suburbs',
  'Clarendon Hills':'West Suburbs','Hinsdale':'West Suburbs','Burr Ridge':'West Suburbs','Willowbrook':'West Suburbs',
  'Darien':'West Suburbs','Woodridge':'West Suburbs','Lisle':'West Suburbs','Naperville':'West Suburbs',
  'Aurora':'West Suburbs','Addison':'West Suburbs','Bensenville':'West Suburbs','Bolingbrook':'West Suburbs',
  // North
  'Evanston':'North Suburbs','Skokie':'North Suburbs','Wilmette':'North Suburbs','Kenilworth':'North Suburbs',
  'Winnetka':'North Suburbs','Glencoe':'North Suburbs','Highland Park':'North Suburbs','Highwood':'North Suburbs',
  'Lake Forest':'North Suburbs','Northbrook':'North Suburbs','Glenview':'North Suburbs','Morton Grove':'North Suburbs',
  'Niles':'North Suburbs','Park Ridge':'North Suburbs','Des Plaines':'North Suburbs','Mount Prospect':'North Suburbs',
  'Arlington Heights':'North Suburbs','Rolling Meadows':'North Suburbs','Palatine':'North Suburbs','Buffalo Grove':'North Suburbs',
  'Wheeling':'North Suburbs','Deerfield':'North Suburbs','Lincolnwood':'North Suburbs','Rosemont':'North Suburbs',
  'Schaumburg':'North Suburbs','Elk Grove Village':'North Suburbs','Hoffman Estates':'North Suburbs',
};
const REGION_ORDER = ['South Suburbs', 'West Suburbs', 'North Suburbs', 'Other Suburbs'];

/* The city's boundary file uses a few official names where everyone says
   something else. Rename for display + matching. */
const HOOD_RENAME = {
  'Lower West Side': 'Pilsen',
  'Near South Side': 'South Loop',
  // Douglas + Grand Boulevard are both halves of what everyone calls
  // Bronzeville — renaming both merges them into one area.
  'Douglas': 'Bronzeville',
  'Grand Boulevard': 'Bronzeville',
  // The city boundary file includes landmark zones that aren't real
  // neighborhoods; fold each into the neighborhood it actually sits in.
  'United Center': 'Near West Side',
  'Museum Campus': 'South Loop',
  'Millenium Park': 'Loop',
  'Grant Park': 'Loop',
  'Magnificent Mile': 'Streeterville',
  'Rush & Division': 'Gold Coast',
  'Sheffield & DePaul': 'Lincoln Park',
};
function displayHoodName(name){ return HOOD_RENAME[name] || name; }
/* Community areas that aren't dining neighborhoods (the airport) — left
   off the landing grid unless a listing ever actually lands there. */
const HOOD_EXCLUDE = new Set(["O'Hare"]);

/* Which side of the city each neighborhood belongs to — the territory
   page groups Chicago into Downtown / North / West / South / East Side.
   Keys are display names (post-HOOD_RENAME). Anything unmapped falls back
   to a rough compass cut on its boundary centroid. */
const CHI_SIDES = ['Downtown', 'North Side', 'West Side', 'South Side', 'East Side'];
const HOOD_SIDE = {
  'Downtown': ['Loop', 'South Loop', 'River North', 'Streeterville', 'Gold Coast', 'Old Town', 'Printers Row', 'West Loop', 'Greektown'],
  'North Side': ['Albany Park', 'Andersonville', 'Avondale', 'Belmont Cragin', 'Boystown', 'Dunning', 'Edgewater', 'Edison Park', 'Hermosa', 'Irving Park', 'Jefferson Park', 'Lake View', 'Lincoln Park', 'Lincoln Square', 'Logan Square', 'Montclare', 'North Center', 'North Park', 'Norwood Park', 'Portage Park', 'Rogers Park', 'Sauganash,Forest Glen', 'Uptown', 'West Ridge', 'Wrigleyville'],
  'West Side': ['Austin', 'Bucktown', 'East Village', 'Galewood', 'Garfield Park', 'Humboldt Park', 'Little Italy, UIC', 'Little Village', 'Near West Side', 'North Lawndale', 'Pilsen', 'Ukrainian Village', 'West Town', 'Wicker Park'],
  'South Side': ['Archer Heights', 'Armour Square', 'Ashburn', 'Auburn Gresham', 'Avalon Park', 'Beverly', 'Bridgeport', 'Brighton Park', 'Bronzeville', 'Burnside', 'Calumet Heights', 'Chatham', 'Chicago Lawn', 'Chinatown', 'Clearing', 'Englewood', 'Fuller Park', 'Gage Park', 'Garfield Ridge', 'Grand Crossing', 'Hyde Park', 'Jackson Park', 'Kenwood', 'Mckinley Park', 'Morgan Park', 'Mount Greenwood', 'New City', 'Oakland', 'Pullman', 'Riverdale', 'Roseland', 'South Shore', 'Washington Heights', 'Washington Park', 'West Elsdon', 'West Lawn', 'West Pullman', 'Woodlawn'],
  'East Side': ['East Side', 'Hegewisch', 'South Chicago', 'South Deering'],
};
const HOOD_SIDE_LOOKUP = {};
Object.entries(HOOD_SIDE).forEach(([side, names]) => names.forEach(n => HOOD_SIDE_LOOKUP[n] = side));
function sideForHood(name){
  if(HOOD_SIDE_LOOKUP[name]) return HOOD_SIDE_LOOKUP[name];
  const f = hoodGeo && (hoodGeo.features || []).find(x => displayHoodName(x.properties.pri_neigh) === name);
  if(f){
    let pts = [], stack = [f.geometry.coordinates];
    while(stack.length){ const c = stack.pop(); if(typeof c[0] === 'number') pts.push(c); else c.forEach(x => stack.push(x)); }
    const lat = pts.reduce((s, p) => s + p[1], 0) / pts.length;
    const lng = pts.reduce((s, p) => s + p[0], 0) / pts.length;
    if(lng > -87.565 && lat < 41.75) return 'East Side';
    if(lat >= 41.90) return 'North Side';
    if(lat <= 41.85) return 'South Side';
    return 'West Side';
  }
  return 'South Side';
}

function parseTown(address){
  if(!address) return null;
  const m = address.match(/(?:^|,)\s*([A-Za-z .'-]+),\s*IL\b/);
  return m ? m[1].trim() : null;
}

/* Chicago neighborhood boundaries (98 areas), simplified server-side so the
   whole file is ~80KB. Fetched once and kept in the Cache API so repeat
   visits (and offline PWA use) don't need the network. */
const HOOD_GEO_URL = 'https://data.cityofchicago.org/resource/y6yq-dbs2.geojson?%24select=simplify_preserve_topology(the_geom%2C0.0004)%20as%20the_geom%2Cpri_neigh&%24limit=200';
async function loadHoodGeo(){
  if(hoodGeo) return hoodGeo;
  try{
    let resp = null;
    if('caches' in window){
      const cache = await caches.open('rounds-geo-v1');
      resp = await cache.match(HOOD_GEO_URL);
      if(!resp){
        resp = await fetch(HOOD_GEO_URL);
        if(resp.ok) await cache.put(HOOD_GEO_URL, resp.clone());
      }
    } else {
      resp = await fetch(HOOD_GEO_URL);
    }
    if(resp && resp.ok) hoodGeo = await resp.json();
  }catch(e){
    console.warn('Neighborhood boundaries unavailable — landing falls back to chips only.', e);
  }
  return hoodGeo;
}

/* Suburb town boundaries come from the U.S. Census TIGERweb Incorporated
   Places layer (the Chicago city file has no suburbs). Fetched only for
   the towns actually on file; the URL encodes that list, so adding a
   listing in a brand-new town naturally triggers one fresh fetch. */
const TOWN_GEO_BASE = 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Places_CouSub_ConCity_SubMCD/MapServer/4/query';
function suburbTownsOnFile(){
  return Array.from(new Set(
    restaurants.filter(r => r.region && r.region !== 'Chicago' && r.town).map(r => r.town)
  )).sort();
}
async function loadTownGeo(){
  if(townGeo) return townGeo;
  const towns = suburbTownsOnFile();
  if(!towns.length) return null;
  const where = `STATE='17' AND BASENAME IN (${towns.map(t => `'${t.replace(/'/g, "''")}'`).join(',')})`;
  const url = TOWN_GEO_BASE + '?' + new URLSearchParams({
    where, outFields: 'BASENAME', returnGeometry: 'true', geometryPrecision: '4', f: 'geojson'
  });
  try{
    let resp = null;
    if('caches' in window){
      const cache = await caches.open('rounds-geo-v1');
      resp = await cache.match(url);
      if(!resp){
        resp = await fetch(url);
        if(resp.ok) await cache.put(url, resp.clone());
      }
    } else {
      resp = await fetch(url);
    }
    if(resp && resp.ok) townGeo = await resp.json();
  }catch(e){
    console.warn('Suburb boundaries unavailable — town blocks render without silhouettes.', e);
  }
  return townGeo;
}

/* Ray-casting point-in-polygon (outer rings only — the neighborhood file
   has no holes worth honoring at this zoom). */
function pointInRing(lng, lat, ring){
  let inside = false;
  for(let i = 0, j = ring.length - 1; i < ring.length; j = i++){
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    if(((yi > lat) !== (yj > lat)) && (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi)){
      inside = !inside;
    }
  }
  return inside;
}
function pointInFeature(lng, lat, feature){
  const g = feature.geometry;
  if(!g) return false;
  const polys = g.type === 'MultiPolygon' ? g.coordinates : (g.type === 'Polygon' ? [g.coordinates] : []);
  return polys.some(poly => pointInRing(lng, lat, poly[0]));
}
function neighborhoodAt(lat, lng, geo){
  const f = (geo.features || []).find(f => pointInFeature(lng, lat, f));
  return f ? displayHoodName(f.properties.pri_neigh) : null;
}

/* Migration: stamp town + region from each address. Safe to re-run. */
async function assignAreas(){
  let changed = false;
  restaurants.forEach(r=>{
    const town = parseTown(r.address) || 'Chicago';
    const region = town === 'Chicago' ? 'Chicago' : (CITY_REGION[town] || 'Other Suburbs');
    if(r.town !== town || r.region !== region){ r.town = town; r.region = region; changed = true; }
  });
  if(changed) await saveRestaurants();
}
/* Migration: stamp Chicago listings with their neighborhood once boundary
   data is in hand. Persisted, so the landing page works offline afterward.
   Safe to re-run — it also self-heals when a rename is added to
   HOOD_RENAME (e.g. Douglas -> Bronzeville) by re-stamping stale names. */
async function assignNeighborhoods(geo){
  let changed = false;
  restaurants.forEach(r=>{
    if(r.region === 'Chicago' && r.lat != null && r.lng != null){
      const hood = neighborhoodAt(r.lat, r.lng, geo);
      if(hood && r.neighborhood !== hood){ r.neighborhood = hood; changed = true; }
    }
  });
  if(changed) await saveRestaurants();
}
/* Stamp a brand-new record at add time (uses boundaries if already loaded). */
function assignAreaFields(record){
  record.town = parseTown(record.address) || 'Chicago';
  record.region = record.town === 'Chicago' ? 'Chicago' : (CITY_REGION[record.town] || 'Other Suburbs');
  if(record.region === 'Chicago' && record.lat != null && record.lng != null && hoodGeo){
    const hood = neighborhoodAt(record.lat, record.lng, hoodGeo);
    if(hood) record.neighborhood = hood;
  }
}

function restaurantInArea(r, area){
  if(!area) return true;
  if(area.type === 'neighborhood') return r.neighborhood === area.name;
  if(area.type === 'town') return r.town === area.name;
  if(area.type === 'other') return r.region === 'Chicago' && !r.neighborhood;
  return true;
}

function openArea(area){
  activeArea = area;
  currentPage = 'listings';
  activeCategory = 'All';
  activeSubTag = null;
  renderAll();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ---------- View state <-> URL hash ----------
   The current page, area, and guide live in the address bar, so a refresh
   keeps your place, the back button walks your real steps, and bookmarks
   land on the right view. Empty hash = the territory landing. */
let applyingHash = false;
function stateToHash(){
  if(currentPage !== 'listings') return '';
  const p = new URLSearchParams();
  p.set('v', activeArea ? 'area' : 'all');
  if(activeArea){ p.set('t', activeArea.type); p.set('n', activeArea.name); }
  if(activeCategory !== 'All') p.set('c', activeCategory);
  if(activeSubTag) p.set('s', activeSubTag);
  return '#' + p.toString();
}
function syncHash(){
  if(applyingHash) return;
  const h = stateToHash();
  if((h || '#') === (location.hash || '#')) return;
  location.hash = h;
}
function applyHash(){
  applyingHash = true;
  const p = new URLSearchParams(location.hash.replace(/^#/, ''));
  const v = p.get('v');
  if(v === 'all' || v === 'area'){
    currentPage = 'listings';
    activeArea = (v === 'area' && p.get('t') && p.get('n')) ? { type: p.get('t'), name: p.get('n') } : null;
    activeCategory = p.get('c') || 'All';
    activeSubTag = p.get('s') || null;
  } else {
    currentPage = 'areas';
    activeArea = null;
  }
  renderAll();
  applyingHash = false;
}
window.addEventListener('hashchange', applyHash);

/* ---------- Confetti (fun + interactive delight) ---------- */
function spawnConfetti(x, y){
  const colors = ['#4FA8DE', '#E23A50', '#F3EDE0', '#1FA463', '#7EC8F2'];
  for(let i=0; i<22; i++){
    const p = document.createElement('div');
    p.className = 'confetti-piece';
    const angle = Math.random() * Math.PI * 2;
    const dist = 60 + Math.random() * 90;
    const fx = Math.cos(angle) * dist;
    const fy = Math.sin(angle) * dist + 40;
    p.style.left = x + 'px';
    p.style.top = y + 'px';
    p.style.background = colors[Math.floor(Math.random()*colors.length)];
    p.style.setProperty('--fall', `translate(${fx}px, ${fy}px) rotate(${Math.random()*360}deg)`);
    p.style.animationDelay = (Math.random()*0.08) + 's';
    document.body.appendChild(p);
    setTimeout(()=> p.remove(), 1000);
  }
}

/* ---------- Card tilt (fun + interactive) ---------- */
function attachTilt(card){
  card.addEventListener('mousemove', (e)=>{
    const rect = card.getBoundingClientRect();
    const px = (e.clientX - rect.left) / rect.width - 0.5;
    const py = (e.clientY - rect.top) / rect.height - 0.5;
    card.style.transform = `perspective(900px) rotateY(${px*7}deg) rotateX(${-py*7}deg) translateY(-6px) scale(1.015)`;
  });
  card.addEventListener('mouseleave', ()=>{
    card.style.transform = '';
  });
}

function renderStats(){
  const scope = restaurants.filter(r => restaurantInArea(r, activeArea));
  const ids = new Set(scope.map(r => r.id));
  const scopedVisits = visits.filter(v => ids.has(v.restaurantId));
  const total = scope.length;
  const visitedCount = scope.filter(r => visitsFor(r.id).length > 0).length;
  const totalVisits = scopedVisits.length;
  const allAvg = avgRating(scopedVisits);
  const el = $('#statsReceipt');
  el.innerHTML = `
    <div class="receipt-row"><span class="receipt-label">Listings</span><span class="receipt-val">${total}</span></div>
    <div class="receipt-row"><span class="receipt-label">Spots Visited</span><span class="receipt-val">${visitedCount}/${total}</span></div>
    <div class="receipt-row"><span class="receipt-label">Visits Logged</span><span class="receipt-val">${totalVisits}</span></div>
    <div class="receipt-row"><span class="receipt-label">Average Rating</span><span class="receipt-val${allAvg ? '' : ' muted'}">${allAvg ? allAvg.toFixed(1) + ' ★' : '—'}</span></div>
  `;
}

/* The vertical guide list (desktop rail / phone drawer). A group that's
   active unfolds its sub-cuisines indented beneath it, accordion-style. */
function railItemHTML(label, count, active, opts = {}){
  const cls = `rail-item${opts.child ? ' child' : ''}${active ? ' active' : ''}`;
  const sub = opts.sub !== undefined ? ` data-sub="${escapeHtml(opts.sub)}"` : '';
  return `<button class="${cls}" data-cat="${escapeHtml(label)}"${sub}>
    <span class="rail-ico">${opts.icon || tagIcon(label)}</span>
    <span class="rail-name">${escapeHtml(opts.name || label)}</span>
    <span class="rail-cnt">${count}</span>
  </button>`;
}
/* Rail order: cuisines (flags and regions together), then food & drink,
   then occasion guides. Unmapped new guides land in Food & Drink. */
const GUIDE_SECTION = {
  'American':'Cuisines','Chinese':'Cuisines','Indian':'Cuisines','Italian':'Cuisines',
  'Jamaican':'Cuisines','Japanese':'Cuisines','Korean':'Cuisines','Mexican':'Cuisines',
  'Peruvian':'Cuisines','Swiss':'Cuisines','Thai':'Cuisines','Vietnamese':'Cuisines',
  'Asian Fusion':'Cuisines',
  // Defensive: if anything ever gets tagged with an old umbrella name, it
  // still files under Cuisines rather than the fallback section.
  'Asian':'Cuisines','Caribbean':'Cuisines','European':'Cuisines','Latin American':'Cuisines',
  'Bars':'Food & Drink','Desserts':'Food & Drink','Pizza':'Food & Drink',
  'Special Events':'Occasions','Chicago Gems':'Occasions',
};
const RAIL_SECTION_ORDER = ['Cuisines', 'Food & Drink', 'Occasions'];
function renderCuisineRail(){
  const railEl = $('#cuisineRail');
  const labels = topLevelLabels();
  const inArea = restaurants.filter(r => restaurantInArea(r, activeArea));

  const sections = {};
  RAIL_SECTION_ORDER.forEach(s => sections[s] = []);
  labels.forEach(label=>{
    const count = inArea.filter(r => restaurantMatchesLabel(r, label, null)).length;
    if(activeArea && count === 0) return; // inside an area, only its cuisines
    sections[GUIDE_SECTION[label] || 'Food & Drink'].push({ label, count });
  });

  let html = `<div class="rail-title">Guides</div>`;
  html += railItemHTML('All', inArea.length, activeCategory === 'All', { icon:'🍽️' });
  RAIL_SECTION_ORDER.forEach(sec=>{
    if(!sections[sec].length) return;
    html += `<div class="rail-section">${sec}</div>`;
    sections[sec].forEach(({ label, count })=>{
      const active = activeCategory === label;
      html += railItemHTML(label, count, active && !isGroupLabel(label));
      if(isGroupLabel(label) && active){
        html += `<div class="rail-children">`;
        html += railItemHTML(label, count, !activeSubTag, { child:true, sub:'', name:`All ${label}`, icon:'▸' });
        childTagsOf(label).forEach(c=>{
          const ccount = inArea.filter(r => (r.categories||[]).includes(c)).length;
          if(activeArea && ccount === 0) return;
          html += railItemHTML(label, ccount, activeSubTag === c, { child:true, sub:c, name:c, icon:tagIcon(c) });
        });
        html += `</div>`;
      }
    });
  });
  railEl.innerHTML = html;
  $$('.rail-item', railEl).forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const cat = btn.dataset.cat;
      let unfolding = false;
      if(btn.dataset.sub !== undefined){
        activeSubTag = btn.dataset.sub || null;
      } else {
        activeCategory = (activeCategory === cat && cat !== 'All') ? 'All' : cat;
        activeSubTag = null;
        // Tapping a group that just unfolded its sub-guides keeps the
        // phone drawer open — otherwise the subtags would be unreachable.
        unfolding = isGroupLabel(cat) && activeCategory === cat;
      }
      if(!unfolding) closeRail();
      renderCuisineRail();
      renderContent();
      syncHash();
    });
  });
}
function openRail(){ $('#cuisineRail').classList.add('open'); $('#railScrim').classList.add('show'); }
function closeRail(){ $('#cuisineRail').classList.remove('open'); $('#railScrim').classList.remove('show'); }

/* Display-only singular form for venue-type tags on cards — a single
   restaurant is "a Steakhouse", not "Steakhouses". Cuisine/food tags
   (Ramen, Sushi, Chicken, BBQ, etc.) read fine as-is, so only the
   venue-type plurals need a mapped singular. Underlying tag data and
   tab filtering/counts are untouched — this only affects card text. */
const TAG_SINGULAR = {
  'bars': 'Bar',
  'sports bars': 'Sports Bar',
  'wine bars': 'Wine Bar',
  'tiki bars': 'Tiki Bar',
  'cocktail bars': 'Cocktail Bar',
  'steakhouses': 'Steakhouse',
  'burgers': 'Burger',
  'desserts': 'Dessert',
  'hot dogs': 'Hot Dog',
};
function singularizeTag(tag){
  return TAG_SINGULAR[tag.toLowerCase()] || tag;
}

/* A small icon per tag adds personality to the card chips without
   needing custom art for every possible guide category. Falls back
   to a plain fork & knife for anything not explicitly mapped. */
const TAG_ICON = {
  'bars': '🍸', 'sports bars': '🏈', 'tiki bars': '🌺', 'cocktail bars': '🍹',
  'steakhouses': '🥩', 'burgers': '🍔', 'chicken': '🍗', 'bbq': '🍖',
  'ramen': '🍜', 'sushi': '🍣', 'chinese': '🇨🇳', 'japanese': '🇯🇵',
  'korean': '🇰🇷', 'asian fusion': '🥢', 'desserts': '🍰',
  'indian': '🇮🇳', 'dinner dates': '💕',
  'hoagie': '🥪', 'sandwich': '🥪', 'cheesesteak': '🧀', 'bagel': '🥯', 'wrap': '🌯',
  'pizza': '🍕',
  'mexican': '🇲🇽', 'peruvian': '🇵🇪', 'swiss': '🇨🇭', 'seafood': '🦐',
  'breakfast': '🍳', 'brunch': '🥞', 'rooftop': '🏙️',
  'ice cream': '🍦', 'bakery': '🥐', 'frozen yogurt': '🍧',
  'happy hour': '🍻', 'late night': '🌙', 'jamaican': '🇯🇲', 'soul food': '🍲', 'italian': '🇮🇹', 'pasta': '🍝',
  'american': '🇺🇸',
  // Group/guide labels — every rail entry gets a real icon, never the 🍴 fallback.
  'asian': '🥢', 'caribbean': '🏝️', 'european': '🇪🇺', 'latin american': '🌮',
  'sandwiches': '🥪', 'special events': '🎉', 'chicago gems': '💎',
  'wine bars': '🍷',
  'thai': '🇹🇭', 'vietnamese': '🇻🇳', 'indonesian': '🇮🇩', 'afghan': '🇦🇫',
  'brazilian': '🇧🇷', 'spanish': '🇪🇸', 'french': '🇫🇷', 'greek': '🇬🇷',
  'mediterranean': '🫒', 'middle eastern': '🧆', 'lebanese': '🇱🇧',
  'turkish': '🇹🇷', 'african': '🌍', 'vegan': '🥦', 'cafes': '☕',
};
function tagIcon(tag){
  return TAG_ICON[tag.toLowerCase()] || '🍴';
}

/* Google Places types -> guide tags, so a new listing's categories fill in
   automatically on selection. Covers Google's whole food-and-drink type
   table; only the truly generic types (restaurant, food_court, meal_takeaway,
   meal_delivery, fast_food_restaurant, cafeteria, buffet_restaurant) stay
   unmapped — they say nothing about the food, and the Filing-under chips in
   the add modal let you set the guide by hand before saving. */
const GOOGLE_TYPE_TAG = {
  // Cuisines
  pizza_restaurant: 'Pizza',
  italian_restaurant: 'Italian',
  japanese_restaurant: 'Japanese',
  sushi_restaurant: 'Sushi',
  ramen_restaurant: 'Ramen',
  chinese_restaurant: 'Chinese',
  korean_restaurant: 'Korean',
  asian_restaurant: 'Asian Fusion',
  thai_restaurant: 'Thai',
  vietnamese_restaurant: 'Vietnamese',
  indonesian_restaurant: 'Indonesian',
  indian_restaurant: 'Indian',
  afghani_restaurant: 'Afghan',
  mexican_restaurant: 'Mexican',
  brazilian_restaurant: 'Brazilian',
  spanish_restaurant: 'Spanish',
  french_restaurant: 'French',
  greek_restaurant: 'Greek',
  mediterranean_restaurant: 'Mediterranean',
  middle_eastern_restaurant: 'Middle Eastern',
  lebanese_restaurant: 'Lebanese',
  turkish_restaurant: 'Turkish',
  african_restaurant: 'African',
  american_restaurant: 'American',
  // Formats
  steak_house: 'Steakhouses',
  hamburger_restaurant: 'Burgers',
  barbecue_restaurant: 'BBQ',
  seafood_restaurant: 'Seafood',
  breakfast_restaurant: 'Breakfast',
  brunch_restaurant: 'Brunch',
  diner: 'Breakfast',
  vegan_restaurant: 'Vegan',
  vegetarian_restaurant: 'Vegan',
  // Sweets
  bakery: 'Bakery',
  donut_shop: 'Bakery',
  ice_cream_shop: 'Ice Cream',
  dessert_shop: 'Desserts',
  dessert_restaurant: 'Desserts',
  candy_store: 'Desserts',
  chocolate_shop: 'Desserts',
  chocolate_factory: 'Desserts',
  confectionery: 'Desserts',
  acai_shop: 'Desserts',
  juice_shop: 'Desserts',
  // Sandwiches & counters
  sandwich_shop: 'Sandwiches',
  bagel_shop: 'Sandwiches',
  deli: 'Sandwiches',
  // Cafes
  cafe: 'Cafes',
  coffee_shop: 'Cafes',
  tea_house: 'Cafes',
  cat_cafe: 'Cafes',
  dog_cafe: 'Cafes',
  // Bars & nightlife
  bar: 'Bars',
  pub: 'Bars',
  wine_bar: 'Wine Bars',
  bar_and_grill: 'Bars',
  night_club: 'Late Night',
};

/* Escapes &, <, > via the DOM, then quotes by hand — this output is used
   inside double- and single-quoted HTML attributes throughout, so an
   unescaped quote in a dish/tag/restaurant name would break the markup. */
function escapeHtml(s){
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function getFilteredSortedList(){
  let list = restaurants.filter(r => restaurantInArea(r, activeArea));
  list = list.filter(r => activeCategory==='All' || restaurantMatchesLabel(r, activeCategory, activeSubTag));
  if(searchQuery.trim()){
    const q = searchQuery.trim().toLowerCase();
    list = list.filter(r => r.name.toLowerCase().includes(q));
  }
  if(unvisitedOnly){
    list = list.filter(r => visitsFor(r.id).length === 0);
  }
  if(gemsOnly){
    list = list.filter(isGem);
  }
  if(recentOnly){
    list = list.filter(r => r.createdAt && (Date.now() - r.createdAt) < 30*24*60*60*1000);
  }
  return sortRestaurants(list);
}

function renderContent(){
  const el = $('#content');
  const list = getFilteredSortedList();
  if(list.length === 0){
    el.className = '';
    el.innerHTML = restaurants.length === 0
      ? `<div class="empty"><b>No listings in this book yet</b>Add your first stop to start tracking it.</div>`
      : `<div class="empty"><b>No listings match</b>Try a different search, filter, or tab.</div>`;
    if(leafletMap){ try{ leafletMap.remove(); }catch(e){} leafletMap = null; }
    return;
  }
  if(viewMode === 'map'){
    renderMapView(el, list);
    return;
  }
  if(leafletMap){ try{ leafletMap.remove(); }catch(e){} leafletMap = null; }
  el.className = 'grid';
  el.innerHTML = list.map(r=>{
    const vs = visitsFor(r.id);
    const avg = avgRating(vs);
    const visited = vs.length > 0;
    const tags = displayTags(r.categories);
    const showDist = sortBy === 'distance' && userLocation && r.lat!=null && r.lng!=null;
    const distTxt = showDist ? distanceMiles(userLocation.lat, userLocation.lng, r.lat, r.lng).toFixed(1) + ' mi' : null;
    return `
      <div class="ticket" data-id="${r.id}">
        ${isGem(r) ? `<div class="gem-badge" title="Chicago Gem">💎</div>` : ''}
        ${visited ? `<div class="stamp"><svg viewBox="-4 -4 8 8" xmlns="http://www.w3.org/2000/svg"><path fill="currentColor" d="M0,-4 L0.8,-1.39 L3.46,-2 L1.6,0 L3.46,2 L0.8,1.39 L0,4 L-0.8,1.39 L-3.46,2 L-1.6,0 L-3.46,-2 L-0.8,-1.39 Z"/></svg>VISITED</div>` : ''}
        <div class="ticket-tags">${tags.map(t=>`<span class="card-tag">${tagIcon(t)} ${escapeHtml(singularizeTag(t))}</span>`).join('')}</div>
        <div class="ticket-name">${nameLinkHtml(r, true)}</div>
        ${r.address ? `<div class="ticket-addr"><a href="${r.mapsUrl || ('https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(r.name + ' ' + r.address))}" target="_blank" rel="noopener" class="addr-link" onclick="event.stopPropagation()">${escapeHtml(r.address)}</a></div>` : ''}
        <div class="ticket-meta">
          <span>${vs.length} visit${vs.length===1?'':'s'}${distTxt ? ` &nbsp;·&nbsp; <span class="dist-badge">${distTxt}</span>` : ''}</span>
          <span class="stars">${avg ? starString(avg) : '—'}</span>
        </div>
      </div>
    `;
  }).join('');
  $$('.ticket', el).forEach(card=>{
    card.addEventListener('click', ()=> openDetail(card.dataset.id));
    attachTilt(card);
  });
}

/* Leaflet loads lazily: the landing and grid views never need it, so the
   library (~180KB css+js) only downloads the first time the Map view is
   opened. The service worker keeps it cached after that, offline included. */
let leafletLoadPromise = null;
function loadLeaflet(){
  if(typeof L !== 'undefined') return Promise.resolve(true);
  if(leafletLoadPromise) return leafletLoadPromise;
  leafletLoadPromise = new Promise((resolve)=>{
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css';
    document.head.appendChild(css);
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js';
    s.onload = ()=> resolve(true);
    s.onerror = ()=>{ leafletLoadPromise = null; resolve(false); };
    document.head.appendChild(s);
  });
  return leafletLoadPromise;
}

/* Map view: a real interactive street map (Leaflet + OpenStreetMap tiles).
   If the library or tiles can't load (offline, sandboxed preview), it swaps
   to a self-contained relative-position map that needs no network at all. */
function renderMapView(el, list){
  const myToken = ++mapRenderToken;
  const withCoords = list.filter(r => r.lat != null && r.lng != null);
  const withoutCoords = list.length - withCoords.length;
  el.className = '';

  if(withCoords.length === 0){
    el.innerHTML = `<div class="empty"><b>No locations to plot</b>None of the places in this view have coordinates on file yet.</div>`;
    return;
  }

  const noteHtml = withoutCoords > 0
    ? `<div class="map-note">${withoutCoords} listing${withoutCoords===1?'':'s'} in this view ${withoutCoords===1?"doesn't":"don't"} have a location yet, so ${withoutCoords===1?"it isn't":"they aren't"} plotted.</div>`
    : '';

  if(leafletMap){ try{ leafletMap.remove(); }catch(e){} leafletMap = null; }

  if(typeof L === 'undefined'){
    el.innerHTML = `<div class="loading">Loading the map…</div>`;
    loadLeaflet().then(ok=>{
      if(myToken !== mapRenderToken) return; // view changed while loading
      if(!ok){ renderRelativeMap(el, withCoords, noteHtml, true); return; }
      renderLeafletMap(el, withCoords, noteHtml, myToken);
    });
    return;
  }

  renderLeafletMap(el, withCoords, noteHtml, myToken);
}

function renderLeafletMap(el, withCoords, noteHtml, myToken){
  el.innerHTML = `<div class="map-wrap"><div id="leafletMapEl" style="height:520px;"></div></div>${noteHtml}`;

  const bounds = withCoords.map(r=>[r.lat, r.lng]);
  const center = bounds[0];
  leafletMap = L.map('leafletMapEl', { scrollWheelZoom: true }).setView(center, 11);
  const tileLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors', maxZoom: 19
  });
  let tilesOk = false;
  tileLayer.on('load', ()=>{ tilesOk = true; });
  tileLayer.addTo(leafletMap);

  withCoords.forEach(r=>{
    const vs = visitsFor(r.id);
    const visited = vs.length > 0;
    const color = visited ? '#E23A50' : '#4FA8DE';
    const marker = L.circleMarker([r.lat, r.lng], {
      radius: 8, color: '#12302799', weight: 2, fillColor: color, fillOpacity: 0.95
    }).addTo(leafletMap);
    const avg = avgRating(vs);
    const mapsHref = r.mapsUrl || ('https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(r.name + ' ' + (r.address||'')));
    marker.bindPopup(`
      <div class="map-popup-cat">${displayTags(r.categories).map(t=>tagIcon(t)+' '+escapeHtml(singularizeTag(t))).join(' · ')}</div>
      <div class="map-popup-name">${escapeHtml(r.name)}</div>
      <div style="font-size:11px;">${vs.length} visit${vs.length===1?'':'s'}${avg ? ' · ' + starString(avg) : ''}</div>
      <a class="map-popup-link" href="${mapsHref}" target="_blank" rel="noopener">📍 Maps</a>
      ${r.website ? `<a class="map-popup-link" href="${escapeHtml(r.website)}" target="_blank" rel="noopener">🌐 Website</a>` : ''}
      ${r.yelp ? `<a class="map-popup-link" href="${escapeHtml(r.yelp)}" target="_blank" rel="noopener">⭐ Yelp</a>` : ''}
      <a class="map-popup-link" href="javascript:void(0)" onclick="openDetail('${r.id}')">View details</a>
    `);
    marker.on('mouseover', ()=> marker.openPopup());
  });
  if(bounds.length > 1){
    leafletMap.fitBounds(bounds, { padding: [30,30] });
  }

  setTimeout(()=>{
    if(myToken !== mapRenderToken) return; // a newer render happened, ignore
    if(!tilesOk){
      if(leafletMap){ try{ leafletMap.remove(); }catch(e){} leafletMap = null; }
      renderRelativeMap(el, withCoords, noteHtml, true);
    }
  }, 2500);
}

/* Self-contained fallback: plots pins by relative position within the
   list's coordinate bounds. No external network access needed. */
function renderRelativeMap(el, withCoords, noteHtml, wasFallback){
  let minLat = Math.min(...withCoords.map(r=>r.lat));
  let maxLat = Math.max(...withCoords.map(r=>r.lat));
  let minLng = Math.min(...withCoords.map(r=>r.lng));
  let maxLng = Math.max(...withCoords.map(r=>r.lng));
  const latPad = Math.max((maxLat - minLat) * 0.15, 0.01);
  const lngPad = Math.max((maxLng - minLng) * 0.15, 0.01);
  minLat -= latPad; maxLat += latPad; minLng -= lngPad; maxLng += lngPad;

  const pins = withCoords.map(r=>{
    const xPct = ((r.lng - minLng) / (maxLng - minLng)) * 100;
    const yPct = (1 - (r.lat - minLat) / (maxLat - minLat)) * 100;
    const visited = visitsFor(r.id).length > 0;
    return `<button class="map-pin ${visited?'visited':'unvisited'}" style="left:${xPct}%; top:${yPct}%;" data-id="${r.id}" data-x="${xPct}" data-y="${yPct}" title="${escapeHtml(r.name)}"></button>`;
  }).join('');

  el.innerHTML = `
    <div class="map-wrap"><div class="custom-map" id="customMap">${pins}</div></div>
    <div class="map-legend"><span class="legend-dot visited"></span> Visited <span class="legend-dot unvisited"></span> Not yet</div>
    ${wasFallback ? `<div class="map-note">Live map tiles aren't reachable in this preview, so this shows relative positions instead. Download the file and open it in your browser for the full street map.</div>` : ''}
    ${noteHtml}
  `;

  const mapEl = $('#customMap');
  $$('.map-pin', mapEl).forEach(pin=>{
    pin.addEventListener('mouseenter', ()=> showMapPopup(mapEl, pin));
    pin.addEventListener('click', (e)=>{
      e.stopPropagation();
      showMapPopup(mapEl, pin);
    });
  });
  mapEl.addEventListener('click', ()=>{
    const existing = mapEl.querySelector('.map-popup');
    if(existing) existing.remove();
  });
}

function showMapPopup(mapEl, pinEl){
  const existing = mapEl.querySelector('.map-popup');
  if(existing) existing.remove();
  const id = pinEl.dataset.id;
  const r = restaurants.find(x=>x.id===id);
  if(!r) return;
  const vs = visitsFor(id);
  const avg = avgRating(vs);
  const mapsHref = r.mapsUrl || ('https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(r.name + ' ' + (r.address||'')));
  const popup = document.createElement('div');
  popup.className = 'map-popup';
  popup.style.left = pinEl.dataset.x + '%';
  popup.style.top = pinEl.dataset.y + '%';
  popup.innerHTML = `
    <button class="close-x">×</button>
    <div class="map-popup-cat">${displayTags(r.categories).map(t=>tagIcon(t)+' '+escapeHtml(singularizeTag(t))).join(' · ')}</div>
    <div class="map-popup-name">${escapeHtml(r.name)}</div>
    <div style="font-size:11px;color:var(--cream-dim);">${vs.length} visit${vs.length===1?'':'s'}${avg ? ' · ' + starString(avg) : ''}</div>
    <a class="map-popup-link" href="${mapsHref}" target="_blank" rel="noopener">📍 Maps</a>
    ${r.website ? `<a class="map-popup-link" href="${escapeHtml(r.website)}" target="_blank" rel="noopener">🌐 Website</a>` : ''}
    ${r.yelp ? `<a class="map-popup-link" href="${escapeHtml(r.yelp)}" target="_blank" rel="noopener">⭐ Yelp</a>` : ''}
    <a class="map-popup-link" href="javascript:void(0)" data-detail="${id}">View details</a>
  `;
  mapEl.appendChild(popup);
  popup.addEventListener('click', (e)=> e.stopPropagation());
  popup.querySelector('.close-x').addEventListener('click', ()=> popup.remove());
  popup.querySelector('[data-detail]').addEventListener('click', ()=>{ popup.remove(); openDetail(id); });
}


/* ---------- Neighborhoods landing page ---------- */
function areaCounts(){
  const hoods = {};
  const townByRegion = {};
  let unassigned = 0;
  restaurants.forEach(r=>{
    if(r.region && r.region !== 'Chicago'){
      const region = REGION_ORDER.includes(r.region) ? r.region : 'Other Suburbs';
      (townByRegion[region] = townByRegion[region] || {});
      townByRegion[region][r.town] = (townByRegion[region][r.town] || 0) + 1;
    } else if(r.neighborhood){
      hoods[r.neighborhood] = (hoods[r.neighborhood] || 0) + 1;
    } else {
      unassigned++;
    }
  });
  return { hoods, townByRegion, unassigned };
}

/* Every area keeps one color forever — hashed from its name, not its render
   order — so the landing reads like a map legend you can memorize. */
const BLOCK_PALETTE = [
  ['#9DC3F0', '#152A45'], // blue
  ['#C9A6E8', '#2E1B45'], // purple
  ['#A9D8A4', '#1C3418'], // green
  ['#F2B8D4', '#421B30'], // pink
  ['#E8C983', '#3D2D0F'], // gold
  ['#DE8F84', '#401713'], // coral
  ['#8FD8CE', '#113531'], // teal
  ['#EFB08C', '#3E2311'], // peach
];
function blockColor(name){
  let h = 0;
  for(const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return BLOCK_PALETTE[h % BLOCK_PALETTE.length];
}

/* Boundary features backing an area's block. A renamed pair like
   Douglas + Grand Boulevard -> Bronzeville returns both features, so the
   merged area draws (and centers) as one combined shape. */
function areaFeatures(area){
  if(area.type === 'neighborhood' && hoodGeo){
    return (hoodGeo.features || []).filter(f => displayHoodName(f.properties.pri_neigh) === area.name);
  }
  if(area.type === 'town' && townGeo){
    return (townGeo.features || []).filter(f => f.properties.BASENAME === area.name);
  }
  return [];
}
function featurePolys(f){
  const g = f.geometry;
  return g.type === 'MultiPolygon' ? g.coordinates : (g.type === 'Polygon' ? [g.coordinates] : []);
}

/* The area's true outline from the boundary file, fitted into a 100x100
   viewBox for the block watermark. Longitude is compressed by
   cos(latitude) first so the shape keeps its real-world proportions. */
function areaShapePath(area){
  const polys = areaFeatures(area).flatMap(featurePolys);
  if(!polys.length) return null;
  const LNG_SCALE = Math.cos(41.85 * Math.PI / 180);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  polys.forEach(p => p[0].forEach(([lng, lat])=>{
    const x = lng * LNG_SCALE;
    if(x < minX) minX = x; if(x > maxX) maxX = x;
    if(lat < minY) minY = lat; if(lat > maxY) maxY = lat;
  }));
  const scale = 100 / Math.max(maxX - minX, maxY - minY);
  const ox = (100 - (maxX - minX) * scale) / 2;
  const oy = (100 - (maxY - minY) * scale) / 2;
  return polys.map(p =>
    p[0].map(([lng, lat], i)=>{
      const x = ((lng * LNG_SCALE - minX) * scale + ox).toFixed(1);
      const y = ((maxY - lat) * scale + oy).toFixed(1);
      return `${i ? 'L' : 'M'}${x} ${y}`;
    }).join('') + 'Z'
  ).join('');
}

function areaStats(area){
  const list = restaurants.filter(r => restaurantInArea(r, area));
  const visited = list.filter(r => visitsFor(r.id).length > 0).length;
  const iconCounts = {};
  list.forEach(r => (r.categories || []).forEach(t=>{
    if(BADGE_TAGS.has(t)) return;
    const icon = tagIcon(t);
    iconCounts[icon] = (iconCounts[icon] || 0) + 1;
  }));
  const icons = Object.entries(iconCounts).sort((a,b)=> b[1] - a[1]).slice(0, 3).map(e => e[0]);
  return { count: list.length, visited, icons };
}

function areaBlockHTML(area){
  const stats = areaStats(area);
  const [bg, ink] = blockColor(area.name);
  const shape = areaShapePath(area);
  const ghost = stats.count === 0;
  return `
    <button class="area-block${ghost ? ' ghost' : ''}" data-type="${area.type}" data-name="${escapeHtml(area.name)}" style="--block:${bg};--ink:${ink};">
      ${shape ? `<svg class="block-shape" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet" aria-hidden="true"><path d="${shape}"/></svg>` : ''}
      <span class="block-name">${escapeHtml(area.name)}</span>
      ${ghost ? '' : `
      ${stats.icons.length ? `<span class="block-icons">${stats.icons.join(' ')}</span>` : ''}
      <span class="block-meta">${stats.count} spot${stats.count===1?'':'s'}${stats.visited ? ` · ${stats.visited}/${stats.count} visited` : ''}</span>`}
    </button>`;
}

function renderAreasPage(){
  const el = $('#areasPage');
  const { hoods, townByRegion, unassigned } = areaCounts();

  // Stocked neighborhoods lead, in map-reading order. The empty ones stay
  // behind a toggle so the landing is pure signal, not dashed placeholders.
  const ghostNames = [];
  if(hoodGeo) (hoodGeo.features || []).forEach(f=>{
    const name = displayHoodName(f.properties.pri_neigh);
    if(!HOOD_EXCLUDE.has(name) && !hoods[name] && !ghostNames.includes(name)) ghostNames.push(name);
  });
  // Chicago splits into its sides (Downtown / North / West / South / East),
  // neighborhoods A–Z within each. Unexplored ones join their side when
  // the ghost toggle is on, so the landing stays pure signal by default.
  const az = (a, b) => a.localeCompare(b);
  const sideStocked = {}, sideGhosts = {};
  Object.keys(hoods).forEach(name => (sideStocked[sideForHood(name)] ||= []).push(name));
  ghostNames.forEach(name => (sideGhosts[sideForHood(name)] ||= []).push(name));
  const sideSections = CHI_SIDES.map(side=>{
    const blocks = (sideStocked[side] || []).sort(az).map(name => areaBlockHTML({ type:'neighborhood', name })).join('')
      + (showGhosts ? (sideGhosts[side] || []).sort(az).map(name => areaBlockHTML({ type:'neighborhood', name })).join('') : '');
    if(!blocks) return '';
    return `<div class="area-side-label">${escapeHtml(side)}</div><div class="area-blocks">${blocks}</div>`;
  }).join('');
  const elsewhereBlock = unassigned ? `<div class="area-blocks">${areaBlockHTML({ type:'other', name:'Elsewhere in Chicago' })}</div>` : '';
  const chicagoSection = (sideSections || ghostNames.length) ? `
    <div class="area-group-label">Chicago</div>
    ${sideSections}
    ${elsewhereBlock}
    ${ghostNames.length ? `<button class="ghost-toggle" id="ghostToggle">${showGhosts ? 'Hide' : 'Show'} ${ghostNames.length} unexplored neighborhood${ghostNames.length===1?'':'s'} ${showGhosts ? '▴' : '▾'}</button>` : ''}` : '';
  const suburbGroups = REGION_ORDER.filter(region => townByRegion[region]).map(region=>{
    const blocks = Object.keys(townByRegion[region]).sort(az).map(town => areaBlockHTML({ type:'town', name: town })).join('');
    return `<div class="area-group-label">${escapeHtml(region)}</div><div class="area-blocks">${blocks}</div>`;
  }).join('');

  el.innerHTML = `
    <div class="areas-head">
      <div>
        <div class="areas-title">Pick your territory</div>
        <div class="areas-sub">Tap a neighborhood and its spots and cuisines pop up.</div>
      </div>
      <div class="areas-head-actions">
        <button class="btn secondary" id="addFromAreas">+ New Listing</button>
        <button class="btn" id="browseAllBtn">Browse all listings →</button>
      </div>
    </div>
    <div class="area-groups">
      ${chicagoSection}
      ${suburbGroups}
    </div>
    <div class="data-row">
      <span>Your whole ledger lives on this device.</span>
      <button class="link-btn" id="exportBtn">⤓ Export backup</button>
      <button class="link-btn" id="importBtn">⤒ Restore backup</button>
      <input type="file" id="importFile" accept="application/json,.json" style="display:none;">
    </div>
  `;

  $('#browseAllBtn').addEventListener('click', ()=>{ activeArea = null; currentPage = 'listings'; renderAll(); });
  $('#addFromAreas').addEventListener('click', openAddRestaurant);
  $('#exportBtn').addEventListener('click', exportBackup);
  $('#importBtn').addEventListener('click', ()=> $('#importFile').click());
  $('#importFile').addEventListener('change', (e)=>{
    if(e.target.files[0]) importBackup(e.target.files[0]);
    e.target.value = '';
  });
  $$('.area-block', el).forEach(block=>{
    block.addEventListener('click', ()=> openArea({ type: block.dataset.type, name: block.dataset.name }));
  });
  const ghostToggle = $('#ghostToggle');
  if(ghostToggle) ghostToggle.addEventListener('click', ()=>{
    showGhosts = !showGhosts;
    renderAreasPage();
  });
}

function renderAreaBanner(){
  const el = $('#areaBanner');
  if(currentPage !== 'listings'){ el.style.display = 'none'; return; }
  el.style.display = 'flex';
  const count = restaurants.filter(r => restaurantInArea(r, activeArea)).length;
  el.innerHTML = `
    <button class="btn secondary small" id="backToAreas">← Neighborhoods</button>
    ${activeArea
      ? `<span class="area-pill">📍 ${escapeHtml(activeArea.name)} · ${count} spot${count===1?'':'s'} <button class="tag-x" id="clearArea" title="Show all of Chicagoland">×</button></span>`
      : `<span class="area-all-note">All of Chicagoland</span>`}
  `;
  $('#backToAreas').addEventListener('click', ()=>{ currentPage = 'areas'; activeArea = null; renderAll(); });
  const clearBtn = $('#clearArea');
  if(clearBtn) clearBtn.addEventListener('click', ()=>{ activeArea = null; renderAll(); });
}

function renderPageVisibility(){
  const listings = currentPage === 'listings';
  $('#areasPage').style.display = listings ? 'none' : '';
  $('#listingsLayout').style.display = listings ? '' : 'none';
  if(!listings){
    closeRail();
    if(leafletMap){ try{ leafletMap.remove(); }catch(e){} leafletMap = null; }
  }
}

function renderAll(){
  renderPageVisibility();
  renderStats();
  if(currentPage === 'listings'){
    renderCuisineRail();
    renderContent();
  } else {
    renderAreasPage();
  }
  renderAreaBanner();
  renderProfileChip();
  syncHash();
}

/* ---------- Modals ---------- */
function closeModal(){ $('#modalRoot').innerHTML = ''; }

/* External pages always open in a real new tab. The old in-app iframe popup
   is gone for good reason: Facebook, Yelp, and most ordering platforms send
   X-Frame-Options / frame-ancestors and render silently blank in a frame,
   and browsers give no cross-origin way to detect it. */
function nameLinkHtml(r, stopProp){
  const url = r.website || r.yelp;
  if(!url) return escapeHtml(r.name);
  return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener" class="name-link"${stopProp ? ' onclick="event.stopPropagation()"' : ''}>${escapeHtml(r.name)}</a>`;
}

/* ---------- Reviewer profiles (device-local usernames) ---------- */
function renderProfileChip(){
  const p = activeProfile();
  $('#profileBtn').textContent = p ? `👤 ${p.name}` : '👤 Set reviewer';
}
function openProfiles(){
  $('#modalRoot').innerHTML = `
    <div class="overlay" id="ovP">
      <div class="modal">
        <button class="close" id="closeProf">×</button>
        <h2>Reviewers</h2>
        <div class="sub" style="font-size:11.5px;color:var(--cream-dim);">Usernames live on this device. New visits get stamped with whoever's active — tap a name to switch.</div>
        <div id="profileList" style="margin-top:14px;">
          ${profiles.length ? profiles.map(p=>`
            <div class="profile-row ${p.id===activeProfileId?'active':''}" data-pid="${p.id}">
              <span class="profile-name">${escapeHtml(p.name)}</span>
              ${p.id===activeProfileId ? '<span class="profile-active-tag">reviewing</span>' : ''}
              <button class="trash" data-del="${p.id}">remove</button>
            </div>`).join('') : '<div class="no-visits">No reviewers yet — add the first one below.</div>'}
        </div>
        <div class="field">
          <label>New reviewer</label>
          <div style="display:flex; gap:8px;">
            <input type="text" id="newProfileName" placeholder="e.g. Brianna">
            <button class="btn small" id="addProfileBtn">Add</button>
          </div>
        </div>
      </div>
    </div>
  `;
  $('#closeProf').addEventListener('click', closeModal);
  $('#ovP').addEventListener('click', (e)=>{ if(e.target.id==='ovP') closeModal(); });
  $$('.profile-row', $('#modalRoot')).forEach(row=>{
    row.addEventListener('click', async ()=>{
      activeProfileId = row.dataset.pid;
      await saveProfiles();
      renderProfileChip();
      openProfiles();
    });
  });
  $$('#profileList .trash').forEach(btn=>{
    btn.addEventListener('click', async (e)=>{
      e.stopPropagation();
      const p = profiles.find(x=>x.id===btn.dataset.del);
      if(!p) return;
      if(!confirm(`Remove reviewer "${p.name}"? Their past visits keep the name.`)) return;
      profiles = profiles.filter(x=>x.id!==p.id);
      if(activeProfileId === p.id) activeProfileId = profiles.length ? profiles[0].id : null;
      await saveProfiles();
      renderProfileChip();
      openProfiles();
    });
  });
  const addProfile = async ()=>{
    const name = $('#newProfileName').value.trim();
    if(!name) return;
    if(profiles.some(p => p.name.toLowerCase() === name.toLowerCase())){
      alert('That username is already taken on this device.');
      return;
    }
    const p = { id: uid(), name };
    profiles.push(p);
    activeProfileId = p.id;
    await saveProfiles();
    renderProfileChip();
    openProfiles();
  };
  $('#addProfileBtn').addEventListener('click', addProfile);
  $('#newProfileName').addEventListener('keydown', (e)=>{
    if(e.key === 'Enter'){ e.preventDefault(); addProfile(); }
  });
}

function openAddRestaurant(){
  $('#modalRoot').innerHTML = `
    <div class="overlay" id="ov">
      <div class="modal">
        <button class="close" id="closeAdd">×</button>
        <h2>New Listing</h2>
        <div class="sub" style="font-size:11.5px;color:var(--cream-dim);">Search it, tap it, done — address, website, and cuisines fill themselves.</div>
        <div class="places-notice" id="placesNotice" style="display:none;">
          ⚠️ Google Maps is rejecting requests from this address (API key referrer restrictions),
          so search is unavailable — add the key's allowed referrers in Google Cloud Console.
          Manual entry is open below.
        </div>
        <div class="field">
          <label>Name <span style="text-transform:none;">(search for the restaurant)</span></label>
          <div id="nameAutocompleteContainer"></div>
          <input type="text" id="rName" placeholder="e.g. The Anchor Room" style="display:none;">
        </div>
        <div class="field" id="manualAddrField" style="display:none;">
          <label>Address</label>
          <div class="addr-autocomplete-wrap">
            <input type="text" id="rAddr" placeholder="e.g. 123 Main St" autocomplete="off">
            <ul id="addrSuggestions" class="addr-suggestions" style="display:none;"></ul>
          </div>
        </div>
        <div class="filing-under" id="filingUnder" style="display:none;"></div>
        <div style="margin-top:10px;margin-bottom:4px;">
          <a href="#" id="manualToggle" style="color:var(--flag-blue-bright);text-decoration:underline;cursor:pointer;font-size:11.5px;">Can't find it on Google Maps? Add it manually</a>
        </div>
        <div class="modal-actions">
          <button class="btn secondary" id="cancelAdd">Cancel</button>
          <button class="btn" id="saveAdd">Add Listing</button>
        </div>
      </div>
    </div>
  `;
  $('#closeAdd').addEventListener('click', closeModal);
  $('#cancelAdd').addEventListener('click', closeModal);
  $('#ov').addEventListener('click', (e)=>{ if(e.target.id==='ov') closeModal(); });

  let selectedPlace = null;
  let manualMode = false;
  let pendingTags = [];
  let manualAddressPlace = null;
  // Chicagoland metro bounding box (city + suburbs), so results outside the area don't show up.
  // Shared by both the restaurant-name search below and the manual-mode address autocomplete.
  const CHICAGOLAND = { north: 42.3, south: 41.2, east: -87.3, west: -88.4 };
  /* Editable guide chips, live in the modal before saving. Google's
     suggestions land here first, but the final say is the user's — so a
     spot never has to be saved untagged, manual mode included. */
  function renderFilingUnder(){
    const fu = $('#filingUnder');
    if(!fu) return;
    fu.style.display = '';
    const datalist = categories().map(c=>`<option value="${escapeHtml(c)}">`).join('');
    fu.innerHTML = `Filing under:
      ${pendingTags.map(t=>`<span class="tag-pill">${tagIcon(t)} ${escapeHtml(t)}<button class="tag-x" data-tag="${escapeHtml(t)}">×</button></span>`).join('')}
      <input type="text" id="addTagInput" class="tag-add" list="addTagList" placeholder="+ add guide">
      <datalist id="addTagList">${datalist}</datalist>`;
    $$('#filingUnder .tag-x').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        pendingTags = pendingTags.filter(t => t !== btn.dataset.tag);
        renderFilingUnder();
      });
    });
    const inp = $('#addTagInput');
    const commitTag = (refocus)=>{
      const val = inp.value.trim();
      if(!val) return;
      if(!pendingTags.some(t => t.toLowerCase() === val.toLowerCase())) pendingTags.push(val);
      renderFilingUnder();
      if(refocus) $('#addTagInput').focus();
    };
    inp.addEventListener('keydown', (e)=>{ if(e.key === 'Enter'){ e.preventDefault(); commitTag(true); } });
    inp.addEventListener('blur', ()=> commitTag(false));
  }
  function enableManualMode(){
    manualMode = true;
    selectedPlace = null;
    pendingTags = [];
    $('#nameAutocompleteContainer').style.display = 'none';
    $('#rName').style.display = '';
    $('#rName').focus();
    $('#manualAddrField').style.display = '';
    $('#manualToggle').style.display = 'none';
    renderFilingUnder();
  }
  $('#manualToggle').addEventListener('click', (ev)=>{ ev.preventDefault(); enableManualMode(); });

  /* Address autocomplete for manual mode only — the Places-search path
     already gets its address straight from the selected restaurant, so
     #rAddr never even renders there. #rAddr stays the actual source of
     truth (typing a freeform address and never picking a suggestion still
     saves fine, same as before); suggestions are a layered enhancement
     that additionally captures lat/lng, which manual entries never got
     before and which the map view / neighborhood filing both need. */
  let addrDebounce = null;
  const addrList = $('#addrSuggestions');
  function hideAddrSuggestions(){
    addrList.style.display = 'none';
    addrList.innerHTML = '';
  }
  $('#rAddr').addEventListener('input', ()=>{
    manualAddressPlace = null; // any edit invalidates a previously picked match
    clearTimeout(addrDebounce);
    const q = $('#rAddr').value.trim();
    if(q.length < 4){ hideAddrSuggestions(); return; }
    addrDebounce = setTimeout(async ()=>{
      try{
        const { AutocompleteSuggestion } = await google.maps.importLibrary('places');
        const { suggestions } = await AutocompleteSuggestion.fetchAutocompleteSuggestions({
          input: q,
          locationRestriction: CHICAGOLAND,
          includedPrimaryTypes: ['geocode'],
        });
        if($('#rAddr').value.trim() !== q) return; // stale response, input moved on
        if(!suggestions || !suggestions.length){ hideAddrSuggestions(); return; }
        const picks = suggestions.slice(0, 6);
        addrList.innerHTML = picks.map((s, i)=>`<li data-i="${i}">${escapeHtml(s.placePrediction.text.text)}</li>`).join('');
        addrList.style.display = '';
        $$('li', addrList).forEach((li, i)=>{
          li.addEventListener('mousedown', async (ev)=>{
            ev.preventDefault(); // fires before #rAddr's blur, so the pick isn't lost
            const prediction = picks[i].placePrediction;
            const place = prediction.toPlace();
            await place.fetchFields({ fields: ['formattedAddress', 'location'] });
            $('#rAddr').value = place.formattedAddress || prediction.text.text;
            manualAddressPlace = place.location ? { lat: place.location.lat(), lng: place.location.lng() } : null;
            hideAddrSuggestions();
          });
        });
      }catch(err){
        console.warn('Address autocomplete unavailable — manual typing still works.', err);
        hideAddrSuggestions();
      }
    }, 300);
  });
  $('#rAddr').addEventListener('blur', ()=> setTimeout(hideAddrSuggestions, 150));

  (async ()=>{
    try{
      const { PlaceAutocompleteElement, AutocompleteSuggestion } = await google.maps.importLibrary('places');
      const pac = new PlaceAutocompleteElement();
      pac.includedPrimaryTypes = ['restaurant', 'cafe', 'bar', 'bakery', 'meal_takeaway'];
      pac.locationRestriction = CHICAGOLAND;
      $('#nameAutocompleteContainer').appendChild(pac);
      pac.addEventListener('gmp-select', async ({ placePrediction })=>{
        const place = placePrediction.toPlace();
        await place.fetchFields({ fields: ['displayName','formattedAddress','location','internationalPhoneNumber','websiteURI','id','types','primaryType'] });
        // Cuisines map themselves from Google's classification, then land
        // in the Filing-under chips where they can be adjusted before saving.
        const types = [place.primaryType, ...(place.types || [])].filter(Boolean);
        const tags = [];
        types.forEach(t=>{
          const tag = GOOGLE_TYPE_TAG[t];
          if(tag && !tags.includes(tag)) tags.push(tag);
        });
        selectedPlace = {
          name: place.displayName || '',
          address: place.formattedAddress || '',
          lat: place.location ? place.location.lat() : null,
          lng: place.location ? place.location.lng() : null,
          phone: place.internationalPhoneNumber || null,
          website: place.websiteURI || null,
          placeId: place.id || null,
        };
        pendingTags = tags;
        renderFilingUnder();
      });
      // Probe one real request: a referrer-blocked or misconfigured API key
      // renders the widget fine but 403s every suggestion, which looks like
      // a dead search box. Surface that loudly and open manual entry.
      try{
        await AutocompleteSuggestion.fetchAutocompleteSuggestions({
          input: 'pizza',
          locationRestriction: CHICAGOLAND,
        });
      }catch(probeErr){
        console.warn('Places requests are blocked for this origin.', probeErr);
        $('#placesNotice').style.display = '';
        enableManualMode();
      }
    } catch(err){
      console.warn('Places Autocomplete unavailable — falling back to manual entry.', err);
      enableManualMode();
    }
  })();

  $('#saveAdd').addEventListener('click', async (e)=>{
    const name = manualMode ? $('#rName').value.trim() : (selectedPlace ? selectedPlace.name : '');
    const address = manualMode ? $('#rAddr').value.trim() : (selectedPlace ? selectedPlace.address : '');
    if(!name || (manualMode && !address)){
      alert(manualMode ? 'Name and address are required. (If it\'s not on Google Maps, the full address is on you.)' : 'Search and select a restaurant, or switch to manual entry.');
      return;
    }
    if(!pendingTags.length){
      alert('Add at least one guide before saving — type one into "Filing under" below.');
      return;
    }
    const record = { id: uid(), name, categories: [...pendingTags], address, createdAt: Date.now() };
    if(selectedPlace && !manualMode){
      if(selectedPlace.lat != null) record.lat = selectedPlace.lat;
      if(selectedPlace.lng != null) record.lng = selectedPlace.lng;
      if(selectedPlace.phone) record.phone = selectedPlace.phone;
      if(selectedPlace.website) record.website = selectedPlace.website;
      if(selectedPlace.placeId) record.mapsUrl = `https://www.google.com/maps/place/?q=place_id:${selectedPlace.placeId}`;
    }
    if(manualMode && manualAddressPlace){
      record.lat = manualAddressPlace.lat;
      record.lng = manualAddressPlace.lng;
    }
    assignAreaFields(record);
    restaurants.push(record);
    await saveRestaurants();
    const rect = e.target.getBoundingClientRect();
    spawnConfetti(rect.left + rect.width/2, rect.top + rect.height/2);
    closeModal();
    renderAll();
  });
}

function openDetail(id){
  const r = restaurants.find(x=>x.id===id);
  if(!r) return;
  const vs = visitsFor(id);
  const cats = categories();
  const datalist = cats.map(c=>`<option value="${escapeHtml(c)}">`).join('');
  $('#modalRoot').innerHTML = `
    <div class="overlay" id="ov">
      <div class="modal">
        <button class="close" id="closeDet">×</button>
        <div class="detail-head">
          <div>
            <div class="tag-row" id="tagRow">
              ${(r.categories||[]).map(t=>`<span class="tag-pill">${escapeHtml(t)}<button class="tag-x" data-tag="${escapeHtml(t)}">×</button></span>`).join('')}
              <input type="text" id="newTag" class="tag-add" list="tagList" placeholder="+ add guide">
              <datalist id="tagList">${datalist}</datalist>
            </div>
            <div class="detail-name">${nameLinkHtml(r)}</div>
            ${r.address ? `<div class="detail-addr">${escapeHtml(r.address)}</div>` : ''}
            <div class="detail-links">
              ${r.mapsUrl ? `<a href="${r.mapsUrl}" target="_blank" rel="noopener" class="link-pill">📍 Open in Google Maps</a>` : (r.address ? `<a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(r.name + ' ' + r.address)}" target="_blank" rel="noopener" class="link-pill">📍 Open in Google Maps</a>` : '')}
              ${r.yelp ? `<a href="${escapeHtml(r.yelp)}" target="_blank" rel="noopener" class="link-pill">⭐ Yelp</a>` : ''}
              ${r.phone ? `<a href="tel:${r.phone.replace(/[^+\d]/g,'')}" class="link-pill">📞 ${escapeHtml(r.phone)}</a>` : ''}
            </div>
          </div>
        </div>
        <div style="margin-top:16px; display:flex; gap:8px;">
          <button class="btn small" id="logVisitBtn">+ Log a Visit</button>
          <button class="btn small danger" id="deleteRestBtn">Delete Listing</button>
        </div>
        <div class="menu-section">
          <h3>Menu</h3>
          <div class="menu-groups ${menuOf(r).length > 40 ? 'cols3' : ''}" id="menuChips">
            ${menuGroupsFor(r).map(g=>`<div class="menu-group">
                ${g.title ? `<div class="menu-group-title">${escapeHtml(g.title)}</div>` : ''}
                ${g.dishes.map(d=>`<div class="menu-row"><span>${escapeHtml(d)}</span></div>`).join('')}
              </div>`).join('')
              || '<span class="no-menu">No dishes on file yet — they\'ll collect as visits get logged.</span>'}
          </div>
        </div>
        <div class="visit-list">
          <h3>Visit Ledger</h3>
          <div id="visitItems">
            ${vs.length ? vs.map(v=>`
              <div class="visit-item" data-vid="${v.id}">
                <div class="visit-left">
                  <b>${fmtDate(v.date)}${v.reviewer ? ` <span style="font-weight:500;color:var(--cream-dim);">· by ${escapeHtml(v.reviewer)}</span>` : ''}</b>
                  <span class="stars">${starString(v.rating)}</span>
                  ${ateList(v).length ? `<div class="visit-meta-small">Ate: ${escapeHtml(ateList(v).join(', '))}</div>` : ''}
                  <div class="visit-meta-small">Would return: ${v.wouldReturn ? 'Yes' : 'No'}</div>
                  ${v.notes ? `<div class="visit-meta-small">Notes: ${escapeHtml(v.notes)}</div>` : ''}
                </div>
                <button class="trash" data-vid="${v.id}">remove</button>
              </div>
            `).join('') : '<div class="no-visits">No visits logged yet.</div>'}
          </div>
        </div>
      </div>
    </div>
  `;
  $('#closeDet').addEventListener('click', closeModal);
  $('#ov').addEventListener('click', (e)=>{ if(e.target.id==='ov') closeModal(); });
  $('#logVisitBtn').addEventListener('click', ()=> openLogVisit(id));
  $('#deleteRestBtn').addEventListener('click', async ()=>{
    if(!confirm(`Delete "${r.name}" and all its logged visits? This can't be undone.`)) return;
    restaurants = restaurants.filter(x=>x.id!==id);
    visits = visits.filter(v=>v.restaurantId!==id);
    await saveRestaurants();
    await saveVisits();
    closeModal();
    renderAll();
  });
  $$('.tag-x', $('#modalRoot')).forEach(btn=>{
    btn.addEventListener('click', async (e)=>{
      e.stopPropagation();
      removeTagFromRestaurant(id, btn.dataset.tag);
      await saveRestaurants();
      openDetail(id);
      renderAll();
    });
  });
  const newTagInput = $('#newTag');
  const commitTag = async ()=>{
    const val = newTagInput.value.trim();
    if(!val) return;
    if(addTagToRestaurant(id, val)){
      await saveRestaurants();
      openDetail(id);
      renderAll();
    } else {
      newTagInput.value = '';
    }
  };
  newTagInput.addEventListener('keydown', (e)=>{
    if(e.key === 'Enter'){ e.preventDefault(); commitTag(); }
  });
  newTagInput.addEventListener('blur', commitTag);
  $$('.trash', $('#modalRoot')).forEach(btn=>{
    btn.addEventListener('click', async (e)=>{
      const vid = e.target.dataset.vid;
      visits = visits.filter(v=>v.id!==vid);
      await saveVisits();
      openDetail(id);
      renderAll();
    });
  });
}

function openLogVisit(restaurantId){
  let rating = 0;
  let wouldReturn = null;
  const today = new Date().toISOString().slice(0,10);
  let selectedDate = today;
  let calViewYear = parseInt(today.slice(0,4));
  let calViewMonth = parseInt(today.slice(5,7)) - 1;

  const rest = restaurants.find(x=>x.id===restaurantId);
  const menu = rest ? menuOf(rest) : [];

  $('#modalRoot').innerHTML = `
    <div class="overlay" id="ov2">
      <div class="modal">
        <button class="close" id="closeLog">×</button>
        <h2>Log a Visit</h2>
        ${profiles.length
          ? `<div class="logged-by">Logging as <b>${escapeHtml((activeProfile() || profiles[0]).name)}</b><a href="#" id="switchReviewer">switch</a></div>`
          : `<div class="field">
              <label>Pick your username <span style="text-transform:none;">(first visit only — future visits are stamped automatically)</span></label>
              <input type="text" id="vReviewerNew" placeholder="e.g. Brianna">
            </div>`}
        <div class="field">
          <label>Date</label>
          <button type="button" class="date-display" id="dateDisplay">${fmtDate(selectedDate)}</button>
          <div class="mini-cal" id="miniCal">
            <div class="mini-cal-head">
              <button type="button" id="calPrev">‹</button>
              <span id="calMonthLabel"></span>
              <button type="button" id="calNext">›</button>
            </div>
            <div class="mini-cal-grid" id="calGrid"></div>
          </div>
        </div>
        <div class="field">
          <label>What did you eat? <span style="text-transform:none;">(check everything you had)</span></label>
          <div id="dishArea">
            ${menu.length ? dishChecklistHtml(rest) : ''}
          </div>
          <input type="text" id="vAte" placeholder="+ something not on the menu list">
        </div>
        <div class="field">
          <label>Rating</label>
          <div class="star-pick" id="starPick">
            ${[1,2,3,4,5].map(n=>`<span data-n="${n}">★</span>`).join('')}
          </div>
        </div>
        <div class="field">
          <label>Would you go back?</label>
          <div class="toggle-pair">
            <button class="yes" id="wrYes">Yes</button>
            <button class="no" id="wrNo">No</button>
          </div>
        </div>
        <div class="field">
          <label>Notes <span style="text-transform:none;">(modifications, tips — optional)</span></label>
          <textarea id="vNotes" placeholder="e.g. sub fries for rice, no onions, ask for Jesse"></textarea>
        </div>
        <div class="modal-actions">
          <button class="btn secondary" id="cancelLog">Cancel</button>
          <button class="btn" id="saveLog">Save Visit</button>
        </div>
      </div>
    </div>
  `;

  function renderCalendar(){
    const grid = $('#calGrid');
    const label = $('#calMonthLabel');
    const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    label.textContent = monthNames[calViewMonth] + ' ' + calViewYear;
    const firstDay = new Date(calViewYear, calViewMonth, 1).getDay();
    const daysInMonth = new Date(calViewYear, calViewMonth+1, 0).getDate();
    let html = ['S','M','T','W','T','F','S'].map(d=>`<div class="cal-dow">${d}</div>`).join('');
    for(let i=0;i<firstDay;i++) html += `<div class="cal-cell empty"></div>`;
    for(let day=1; day<=daysInMonth; day++){
      const dStr = `${calViewYear}-${String(calViewMonth+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
      const isSel = dStr === selectedDate;
      const isToday = dStr === today;
      html += `<button type="button" class="cal-cell${isSel?' selected':''}${isToday?' today':''}" data-date="${dStr}">${day}</button>`;
    }
    grid.innerHTML = html;
    $$('.cal-cell:not(.empty)', grid).forEach(cell=>{
      cell.addEventListener('click', ()=>{
        selectedDate = cell.dataset.date;
        $('#dateDisplay').textContent = fmtDate(selectedDate);
        $('#miniCal').classList.remove('open');
        renderCalendar();
      });
    });
  }
  renderCalendar();

  $('#dateDisplay').addEventListener('click', (e)=>{
    e.stopPropagation();
    $('#miniCal').classList.toggle('open');
  });
  $('#calPrev').addEventListener('click', ()=>{
    calViewMonth--; if(calViewMonth<0){ calViewMonth=11; calViewYear--; }
    renderCalendar();
  });
  $('#calNext').addEventListener('click', ()=>{
    calViewMonth++; if(calViewMonth>11){ calViewMonth=0; calViewYear++; }
    renderCalendar();
  });
  $('.modal', $('#modalRoot')).addEventListener('click', (e)=>{
    const cal = $('#miniCal'); // gone if the modal was already swapped out mid-click
    if(cal && !e.target.closest('#miniCal') && !e.target.closest('#dateDisplay')){
      cal.classList.remove('open');
    }
  });

  const starEls = $$('#starPick span');
  starEls.forEach(s=>{
    s.addEventListener('mouseenter', ()=>{
      const n = parseInt(s.dataset.n);
      starEls.forEach(x=> x.classList.toggle('on', parseInt(x.dataset.n) <= n));
    });
    s.addEventListener('click', ()=>{
      rating = parseInt(s.dataset.n);
    });
  });
  $('#starPick').addEventListener('mouseleave', ()=>{
    starEls.forEach(x=> x.classList.toggle('on', parseInt(x.dataset.n) <= rating));
  });
  $('#wrYes').addEventListener('click', ()=>{
    wouldReturn = true;
    $('#wrYes').classList.add('on'); $('#wrNo').classList.remove('on');
  });
  $('#wrNo').addEventListener('click', ()=>{
    wouldReturn = false;
    $('#wrNo').classList.add('on'); $('#wrYes').classList.remove('on');
  });
  $('#closeLog').addEventListener('click', ()=> openDetail(restaurantId));
  $('#cancelLog').addEventListener('click', ()=> openDetail(restaurantId));
  $('#ov2').addEventListener('click', (e)=>{ if(e.target.id==='ov2') openDetail(restaurantId); });

  // "Logging as X — switch": swaps the line for a reviewer select in place,
  // without losing anything already entered in the form.
  const switchLink = $('#switchReviewer');
  if(switchLink) switchLink.addEventListener('click', (e)=>{
    e.preventDefault();
    e.target.closest('.logged-by').outerHTML = `
      <div class="field">
        <label>Reviewer</label>
        <select id="vReviewer">${profiles.map(p=>`<option value="${p.id}" ${p.id===activeProfileId?'selected':''}>${escapeHtml(p.name)}</option>`).join('')}</select>
      </div>`;
  });

  $('#saveLog').addEventListener('click', async (e)=>{
    if(!rating){ alert('Pick a rating.'); return; }
    if(wouldReturn === null){ alert('Let us know if you\'d go back.'); return; }
    let reviewerName;
    const reviewerSelect = $('#vReviewer');
    const reviewerNew = $('#vReviewerNew');
    if(reviewerSelect){
      const p = profiles.find(x=>x.id===reviewerSelect.value);
      reviewerName = p ? p.name : '';
      if(p && p.id !== activeProfileId){
        activeProfileId = p.id;
        await saveProfiles();
        renderProfileChip();
      }
    } else if(reviewerNew){
      reviewerName = reviewerNew.value.trim();
      if(!reviewerName){ alert('Pick a reviewer username.'); return; }
      const p = { id: uid(), name: reviewerName };
      profiles.push(p);
      activeProfileId = p.id;
      await saveProfiles();
      renderProfileChip();
    } else {
      reviewerName = (activeProfile() || profiles[0]).name;
    }
    const date = selectedDate || today;
    const checkedDishes = $$('.dish-check input:checked', $('#modalRoot')).map(cb => cb.dataset.dish);
    const typedDish = $('#vAte').value.trim();
    const ate = [...checkedDishes];
    if(typedDish && !ate.some(d => d.toLowerCase() === typedDish.toLowerCase())) ate.push(typedDish);
    const notes = $('#vNotes').value.trim();
    visits.push({ id: uid(), restaurantId, date, ate, rating, wouldReturn, notes, reviewer: reviewerName, createdAt: Date.now() });
    if(typedDish && addDishToMenu(restaurantId, typedDish)) await saveRestaurants();
    await saveVisits();
    const rect = e.target.getBoundingClientRect();
    spawnConfetti(rect.left + rect.width/2, rect.top + rect.height/2);
    openDetail(restaurantId);
    renderAll();
  });
}

$('#addRestaurantBtn').addEventListener('click', openAddRestaurant);
$('#profileBtn').addEventListener('click', openProfiles);
$('#railToggle').addEventListener('click', openRail);
$('#railScrim').addEventListener('click', closeRail);

$$('#sortOpts button').forEach(btn=>{
  btn.addEventListener('click', ()=>{
    sortBy = btn.dataset.sort;
    $$('#sortOpts button').forEach(b=> b.classList.toggle('active', b===btn));
    if(sortBy === 'distance') requestUserLocation();
    renderContent();
  });
});

$('#searchBox').addEventListener('input', (e)=>{
  searchQuery = e.target.value;
  renderContent();
});

$('#unvisitedToggle').addEventListener('click', ()=>{
  unvisitedOnly = !unvisitedOnly;
  $('#unvisitedToggle').classList.toggle('active', unvisitedOnly);
  renderContent();
});

$('#gemsToggle').addEventListener('click', ()=>{
  gemsOnly = !gemsOnly;
  $('#gemsToggle').classList.toggle('active', gemsOnly);
  renderContent();
});

$('#recentToggle').addEventListener('click', ()=>{
  recentOnly = !recentOnly;
  $('#recentToggle').classList.toggle('active', recentOnly);
  renderContent();
});

$$('#viewOpts button').forEach(btn=>{
  btn.addEventListener('click', ()=>{
    viewMode = btn.dataset.view;
    $$('#viewOpts button').forEach(b=> b.classList.toggle('active', b===btn));
    renderContent();
  });
});


async function seedIfNeeded(){
  let added = false;
  SEED_RESTAURANTS.forEach(s=>{
    const existing = restaurants.find(r => r.name.toLowerCase() === s.name.toLowerCase());
    if(existing){
      if(addTagToRestaurant(existing.id, s.category)) added = true;
      if(!existing.address && s.address){ existing.address = s.address; added = true; }
    } else {
      restaurants.push({ id: uid(), name: s.name, categories: [s.category], address: s.address || '', createdAt: Date.now() });
      added = true;
    }
  });
  if(added) await saveRestaurants();
}


async function enrichAddresses(){
  let changed = false;
  ADDRESS_LOOKUP.forEach(entry=>{
    const r = restaurants.find(x => x.name.toLowerCase() === entry.name.toLowerCase());
    if(!r) return;
    // Entries may be partial (e.g. just a verified yelp URL for a listing
    // added in-app) — only the fields an entry actually carries are applied,
    // so curated data never wipes out what Google filled in at add time.
    const updates = {};
    if(entry.address !== undefined) updates.address = entry.address;
    if(entry.phone !== undefined) updates.phone = entry.phone;
    // Explicit null clears a stale value (e.g. a listing that moved to a
    // location whose links don't carry over); absent fields stay untouched.
    if(entry.placeId !== undefined) updates.mapsUrl = entry.placeId ? `https://www.google.com/maps/place/?q=place_id:${entry.placeId}` : null;
    if(entry.lat !== undefined){ updates.lat = entry.lat; updates.lng = entry.lng; }
    if(entry.permanentlyClosed !== undefined) updates.permanentlyClosed = entry.permanentlyClosed;
    if(entry.website !== undefined) updates.website = entry.website;
    if(entry.yelp !== undefined) updates.yelp = entry.yelp;
    let entryChanged = false;
    Object.entries(updates).forEach(([field, value])=>{
      if(r[field] !== value){ r[field] = value; entryChanged = true; }
    });
    if(entryChanged){
      r.addressUpdated = Date.now();
      changed = true;
    }
  });
  if(changed) await saveRestaurants();
}

/* Places flagged permanentlyClosed (from Apple Maps guide data or manual
   tagging) are removed automatically, along with any visits logged there.
   Safe to re-run — no-op once a place is already gone. */
async function removeClosedPlaces(){
  const closed = restaurants.filter(r => r.permanentlyClosed);
  if(closed.length === 0) return;
  const closedIds = new Set(closed.map(r => r.id));
  restaurants = restaurants.filter(r => !closedIds.has(r.id));
  visits = visits.filter(v => !closedIds.has(v.restaurantId));
  await saveRestaurants();
  await saveVisits();
}

/* A spot with a specific dessert subtag (Ice Cream / Bakery / Frozen
   Yogurt) files under the Desserts group through it — the plain Desserts
   tag would double up next to it, so strip it. Safe to re-run. */
const DESSERT_SUBTAGS = ['Ice Cream', 'Bakery', 'Frozen Yogurt'];
async function stripParentDessertTag(){
  let changed = false;
  restaurants.forEach(r=>{
    if(r.categories && r.categories.includes('Desserts') && r.categories.some(c => DESSERT_SUBTAGS.includes(c))){
      r.categories = r.categories.filter(c => c !== 'Desserts');
      changed = true;
    }
  });
  if(changed) await saveRestaurants();
}

/* Cuisine tags dropped their redundant "Cuisine" suffix for a cleaner tag
   bar (e.g. "Italian Cuisine" -> "Italian"). Rename any already-stored
   long-form tags to the short form. Safe to re-run — no-op once migrated. */
const CUISINE_RENAMES = {
  'American Cuisine': 'American',
  'Italian Cuisine': 'Italian',
  'Indian Cuisine': 'Indian',
  'Fondue': 'Swiss',
  // Hoagies and wraps are still sandwiches — one sub-tag, not five.
  'Hoagie': 'Sandwiches',
  'Sandwich': 'Sandwiches',
  'Cheesesteak': 'Sandwiches',
  'Bagel': 'Sandwiches',
  'Wrap': 'Sandwiches',
  // Cocktail/tiki bars fold into Bars and Pasta into Italian; Wine Bars
  // and Sports Bars stay — those are real guides. Desserts keeps its
  // Ice Cream / Bakery / Frozen Yogurt subtags per Brianna.
  'Pasta': 'Italian',
  'Cocktail Bars': 'Bars',
  'Tiki Bars': 'Bars',
  // The library has separate breakfast and brunch guides — split the merged
  // tag. Every spot that carried it is a breakfast-guide spot.
  'Breakfast & Brunch': 'Breakfast',
};
async function renameCuisineTags(){
  let changed = false;
  restaurants.forEach(r=>{
    if(!r.categories) return;
    Object.entries(CUISINE_RENAMES).forEach(([oldTag, newTag])=>{
      if(r.categories.includes(oldTag)){
        r.categories = r.categories.filter(c => c !== oldTag);
        if(!r.categories.includes(newTag)) r.categories.push(newTag);
        changed = true;
      }
    });
  });
  if(changed) await saveRestaurants();
}

/* One-time removal of a single stray tag ("Tapas" doesn't cleanly describe
   VU Rooftop, which is better represented by its "American" tag alone).
   Safe to re-run — no-op once already migrated. */
const REMOVED_TAGS_BY_NAME = {
  "VU Rooftop": ["Tapas"],
  "Geja's Cafe": ["American"],
  "Soul Shack Express": ["Jamaican"], // it's soul food — mis-tagged in the original upload
  "Peach's Restaurant": ["Soul Food"], // breakfast spot — not in the soul guide
  "Prime 57 Restaurant & Lounge": ["Jamaican"], // upscale American lounge — mis-tagged in the original upload
  "Philly's Best": ["Pizza"], // cheesesteak shop — it's in the sandwiches guide, not the pizza guide
  "NYC Halal Eats": ["Burgers", "Halal"], // sandwiches-guide spot; Sandwiches covers it
  // Bakeries by trade, but they live in the sandwiches / breakfast guides —
  // keeps Desserts to the nine spots actually in the dessert guide.
  "D'Amato's Bakery": ["Desserts"],
  "Goddess and the Baker": ["Desserts"],
  // Gems curation: staples list is Brianna's call — these two are out.
  "Watta Potato by Yogis Bistro": ["Chicago Gems"],
  "Tastee Rolls": ["Chicago Gems"],
  // Hot Dogs / Halal never came from a guide — retired as categories.
  "Portillo's": ["Hot Dogs"],
  "Devil Dawgs": ["Hot Dogs"],
  "Maxwell Street Depot": ["Hot Dogs"],
  "Halal Smash Burger & Phillies": ["Halal"],
};
async function removeStrayTags(){
  let changed = false;
  Object.entries(REMOVED_TAGS_BY_NAME).forEach(([name, tagsToRemove])=>{
    const r = restaurants.find(x => x.name.toLowerCase() === name.toLowerCase());
    if(r && r.categories){
      const before = r.categories.length;
      r.categories = r.categories.filter(c => !tagsToRemove.includes(c));
      if(r.categories.length !== before) changed = true;
    }
  });
  if(changed) await saveRestaurants();
}

/* Seed each restaurant's menu from dishes already logged in past visits,
   so the new checkbox picker starts with everything you've eaten there.
   Safe to re-run — addDishToMenu dedupes, so it's a no-op once seeded. */
async function seedMenusFromVisits(){
  let changed = false;
  visits.forEach(v=>{
    ateList(v).forEach(d=>{
      if(addDishToMenu(v.restaurantId, d)) changed = true;
    });
  });
  if(changed) await saveRestaurants();
}

async function seedCuratedMenus(){
  let changed = false;
  MENU_LOOKUP.forEach(entry=>{
    const r = restaurants.find(x => x.name.toLowerCase() === entry.name.toLowerCase());
    if(!r) return;
    // Entries are versioned: bumping `v` re-applies a corrected menu on
    // devices that already seeded an older one. `retire` names seed dishes
    // the correction removes — user-added dishes are never touched.
    const ver = entry.v || 1;
    const seeded = r.menuSeeded === true ? 1 : (r.menuSeeded || 0);
    if(seeded >= ver) return;
    if(!r.menu) r.menu = [];
    (entry.retire || []).forEach(d=>{
      const i = r.menu.findIndex(x => x.toLowerCase() === d.toLowerCase());
      if(i !== -1) r.menu.splice(i, 1);
    });
    // Sectioned entries store dishes grouped by menu section; flatten for
    // seeding — grouping is re-derived at render time from the sections.
    const entryDishes = entry.sections ? Object.values(entry.sections).flat() : entry.dishes;
    entryDishes.forEach(d=>{
      if(!r.menu.some(x => x.toLowerCase() === d.toLowerCase())) r.menu.push(d);
    });
    r.menu.sort((a,b)=> a.localeCompare(b));
    r.menuSeeded = ver;
    r.menuUpdated = Date.now();
    changed = true;
  });
  if(changed) await saveRestaurants();
}

/* One-time removal of listings that no longer belong (e.g. not an actual
   restaurant). Safe to re-run — no-op once already removed.
*/
const REMOVED_LISTING_NAMES = [
  "Harold's Chicken Hyde Park", // wrong Harold's — the gem is #88 at 124 E 35th St
  "Burp Catering", // removed per Brianna 2026-07-16
];
async function removeRemovedListings(){
  const removeIds = new Set(
    restaurants.filter(r => REMOVED_LISTING_NAMES.some(n => n.toLowerCase() === r.name.toLowerCase())).map(r => r.id)
  );
  if(removeIds.size === 0) return;
  restaurants = restaurants.filter(r => !removeIds.has(r.id));
  visits = visits.filter(v => !removeIds.has(v.restaurantId));
  await saveRestaurants();
  await saveVisits();
}

(async function init(){
  await loadData();
  await migrateCategories();
  await seedIfNeeded();
  await enrichAddresses();
  await removeClosedPlaces();
  await renameCuisineTags();
  await stripParentDessertTag();
  await removeStrayTags();
  await removeRemovedListings();
  await seedMenusFromVisits();
  await seedCuratedMenus();
  await assignAreas();
  applyHash(); // restores the view from the address (empty hash = landing)
  // Boundary data (city neighborhoods + suburb towns) loads in the
  // background; neighborhood stamps persist on each record once assigned,
  // so these are real fetches only the first time.
  Promise.allSettled([loadHoodGeo(), loadTownGeo()]).then(async ()=>{
    if(hoodGeo) await assignNeighborhoods(hoodGeo);
    renderAll();
  });
})();
