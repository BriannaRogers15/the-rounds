let restaurants = [];
let visits = [];
let activeCategory = 'All';
let activeSubTag = null;
let dataLoaded = false;
let sharedLedgerReady = false;
// Whether this page load's one-shot startup (init) ran as the owner, and
// whether that startup has finished. See the rounds-access-changed listener.
let bootedAsOwner = false;
let appBooted = false;
let sharedLedgerStatus = 'Connecting…';
let sharedLedgerStatusError = false;
let sortBy = 'name';
let userLocation = null;
let locationRequested = false;
let searchQuery = '';
let unvisitedOnly = false;
let gemsOnly = false;
let touristOnly = false;
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
    // Curated listings share one date (CURATED_ADDED_AT), so ties fall back to A–Z.
    arr.sort((a,b)=> (b.createdAt||0) - (a.createdAt||0) || sortName(a.name).localeCompare(sortName(b.name)));
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
  // Retired: device-local reviewer usernames. Visits are logged under the
  // signed-in account's name now; drop what older versions left behind.
  try{ localStorage.removeItem('rounds:profiles'); localStorage.removeItem('rounds:activeProfile'); }
  catch(e){}
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
  await persistSharedLedger('restaurants', restaurants);
}
async function saveVisits(){
  try{ await store.set('visits', JSON.stringify(visits)); }
  catch(e){ console.error('Could not save visits', e); }
  await persistSharedLedger('visits', visits);
}
async function persistSharedLedger(kind, records){
  if(!sharedLedgerReady || !canWriteLedger()) return;
  try{
    await window.RoundsFirebase.syncSharedLedger(kind, records);
    setSharedLedgerStatus('Shared');
  }catch(error){
    console.error(`Could not sync shared ${kind}:`, error);
    setSharedLedgerStatus('Sync issue', true);
  }
}
function setSharedLedgerStatus(message, isError=false){
  sharedLedgerStatus = message;
  sharedLedgerStatusError = isError;
  const status = $('#ledgerStatus');
  if(status){
    status.textContent = message;
    status.classList.toggle('error', isError);
  }
}
/* The signed-in person's name, as visits are logged under it — set at
   sign-up (or by Google), changed with the pencil on "Signed in as …". */
function myUsername(){
  return (window.RoundsAccount?.profile?.username || '').trim();
}
/* Everyone's public username, live (profiles/{uid}). Reviews show the
   author's current username; a visit's stored `reviewer` is only the
   fallback for authors from before usernames. */
let profilesByUid = {};
function reviewerName(v){
  return profilesByUid[v.authorUid]?.username || v.reviewer || 'Someone';
}

function visitsFor(restaurantId){
  return visits.filter(v => v.restaurantId === restaurantId).sort((a,b)=> String(b.date || '').localeCompare(String(a.date || '')));
}
function avgRating(list){
  if(!list.length) return null;
  return list.reduce((s,v)=>s+v.rating,0) / list.length;
}
/* Ratings go in half steps (0.5 … 5). Averages show to the nearest half. */
function toHalf(n){ return Math.max(0, Math.min(5, Math.round((Number(n) || 0) * 2) / 2)); }
function fmtRating(n){ return Number.isInteger(n) ? String(n) : n.toFixed(1); }
const STAR_PATH = 'M12 2.6l2.85 5.95 6.55.85-4.8 4.55 1.25 6.5L12 17.3l-5.85 3.15 1.25-6.5-4.8-4.55 6.55-.85z';
/* Five star graphics: solid, half (left half solid) or outline. A half is
   a real half-filled star, never a "½". */
function starIconsHtml(n){
  const v = toHalf(n);
  let html = '';
  for(let i = 1; i <= 5; i++){
    const kind = v >= i ? 'full' : (v >= i - 0.5 ? 'half' : 'empty');
    html += `<svg class="st st-${kind}" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path class="st-o" d="${STAR_PATH}"/>${kind === 'empty' ? '' : `<path class="st-f" d="${STAR_PATH}"${kind === 'half' ? ' clip-path="url(#starHalfClip)"' : ''}/>`}</svg>`;
  }
  return html;
}
/* Stars with a spoken label, for cards, visits and popups. */
function starsHtml(n){
  const v = toHalf(n);
  return `<span class="stars" role="img" aria-label="${fmtRating(v)} out of 5 stars" data-rating="${v}">${starIconsHtml(v)}</span>`;
}
/* The star picker. Tap or click a star's left half for a half star, its
   right half for a whole one; or drag across the row (on a phone the row
   spans the screen, so the whole row is the touch target). Arrow keys and
   screen readers move it in half steps. */
function starSliderHtml({ id = '', value = 0, label, size = 'big' }){
  const v = toHalf(value);
  return `<div class="star-slider ${size}"${id ? ` id="${id}"` : ''} role="slider" tabindex="0" aria-label="${escapeHtml(label)}" aria-valuemin="0" aria-valuemax="5" aria-valuenow="${v}" aria-valuetext="${v ? `${fmtRating(v)} stars` : 'Not rated'}" data-value="${v}">
    <span class="ss-icons">${starIconsHtml(v)}</span><span class="ss-value">${v ? fmtRating(v) : ''}</span><span class="ss-bubble" aria-hidden="true" hidden></span>
  </div>`;
}
/* `clearable`: tapping the current value again (or Delete) clears it. */
function wireStarSlider(el, { clearable = false, onChange } = {}){
  if(el.dataset.wired) return;
  el.dataset.wired = '1';
  let value = parseFloat(el.dataset.value) || 0;
  const icons = el.querySelector('.ss-icons');
  const label = el.querySelector('.ss-value');
  const bubble = el.querySelector('.ss-bubble');
  const paint = (v)=>{ icons.innerHTML = starIconsHtml(v); label.textContent = v ? fmtRating(v) : ''; };
  const set = (v, notify = true)=>{
    value = v;
    el.dataset.value = String(v);
    el.setAttribute('aria-valuenow', String(v));
    el.setAttribute('aria-valuetext', v ? `${fmtRating(v)} stars` : 'Not rated');
    paint(v);
    if(notify && onChange) onChange(v);
  };
  el._setStars = (v)=> set(v, false);
  const valueAt = (clientX)=>{
    const b = icons.getBoundingClientRect();
    const f = (clientX - b.left) / b.width;
    return Math.min(5, Math.max(0.5, Math.ceil(f * 10) / 2));
  };
  const showBubble = (v, clientX)=>{
    const b = el.getBoundingClientRect();
    bubble.textContent = fmtRating(v);
    bubble.style.left = `${clientX - b.left}px`;
    bubble.hidden = false;
  };
  let dragging = false, moved = false, startValue = 0, pending = 0;
  el.addEventListener('pointerdown', (e)=>{
    if(e.button > 0) return;
    dragging = true; moved = false; startValue = value;
    pending = valueAt(e.clientX);
    try{ el.setPointerCapture(e.pointerId); }catch(_e){}
    paint(pending);
    if(e.pointerType !== 'mouse') showBubble(pending, e.clientX);
  });
  el.addEventListener('pointermove', (e)=>{
    if(dragging){
      const v = valueAt(e.clientX);
      if(v !== pending){ moved = true; pending = v; paint(v); }
      if(e.pointerType !== 'mouse') showBubble(v, e.clientX);
    }
  });
  el.addEventListener('pointerup', ()=>{
    if(!dragging) return;
    dragging = false;
    bubble.hidden = true;
    set(clearable && !moved && pending === startValue ? 0 : pending);
  });
  // A vertical swipe that turns into page scrolling cancels the pick.
  el.addEventListener('pointercancel', ()=>{ dragging = false; bubble.hidden = true; paint(value); });
  el.addEventListener('keydown', (e)=>{
    let v = null;
    if(e.key === 'ArrowRight' || e.key === 'ArrowUp') v = Math.min(5, Math.max(0.5, value + 0.5));
    else if(e.key === 'ArrowLeft' || e.key === 'ArrowDown') v = Math.max(0.5, value - 0.5);
    else if(e.key === 'Home') v = 0.5;
    else if(e.key === 'End') v = 5;
    else if(clearable && (e.key === 'Delete' || e.key === 'Backspace')) v = 0;
    if(v === null) return;
    e.preventDefault();
    set(v);
  });
}
const PIN_ICON = '<svg class="pin-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22s7-6.2 7-12a7 7 0 1 0-14 0c0 5.8 7 12 7 12z"/><circle cx="12" cy="10" r="2.5"/></svg>';
const CHEVRON_ICON = '<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>';
const SEARCH_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>';
/* A spot's own guides as one plain line ("Japanese · Dinner Dates") — the
   tags it actually carries, not the umbrella groups they nest under. */
function guideLine(r){
  // Cuisine first, then food & drink, then occasions — "Jamaican · Brunch".
  const rank = { 'Cuisines': 0, 'Food & Drink': 1, 'Occasions': 2 };
  const rankOf = t => rank[GUIDE_SECTION[t] || GUIDE_SECTION[groupForTag(t)] || 'Food & Drink'];
  return (r.categories || []).filter(t => !BADGE_TAGS.has(t))
    .map((t, i) => [t, i]).sort((a, b) => rankOf(a[0]) - rankOf(b[0]) || a[1] - b[1])
    .map(([t]) => singularizeTag(t)).join(' · ');
}
/* Where a spot is, in the words people use: its neighborhood in the city,
   its town in the suburbs. */
function areaLabel(r){
  if(r.neighborhood) return r.neighborhood;
  const town = r.town || parseTown(r.address);
  return town || '';
}
/* Today as YYYY-MM-DD in the visitor's own time zone. toISOString() is UTC,
   which in Chicago turns every evening after 7pm into tomorrow. */
function localDateStr(dt = new Date()){
  return `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}`;
}
/* "Oct 22" this year, "Oct 22, 2025" otherwise — for "last visited". */
function fmtShortDate(d){
  const dt = new Date(d + 'T00:00:00');
  const sameYear = dt.getFullYear() === new Date().getFullYear();
  return dt.toLocaleDateString('en-US', sameYear ? { month:'short', day:'numeric' } : { month:'short', day:'numeric', year:'numeric' });
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
/* Personal Gems is Brianna's own call; Tourist Spots she tags herself.
   "Chicago Gems" is the gem tag's old name: renameCuisineTags() moves
   stored listings to the new one on the owner's next sign-in, and until
   then it still counts as a gem everywhere. */
const GEM_TAG = 'Personal Gems';
const TOURIST_TAG = 'Tourist Spots';
const LEGACY_GEM_TAG = 'Chicago Gems';
const BADGE_TAGS = new Set([GEM_TAG, TOURIST_TAG, LEGACY_GEM_TAG]);
function isGem(r){ return (r.categories || []).some(t => t === GEM_TAG || t === LEGACY_GEM_TAG); }
function isTourist(r){ return (r.categories || []).includes(TOURIST_TAG); }
/* Guide suggestions for "+ Add a guide": every guide in use, plus the two
   badge tags, so tagging the first tourist spot needs no typing. */
function guideSuggestions(){
  return Array.from(new Set([...categories().filter(c => c !== LEGACY_GEM_TAG), GEM_TAG, TOURIST_TAG])).sort();
}

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
function menuOf(r){ return Array.isArray(r.menu) ? r.menu : []; }
/* The name a listing's curated data (menus, addresses, seed guides) is
   filed under. Renaming a listing in the app changes only `name`; the
   original stays in `curatedName`, so its menu, links and guides still
   find it and no duplicate listing is ever seeded. */
function curatedKey(r){ return String(r.curatedName || r.name || '').toLowerCase(); }
/* Groups a spot's stored dishes under the curated section headers
   (Appetizers, Entrees, Drinks...) from MENU_LOOKUP. Grouping happens at
   render time, so stored menus never need migrating: dishes the curation
   doesn't know (user-added) land under "More", and spots without curated
   sections render as one unnamed group. */
function menuGroupsFor(r){
  const menu = menuOf(r);
  if(!menu.length) return [];
  const entry = MENU_LOOKUP.find(e => e.name.toLowerCase() === curatedKey(r));
  if(!entry || !entry.sections) return [{title:null, dishes:menu}];
  // A dish can sit in more than one section (a happy-hour list repeating
  // the regular menu); it shows in each, as the printed menu does.
  const dishSections = {};
  Object.entries(entry.sections).forEach(([sec, ds])=> ds.forEach(d => (dishSections[d.toLowerCase()] = dishSections[d.toLowerCase()] || []).push(sec)));
  const grouped = {};
  const extra = [];
  menu.forEach(d=>{
    const secs = dishSections[d.toLowerCase()];
    if(secs) secs.forEach(sec => (grouped[sec] = grouped[sec] || []).push(d));
    else extra.push(d);
  });
  const out = Object.keys(entry.sections).filter(s=>grouped[s]).map(s=>({title:s, dishes:grouped[s]}));
  if(extra.length) out.push({title:'More', dishes:extra});
  return out;
}
function menuLookupEntry(r){
  return MENU_LOOKUP.find(e => e.name.toLowerCase() === curatedKey(r)) || null;
}
/* When the menu was last checked against its source (YYYY-MM-DD), or null
   for a menu that only grew out of logged visits. */
function menuCheckedDate(r){
  const entry = menuLookupEntry(r);
  if(entry && entry.asOf) return entry.asOf;
  return typeof r.menuUpdated === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.menuUpdated) ? r.menuUpdated : null;
}
/* "Most Popular" starts open when a menu has it; otherwise the first
   section does, so the window never opens on a wall of closed headers. */
function defaultOpenSection(groups){
  const popular = groups.find(g => /^most popular$/i.test(g.title || ''));
  return (popular || groups[0] || {}).title;
}
/* Per dish (lowercased name), from logged visits only: how many visits
   had it (once per visit), and the stars people gave that dish. */
function menuDishStats(r){
  const stats = {};
  const get = (d)=> stats[d] || (stats[d] = { count: 0, ratingSum: 0, ratingN: 0 });
  visitsFor(r.id).forEach(v=>{
    new Set(ateList(v).map(d => String(d).toLowerCase())).forEach(d => get(d).count++);
    (v.dishDetails || []).forEach(x=>{
      if(typeof x.rating === 'number' && x.rating >= 0.5 && x.rating <= 5){
        const s = get(String(x.dish || '').toLowerCase());
        s.ratingSum += x.rating; s.ratingN++;
      }
    });
  });
  return stats;
}
/* "What I had" on a visit card: each dish with its own stars and the
   changes asked for, when the visit recorded them. */
function visitAteHtml(v){
  const ate = ateList(v);
  if(!ate.length) return '';
  const byDish = new Map((v.dishDetails || []).map(x => [String(x.dish || '').toLowerCase(), x]));
  if(!byDish.size) return `<div class="visit-line"><span class="visit-lbl">Ate</span> ${escapeHtml(ate.join(', '))}</div>`;
  return `<div class="visit-line"><span class="visit-lbl">Ate</span>
    <ul class="ate-list">${ate.map(d=>{
      const x = byDish.get(String(d).toLowerCase()) || {};
      return `<li><span class="ate-dish">${escapeHtml(d)}</span>${x.rating ? starsHtml(x.rating) : ''}${x.mod ? `<span class="ate-mod">${escapeHtml(x.mod)}</span>` : ''}</li>`;
    }).join('')}</ul></div>`;
}
const GROUP_FAVORITES = 'Group favorites';
/* Sections past this many sit behind "Show N more sections". */
const MENU_SECTIONS_SHOWN = 8;
function menuAccordionHtml(r, state, rowHtml){
  const groups = menuGroupsFor(r);
  if(!groups.length) return `<div class="no-menu">No dishes on file yet — they'll collect as visits get logged.</div>`;
  const stats = menuDishStats(r);
  const row = rowHtml || ((d)=>{
    const st = stats[d.toLowerCase()];
    const avg = st && st.ratingN ? st.ratingSum / st.ratingN : null;
    return `<div class="menu-row"><span class="dish-name">${escapeHtml(d)}</span>${st && st.count ? `<span class="dish-badges">${avg ? `<span class="dish-avg" title="Average of ${st.ratingN} rating${st.ratingN===1?'':'s'}">${avg.toFixed(1)}★</span>` : ''}<span class="ordered-badge">ordered ${st.count}×</span></span>` : ''}</div>`;
  });
  const section = (g, open, searching)=>{
    if(!g.title) return `<div class="menu-group open" data-section=""><div class="menu-sec-body">${g.dishes.map(row).join('')}</div></div>`;
    const head = searching
      ? `<div class="menu-sec-head static"><span class="menu-group-title">${escapeHtml(g.title)}</span><span class="menu-sec-count">${g.dishes.length}</span></div>`
      : `<button type="button" class="menu-sec-head" aria-expanded="${open}">${CHEVRON_ICON}<span class="menu-group-title">${escapeHtml(g.title)}</span><span class="menu-sec-count">${g.dishes.length}</span></button>`;
    return `<div class="menu-group${open ? ' open' : ''}" data-section="${escapeHtml(g.title)}">${head}${open ? `<div class="menu-sec-body">${g.dishes.map(row).join('')}</div>` : ''}</div>`;
  };
  const q = state.query.trim().toLowerCase();
  // On the listing's menu (not the dish picker), the group's best-rated
  // dishes lead: rated 4+ on average, from real ratings only.
  if(!rowHtml && !q){
    const favorites = menuOf(r).filter(d=>{
      const st = stats[d.toLowerCase()];
      return st && st.ratingN && st.ratingSum / st.ratingN >= 4;
    }).sort((a, b)=>{
      const sa = stats[a.toLowerCase()], sb = stats[b.toLowerCase()];
      return (sb.ratingSum / sb.ratingN) - (sa.ratingSum / sa.ratingN) || sb.ratingN - sa.ratingN || a.localeCompare(b);
    });
    if(favorites.length) groups.unshift({ title: GROUP_FAVORITES, dishes: favorites });
  }
  if(q){
    const hits = groups.map(g => ({ title: g.title, dishes: g.dishes.filter(d => d.toLowerCase().includes(q)) })).filter(g => g.dishes.length);
    if(!hits.length) return `<div class="no-menu">No dishes match “${escapeHtml(state.query.trim())}”.</div>`;
    return hits.map(g => section(g, true, true)).join('');
  }
  // One extra section isn't worth a "Show 1 more" button.
  const limit = state.showAll || groups.length <= MENU_SECTIONS_SHOWN + 1 ? groups.length : MENU_SECTIONS_SHOWN;
  return groups.slice(0, limit).map(g => section(g, state.open.has(g.title), false)).join('')
    + (limit < groups.length ? `<button type="button" class="menu-more">Show ${groups.length - limit} more sections</button>` : '');
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
const CHI_SIDES = ['Downtown', 'Up North', 'Out West', 'Out South', 'Over East'];
// The sides' names before 2026-11-16, so old bookmarks still land.
const OLD_SIDE_NAMES = { 'North Side': 'Up North', 'West Side': 'Out West', 'South Side': 'Out South', 'East Side': 'Over East' };
const HOOD_SIDE = {
  'Downtown': ['Loop', 'South Loop', 'River North', 'Streeterville', 'Gold Coast', 'Old Town', 'Printers Row', 'West Loop', 'Greektown'],
  'Up North': ['Albany Park', 'Andersonville', 'Avondale', 'Belmont Cragin', 'Boystown', 'Dunning', 'Edgewater', 'Edison Park', 'Hermosa', 'Irving Park', 'Jefferson Park', 'Lake View', 'Lincoln Park', 'Lincoln Square', 'Logan Square', 'Montclare', 'North Center', 'North Park', 'Norwood Park', 'Portage Park', 'Rogers Park', 'Sauganash,Forest Glen', 'Uptown', 'West Ridge', 'Wrigleyville'],
  'Out West': ['Austin', 'Bucktown', 'East Village', 'Galewood', 'Garfield Park', 'Humboldt Park', 'Little Italy, UIC', 'Little Village', 'Near West Side', 'North Lawndale', 'Pilsen', 'Ukrainian Village', 'West Town', 'Wicker Park'],
  'Out South': ['Archer Heights', 'Armour Square', 'Ashburn', 'Auburn Gresham', 'Avalon Park', 'Beverly', 'Bridgeport', 'Brighton Park', 'Bronzeville', 'Burnside', 'Calumet Heights', 'Chatham', 'Chicago Lawn', 'Chinatown', 'Clearing', 'Englewood', 'Fuller Park', 'Gage Park', 'Garfield Ridge', 'Grand Crossing', 'Hyde Park', 'Jackson Park', 'Kenwood', 'Mckinley Park', 'Morgan Park', 'Mount Greenwood', 'New City', 'Oakland', 'Pullman', 'Riverdale', 'Roseland', 'South Shore', 'Washington Heights', 'Washington Park', 'West Elsdon', 'West Lawn', 'West Pullman', 'Woodlawn'],
  'Over East': ['East Side', 'Hegewisch', 'South Chicago', 'South Deering'],
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
    if(lng > -87.565 && lat < 41.75) return 'Over East';
    if(lat >= 41.90) return 'Up North';
    if(lat <= 41.85) return 'Out South';
    return 'Out West';
  }
  return 'Out South';
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
  if(area.type === 'region') return r.region === area.name;
  if(area.type === 'side') return r.region === 'Chicago' && !!r.neighborhood && sideForHood(r.neighborhood) === area.name;
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
  if(currentPage === 'profile') return '#v=profile';
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
  if(v === 'profile'){
    currentPage = 'profile';
  } else if(v === 'all' || v === 'area'){
    currentPage = 'listings';
    activeArea = (v === 'area' && p.get('t') && p.get('n')) ? { type: p.get('t'), name: p.get('n') } : null;
    if(activeArea && activeArea.type === 'side' && OLD_SIDE_NAMES[activeArea.name]) activeArea.name = OLD_SIDE_NAMES[activeArea.name];
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
    <div class="receipt-row"><span class="receipt-label">Spots visited</span><span class="receipt-val">${visitedCount}/${total}</span></div>
    <div class="receipt-row"><span class="receipt-label">Visits logged</span><span class="receipt-val">${totalVisits}</span></div>
    <div class="receipt-row"><span class="receipt-label">Average rating</span><span class="receipt-val${allAvg ? '' : ' muted'}">${allAvg ? allAvg.toFixed(1) + '★' : '—'}</span></div>
  `;
}

/* The vertical guide list (desktop rail / phone drawer). A group that's
   active unfolds its sub-cuisines indented beneath it, accordion-style. */
function railItemHTML(label, count, active, opts = {}){
  const cls = `rail-item${opts.child ? ' child' : ''}${active ? ' active' : ''}${opts.group ? ' group' : ''}${opts.open ? ' open' : ''}`;
  const sub = opts.sub !== undefined ? ` data-sub="${escapeHtml(opts.sub)}"` : '';
  return `<button type="button" class="${cls}" data-cat="${escapeHtml(label)}"${sub}${active ? ' aria-current="true"' : ''}${opts.group ? ` aria-expanded="${!!opts.open}"` : ''}>
    ${opts.group ? CHEVRON_ICON : ''}<span class="rail-name">${escapeHtml(opts.name || label)}</span>
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
  'Special Events':'Occasions',
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
  html += railItemHTML('All', inArea.length, activeCategory === 'All');
  RAIL_SECTION_ORDER.forEach(sec=>{
    if(!sections[sec].length) return;
    html += `<div class="rail-section">${sec}</div>`;
    sections[sec].forEach(({ label, count })=>{
      const active = activeCategory === label;
      html += railItemHTML(label, count, active && !isGroupLabel(label), isGroupLabel(label) ? { group:true, open:active } : {});
      if(isGroupLabel(label) && active){
        html += `<div class="rail-children">`;
        html += railItemHTML(label, count, !activeSubTag, { child:true, sub:'', name:`All ${label}` });
        childTagsOf(label).forEach(c=>{
          const ccount = inArea.filter(r => (r.categories||[]).includes(c)).length;
          if(activeArea && ccount === 0) return;
          html += railItemHTML(label, ccount, activeSubTag === c, { child:true, sub:c, name:c });
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
/* When Google only says "restaurant", the name usually says more:
   "Mock Taqueria", "Lou's Smokehouse", "Harold's Chicken". Each hint maps
   words in a name to one guide. Only guides already in the ledger are
   ever suggested (her guides set the categories — never new ones), and
   the chips stay editable before saving. Specific bars before plain "bar". */
const NAME_GUIDE_HINTS = [
  [/\b(mexican|tacos?|taquer[ií]a|cantina|birria|tamales?|burritos?|quesadillas?|elotes?)\b/i, 'Mexican'],
  [/\b(pizza|pizzeria|pizzas)\b/i, 'Pizza'],
  [/\bsushi\b/i, 'Sushi'],
  [/\bramen\b/i, 'Ramen'],
  [/\b(hibachi|izakaya|teriyaki|japanese)\b/i, 'Japanese'],
  [/\b(pho|banh mi|vietnamese)\b/i, 'Vietnamese'],
  [/\bthai\b/i, 'Thai'],
  [/\b(korean|kbbq|bulgogi|bibimbap)\b/i, 'Korean'],
  [/\b(chinese|wok|dumplings?|szechuan|sichuan|dim sum|hot ?pot)\b/i, 'Chinese'],
  [/\b(indian|curry|tandoori?|masala|biryani)\b/i, 'Indian'],
  [/\b(peru|peruvian|ceviche)\b/i, 'Peruvian'],
  [/\b(jerk|jamaican?|caribbean)\b/i, 'Jamaican'],
  [/\b(italian|trattoria|ristorante|osteria)\b/i, 'Italian'],
  [/\b(bbq|bar-?b-?q(?:ue)?|barbecue|smokehouse|smoke ?house)\b/i, 'BBQ'],
  [/\b(steak ?house|chophouse)\b/i, 'Steakhouses'],
  [/\bburgers?\b/i, 'Burgers'],
  [/\b(seafood|mariscos|crabs?|shrimp|lobsters?|oysters?|fish|po['-]? ?boys?|crawfish)\b/i, 'Seafood'],
  [/\b(wings?|chicken)\b/i, 'Chicken'],
  [/\bsoul\b/i, 'Soul Food'],
  [/\b(hoag(?:ie|y)s?|sandwich(?:es)?|subs|deli|cheesesteaks?|philly|phillies|gyros?|steak (?:&|and) lemonade)\b/i, 'Sandwiches'],
  [/\b(bakery|bakehouse|patisserie|pastry|pastries|donuts?|doughnuts?)\b/i, 'Bakery'],
  [/\b(ice cream|gelato|creamery|custard)\b/i, 'Ice Cream'],
  [/\b(froyo|frozen yogurt)\b/i, 'Frozen Yogurt'],
  [/\b(desserts?|sweets|cakes?|cookies?|cupcakes?|cheesecake)\b/i, 'Desserts'],
  [/\b(pancakes?|breakfast|waffles?)\b/i, 'Breakfast'],
  [/\bbrunch\b/i, 'Brunch'],
  [/\brooftop\b/i, 'Rooftop'],
  [/\bwine bar\b/i, 'Wine Bars'],
  [/\bsports (bar|pub|grill)\b/i, 'Sports Bars'],
  // Only when nothing in the name names the food: "Kitchen + Bar" and
  // "Bar & Grill" are restaurants first, but "Bar Tabu" or "The Tap" are bars.
  [/\b(bar|pub|tavern|tap|taproom|lounge|saloon)\b/i, 'Bars', { fallback: true }],
];
// Overlaps where one guide already says it: Korean BBQ is Korean, a fish
// and chicken shack is seafood, a sushi bar is Sushi.
const NAME_GUIDE_SUPERSEDES = { 'Korean': ['BBQ', 'Steakhouses'], 'Seafood': ['Chicken'] };
function guessGuidesFromName(name){
  const text = String(name || '');
  const known = new Map(categories().map(c => [c.toLowerCase(), c]));
  let out = [];
  NAME_GUIDE_HINTS.forEach(([re, tag, opts = {}])=>{
    const guide = known.get(tag.toLowerCase());
    if(!guide || out.includes(guide) || !re.test(text)) return;
    if(opts.fallback && out.length) return;
    out.push(guide);
  });
  Object.entries(NAME_GUIDE_SUPERSEDES).forEach(([winner, losers])=>{
    if(out.includes(known.get(winner.toLowerCase()))) out = out.filter(t => !losers.some(l => l.toLowerCase() === t.toLowerCase()));
  });
  return out.slice(0, 3);
}
/* Places API (New) caps includedPrimaryTypes at 5 exact-match values, so
   the search box can't just list every type GOOGLE_TYPE_TAG knows about
   (60+ of them) as a server-side filter. Instead the name search below
   queries with no type restriction, then filters results client-side
   against this set — full coverage of every type this app can tag, still
   strictly food/drink (no arbitrary businesses), no 5-value ceiling. */
const FOOD_DRINK_TYPES = new Set([...Object.keys(GOOGLE_TYPE_TAG), 'restaurant', 'food', 'meal_takeaway', 'meal_delivery']);

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
    list = list.filter(r => r.name.toLowerCase().includes(q) || menuOf(r).some(d => d.toLowerCase().includes(q)));
  }
  if(unvisitedOnly){
    list = list.filter(r => visitsFor(r.id).length === 0);
  }
  if(touristOnly){
    list = list.filter(isTourist);
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
      ? `<div class="empty"><b>No listings in this book yet</b>${canManageListings() ? 'Add your first stop to start tracking it.' : 'The shared ledger has no listings yet.'}</div>`
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
  // Inside one neighborhood or town every card is there, so saying so on
  // each card repeats the page title. A side, a region or "all" mixes areas.
  const inOneArea = !!activeArea && (activeArea.type === 'neighborhood' || activeArea.type === 'town');
  const q = searchQuery.trim().toLowerCase();
  el.innerHTML = list.map(r=>{
    const vs = visitsFor(r.id);
    const avg = avgRating(vs);
    const guides = guideLine(r);
    const area = inOneArea ? '' : areaLabel(r);
    // Found by a dish rather than its name: say which dishes.
    const dishHits = q && !r.name.toLowerCase().includes(q) ? menuOf(r).filter(d => d.toLowerCase().includes(q)) : [];
    const showDist = sortBy === 'distance' && userLocation && r.lat!=null && r.lng!=null;
    const distTxt = showDist ? distanceMiles(userLocation.lat, userLocation.lng, r.lat, r.lng).toFixed(1) + ' mi' : null;
    return `
      <div class="ticket" data-id="${r.id}">
        ${guides ? `<div class="ticket-guides">${escapeHtml(guides)}</div>` : ''}
        <div class="ticket-name">${nameLinkHtml(r, true)}</div>
        ${area || distTxt ? `<div class="ticket-area">${PIN_ICON}<span>${escapeHtml(area)}${distTxt ? `${area ? ' · ' : ''}<span class="dist-badge">${distTxt}</span>` : ''}</span></div>` : ''}
        ${dishHits.length ? `<div class="ticket-match">On the menu: ${dishHits.slice(0, 2).map(d => `<b>${escapeHtml(d)}</b>`).join(', ')}${dishHits.length > 2 ? ` +${dishHits.length - 2} more` : ''}</div>` : ''}
        <div class="ticket-meta">
          ${vs.length
            ? `<span class="visited-label">Visited</span>${starsHtml(avg)}<span class="last-visit">${fmtShortDate(vs[0].date)}</span>`
            : `<span class="not-visited">Not visited yet</span>`}
          ${isGem(r) || isTourist(r) ? `<span class="card-badges">${isGem(r) ? '<span class="gem-badge">Personal Gem</span>' : ''}${isTourist(r) ? '<span class="gem-badge tourist-badge">Tourist Spot</span>' : ''}</span>` : ''}
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
  // 'tileload' fires only for a tile that actually loaded. Leaflet's
  // layer-level 'load' also fires once every tile has *errored*, which made
  // a truly offline map (fast failures) look healthy and skip the fallback.
  let tilesOk = false;
  tileLayer.on('tileload', ()=>{ tilesOk = true; });
  tileLayer.addTo(leafletMap);

  withCoords.forEach(r=>{
    const vs = visitsFor(r.id);
    const visited = vs.length > 0;
    const color = visited ? '#E23A50' : '#4FA8DE';
    const marker = L.circleMarker([r.lat, r.lng], {
      radius: 8, color: '#12302799', weight: 2, fillColor: color, fillOpacity: 0.95
    }).addTo(leafletMap);
    marker.bindPopup(mapPopupHtml(r), { maxWidth: 320, minWidth: 240 });
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
    ${wasFallback ? `<div class="map-note">The street map couldn't load (you may be offline), so this shows each spot's position relative to the others instead.</div>` : ''}
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

/* A map pin's popup, in the same words as its card: guides, name, area
   and whether it's been visited, then Details / Directions / Website. */
function mapPopupHtml(r){
  const vs = visitsFor(r.id);
  const avg = avgRating(vs);
  const guides = guideLine(r);
  const area = areaLabel(r);
  const mapsHref = r.mapsUrl || ('https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(r.name + ' ' + (r.address||'')));
  const site = r.website || r.yelp;
  return `
    ${guides ? `<div class="map-popup-cat">${escapeHtml(guides)}</div>` : ''}
    <div class="map-popup-name">${escapeHtml(r.name)}</div>
    <div class="map-popup-meta">${area ? `${escapeHtml(area)} · ` : ''}${vs.length ? `visited ${starsHtml(avg)}` : 'not visited yet'}</div>
    <div class="map-popup-links">
      <button type="button" class="map-popup-link map-popup-detail" onclick="openDetail('${escapeHtml(r.id)}')">Details</button>
      <a class="map-popup-link" href="${escapeHtml(mapsHref)}" target="_blank" rel="noopener">Directions</a>
      ${site ? `<a class="map-popup-link" href="${escapeHtml(site)}" target="_blank" rel="noopener">${r.website ? 'Website' : 'Yelp'}</a>` : ''}
    </div>`;
}
function showMapPopup(mapEl, pinEl){
  const existing = mapEl.querySelector('.map-popup');
  if(existing) existing.remove();
  const id = pinEl.dataset.id;
  const r = restaurants.find(x=>x.id===id);
  if(!r) return;
  const popup = document.createElement('div');
  popup.className = 'map-popup';
  popup.style.left = pinEl.dataset.x + '%';
  popup.style.top = pinEl.dataset.y + '%';
  popup.innerHTML = `<button type="button" class="close-x" aria-label="Close">×</button>${mapPopupHtml(r)}`;
  mapEl.appendChild(popup);
  popup.addEventListener('click', (e)=> e.stopPropagation());
  popup.querySelector('.close-x').addEventListener('click', ()=> popup.remove());
  popup.querySelector('.map-popup-detail').addEventListener('click', ()=>{ popup.remove(); });
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
   viewBox for the block watermark. */
function areaShapePath(area){
  return polysShapePath(areaFeatures(area).flatMap(featurePolys));
}

/* Fits polygons (outer rings) into one 100x100 SVG path. Longitude is
   compressed by cos(latitude) first so shapes keep their real-world
   proportions. */
function polysShapePath(polys){
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
    return `<button class="area-side-label" data-type="side" data-name="${escapeHtml(side)}">${escapeHtml(side)}</button><div class="area-blocks">${blocks}</div>`;
  }).join('');
  const elsewhereBlock = unassigned ? `<div class="area-blocks">${areaBlockHTML({ type:'other', name:'Elsewhere in Chicago' })}</div>` : '';
  const chicagoSection = (sideSections || ghostNames.length) ? `
    ${sideSections}
    ${elsewhereBlock}
    ${ghostNames.length ? `<button class="ghost-toggle" id="ghostToggle">${showGhosts ? 'Hide' : 'Show'} ${ghostNames.length} unexplored neighborhood${ghostNames.length===1?'':'s'} ${showGhosts ? '▴' : '▾'}</button>` : ''}` : '';
  const suburbGroups = REGION_ORDER.filter(region => townByRegion[region]).map(region=>{
    const blocks = Object.keys(townByRegion[region]).sort(az).map(town => areaBlockHTML({ type:'town', name: town })).join('');
    return `<button class="area-group-label" data-type="region" data-name="${escapeHtml(region)}">${escapeHtml(region)}</button><div class="area-blocks">${blocks}</div>`;
  }).join('');

  el.innerHTML = `
    <div class="areas-head">
      <div>
        <div class="areas-title">Pick your territory</div>
        <div class="areas-sub">Tap a neighborhood and its spots and cuisines pop up.</div>
      </div>
      <div class="areas-head-actions">
        ${canManageListings() ? '<button class="btn secondary" id="addFromAreas">+ New Listing</button>' : ''}
        <button class="btn" id="browseAllBtn">Browse all listings →</button>
      </div>
    </div>
    <div class="area-groups">
      ${chicagoSection}
      ${suburbGroups}
    </div>
    <div class="data-row">
      <span>Shared ledger <span id="ledgerStatus" role="status" class="${sharedLedgerStatusError ? 'error' : ''}">${sharedLedgerStatus}</span></span>
    </div>
  `;

  $('#browseAllBtn').addEventListener('click', ()=>{ activeArea = null; currentPage = 'listings'; renderAll(); });
  const addFromAreas = $('#addFromAreas');
  if(addFromAreas) addFromAreas.addEventListener('click', openAddRestaurant);
  $$('.area-block', el).forEach(block=>{
    block.addEventListener('click', ()=> openArea({ type: block.dataset.type, name: block.dataset.name }));
  });
  $$('.area-group-label, .area-side-label', el).forEach(label=>{
    label.addEventListener('click', ()=> openArea({ type: label.dataset.type, name: label.dataset.name }));
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
    <button type="button" class="tool-btn back-btn" id="backToAreas">← Neighborhoods</button>
    <h2 class="area-title">${escapeHtml(activeArea ? activeArea.name : 'All of Chicagoland')}</h2>
    <span class="area-count">${count} spot${count===1?'':'s'}</span>
    ${activeArea ? `<button type="button" class="area-clear" id="clearArea" aria-label="Show all of Chicagoland" title="Show all of Chicagoland">×</button>` : ''}
  `;
  $('#backToAreas').addEventListener('click', ()=>{ currentPage = 'areas'; activeArea = null; renderAll(); });
  const clearBtn = $('#clearArea');
  if(clearBtn) clearBtn.addEventListener('click', ()=>{ activeArea = null; renderAll(); });
}

/* Line-only watermark behind the listings: the picked area's outline, or
   every Chicago neighborhood's for "Browse all" (a true Chicagoland outline
   would be a sparse scatter of suburbs). Hidden in map view, and when no
   boundary is on file (boundaries still loading/unavailable, "other"). */
function renderListingsBackdrop(){
  const el = $('#listingsBackdrop');
  const polys = currentPage !== 'listings' || viewMode === 'map' ? []
    : activeArea ? areaFeatures(activeArea).flatMap(featurePolys)
    : (hoodGeo?.features || []).flatMap(featurePolys);
  const shape = polysShapePath(polys);
  el.hidden = !shape;
  el.classList.toggle('all-areas', !activeArea);
  el.innerHTML = shape
    ? `<svg viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet"><path d="${shape}"/></svg>`
    : '';
}

function renderPageVisibility(){
  const listings = currentPage === 'listings';
  const profile = currentPage === 'profile';
  $('#areasPage').style.display = currentPage === 'areas' ? '' : 'none';
  $('#listingsLayout').style.display = listings ? '' : 'none';
  $('#profilePage').style.display = profile ? '' : 'none';
  $('#statsReceipt').style.display = profile ? 'none' : '';
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
  } else if(currentPage === 'profile'){
    renderProfilePage();
  } else {
    renderAreasPage();
  }
  renderAreaBanner();
  renderListingsBackdrop();
  updateAccessControls();
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

/* A username or display name change shows at once: the open listing
   window (reviews) and the Profile page redraw. */
function redrawForAccountChange(){
  const openDetailId = $('#modalRoot .modal[data-detail-id]')?.dataset.detailId;
  if(openDetailId) openDetail(openDetailId);
  if(currentPage === 'profile') renderProfilePage();
}
window.addEventListener('rounds-username-changed', redrawForAccountChange);
window.addEventListener('rounds-display-name-changed', redrawForAccountChange);

/* ---------- Profile ----------
   Username (public, unique, on every review), display name (private: only
   you see it, in your pill and here), the account's email and how it signs
   in, and your visits. */
function renderProfilePage(){
  const el = $('#profilePage');
  const user = window.RoundsFirebase?.auth?.currentUser;
  if(!user || window.roundsGuestMode){
    el.innerHTML = `<div class="profile-card paper paper-panel">
      <h2 class="profile-title">Your profile</h2>
      <p class="profile-note">Sign in to see your profile and your visits.</p>
      <button type="button" class="btn" id="profileSignIn">Sign in</button>
    </div>`;
    $('#profileSignIn').addEventListener('click', ()=> window.showRoundsAuthGate && window.showRoundsAuthGate());
    return;
  }
  const acct = window.RoundsAccount || {};
  const username = myUsername();
  const display = acct.displayName || username;
  const method = acct.signInMethod === 'google.com' ? 'Google' : (acct.signInMethod === 'password' ? 'Email and password' : '—');
  const mine = visits.filter(v => v.authorUid === user.uid).sort((a, b)=> String(b.date).localeCompare(String(a.date)));
  const avg = avgRating(mine);
  el.innerHTML = `<div class="profile-card paper paper-panel">
    <div class="profile-head">
      <h2 class="profile-title">Your profile</h2>
      <a href="#" class="text-link" id="profileBack">← Back</a>
    </div>

    <section class="profile-section">
      <label class="profile-label" for="profileUsername">Username <span class="label-note">(public: shown on every review)</span></label>
      <div class="profile-row">
        <input type="text" id="profileUsername" value="${escapeHtml(username)}" maxlength="20" autocomplete="username" autocapitalize="off" spellcheck="false">
        <button type="button" class="btn" id="profileUsernameSave">Save</button>
      </div>
      <div class="username-status" id="profileUsernameStatus" aria-live="polite"></div>
    </section>

    <section class="profile-section">
      <label class="profile-label" for="profileDisplayName">Display name <span class="label-note">(private: only you see it)</span></label>
      <div class="profile-row">
        <input type="text" id="profileDisplayName" value="${escapeHtml(display)}" maxlength="80" autocomplete="nickname">
        <button type="button" class="btn" id="profileDisplaySave">Save</button>
      </div>
      <div class="username-status" id="profileDisplayStatus" aria-live="polite"></div>
    </section>

    <section class="profile-section">
      <div class="profile-label">Account</div>
      <dl class="profile-facts">
        <div><dt>Email</dt><dd>${escapeHtml(user.email || '—')}</dd></div>
        <div><dt>Signs in with</dt><dd>${method}</dd></div>
        ${window.RoundsFirebase.isOwner() ? '<div><dt>Role</dt><dd><span class="owner-badge">Owner</span></dd></div>' : ''}
      </dl>
    </section>

    <section class="profile-section">
      <div class="profile-label">Your visits <span class="label-note">${mine.length ? `${mine.length} visit${mine.length===1?'':'s'} · ${avg.toFixed(1)}★ average` : ''}</span></div>
      ${mine.length ? `<ul class="profile-visits">${mine.map(v=>{
        const r = restaurants.find(x => x.id === v.restaurantId);
        return `<li><button type="button" class="profile-visit" data-rid="${escapeHtml(v.restaurantId)}">
          <span class="pv-name">${escapeHtml(r ? r.name : 'A removed listing')}</span>
          <span class="pv-meta">${fmtDate(v.date)} ${starsHtml(v.rating)}</span>
        </button></li>`;
      }).join('')}</ul>` : '<p class="profile-note">No visits yet. Open a listing and tap "+ Log a visit".</p>'}
    </section>

    <section class="profile-section profile-actions">
      <button type="button" class="btn quiet" id="profileSignOut">Sign out</button>
    </section>
  </div>`;

  $('#profileBack').addEventListener('click', (e)=>{ e.preventDefault(); currentPage = 'areas'; renderAll(); });
  $('#profileSignOut').addEventListener('click', ()=> window.RoundsFirebase.signOut(window.RoundsFirebase.auth));
  $$('.profile-visit', el).forEach(b => b.addEventListener('click', ()=>{ if(restaurants.some(r => r.id === b.dataset.rid)) openDetail(b.dataset.rid); }));
  const status = (id, text, kind)=>{ const s = $('#' + id); s.textContent = text; s.dataset.kind = kind || ''; };
  // Username: live availability, then one atomic save.
  const uInput = $('#profileUsername');
  let uTimer = null, uSeq = 0;
  uInput.addEventListener('input', ()=>{
    clearTimeout(uTimer);
    const name = uInput.value.trim();
    if(name === username){ status('profileUsernameStatus', ''); return; }
    const problem = acct.validateUsername(name);
    if(problem){ status('profileUsernameStatus', problem, 'bad'); return; }
    const mineSeq = ++uSeq;
    status('profileUsernameStatus', 'Checking…');
    uTimer = setTimeout(async ()=>{
      const free = await acct.isUsernameFree(name).catch(()=> null);
      if(mineSeq !== uSeq || free === null) return;
      status('profileUsernameStatus', free ? `${name} is available` : `${name} is taken`, free ? 'good' : 'bad');
    }, 300);
  });
  $('#profileUsernameSave').addEventListener('click', async ()=>{
    const name = uInput.value.trim();
    if(name === username) return;
    try{
      await acct.claimUsername(name);
      status('profileUsernameStatus', 'Saved. Your reviews now show it.', 'good');
    }catch(err){ status('profileUsernameStatus', err.message || 'Could not save — try again.', 'bad'); }
  });
  $('#profileDisplaySave').addEventListener('click', async ()=>{
    try{
      await acct.setDisplayName($('#profileDisplayName').value);
      status('profileDisplayStatus', 'Saved.', 'good');
    }catch(err){ status('profileDisplayStatus', err.message || 'Could not save — try again.', 'bad'); }
  });
}

/* One-time move (2026-11-16, at Brianna's request): her visits logged
   from her second Google account belong to the owner account. Runs on the
   owner's first sign-in once a username is set; each visit is re-created
   under the owner (same date, dishes, stars, review) and the old copy
   removed. A no-op once nothing is left to move. */
const MOVE_VISITS_FROM_UID = '6CU0HDaWexeVbO69buTBECU764R2';
let movingVisits = false;
async function moveOldAccountVisits(){
  if(movingVisits || !appBooted || !bootedAsOwner || !sharedLedgerReady || !myUsername()) return;
  const ownerUid = window.RoundsFirebase.auth.currentUser?.uid;
  const old = visits.filter(v => v.authorUid === MOVE_VISITS_FROM_UID);
  if(!ownerUid || !old.length) return;
  movingVisits = true;
  try{
    const moved = old.map(v => ({ ...v, id: uid(), authorUid: ownerUid, reviewer: myUsername() }));
    visits = [...visits.filter(v => v.authorUid !== MOVE_VISITS_FROM_UID), ...moved];
    await saveVisits();
    renderAll();
  } finally { movingVisits = false; }
}

function canWriteLedger(){
  return sharedLedgerReady && !!(window.RoundsFirebase && window.RoundsFirebase.auth && window.RoundsFirebase.auth.currentUser) && !window.roundsGuestMode;
}
function canManageListings(){
  return canWriteLedger() && window.RoundsFirebase.isOwner();
}
function updateAccessControls(){
  const guest = !!window.roundsGuestMode;
  document.body.classList.toggle('guest-mode', guest);
  const notice = $('#guestNotice');
  if(notice) notice.hidden = !guest;
  const addButton = $('#addRestaurantBtn');
  if(addButton) addButton.hidden = !canManageListings();
}
window.addEventListener('rounds-access-changed', ()=>{
  updateAccessControls();
  if(dataLoaded) renderAll();
});
// The owner's startup work (seeding curated listings, menus, addresses,
// area/neighborhood stamps, first upload to the shared ledger) lives in
// init(), which runs once per page load and only if that load *started*
// signed in as the owner. Signing in as the owner afterwards reloads once
// so that same tested path runs — rather than re-running it mid-session
// alongside live ledger updates. The view survives (it's in the URL hash),
// and the persisted session means this happens about once per device.
// Non-owner sign-ins have no startup work, so they never reload. Keyed on
// rounds-signed-in (dispatched by auth-gate.js after its profile write
// settles) so the reload never interrupts that write.
let signInSettled = false;
let ownerReloadStarted = false;
async function reloadIfOwnerSignedInAfterBoot(){
  if(ownerReloadStarted) return;
  if(!(appBooted && signInSettled && !bootedAsOwner && window.RoundsFirebase?.isOwner())) return;
  ownerReloadStarted = true;
  try{ await window.RoundsFirebase.prepareForReload(); }
  catch(error){ console.warn('Could not flush pending writes before reload:', error); }
  location.reload();
}
window.addEventListener('rounds-signed-in', ()=>{
  signInSettled = true;
  moveOldAccountVisits();
  if(appBooted) renderAll();
  // If this lands before init() finishes, init() re-checks once it does.
  reloadIfOwnerSignedInAfterBoot();
});

/* ---------- Chicagoland service area ----------
   The Rounds covers Chicago and its suburbs only: the seven Illinois
   counties of the Chicago metro (the CMAP region). New Listing refuses
   anything outside them — no Indiana or Wisconsin border towns, no
   downstate. */
const CHICAGOLAND_COUNTIES = new Set(['Cook', 'DuPage', 'Kane', 'Kendall', 'Lake', 'McHenry', 'Will']);
const CHICAGOLAND_AREA_TEXT = 'Chicago and its suburbs (Cook, DuPage, Kane, Kendall, Lake, McHenry and Will counties)';
// Those counties' bounding box — the Indiana line on the east, Wisconsin on
// the north — so Google's suggestions start out local. It's a rectangle, so
// the real check is the county (placeInChicagoland below).
const CHICAGOLAND_BOUNDS = { north: 42.495, south: 41.19, east: -87.524, west: -88.71 };
// Towns a hand-typed address may name without a Google match to verify it.
const KNOWN_CHICAGOLAND_TOWNS = new Set(['chicago', ...Object.keys(CITY_REGION).map(t => t.toLowerCase())]);
// Google suggestion text ends "…, Chicago, IL, USA"; anything else is out.
const ILLINOIS_SUGGESTION = /,\s*IL\b/;

/* Is a Google Places result inside the service area? Decided by its county
   when Google gives one (it does for U.S. street addresses), otherwise by
   being an Illinois address inside the bounding box. */
function placeInChicagoland(components, lat, lng){
  const part = (type) => (components || []).find(c => (c.types || []).includes(type));
  const state = part('administrative_area_level_1');
  if(!state || state.shortText !== 'IL') return false;
  const county = part('administrative_area_level_2');
  if(county) return CHICAGOLAND_COUNTIES.has(String(county.longText || '').replace(/\s+County$/i, ''));
  const b = CHICAGOLAND_BOUNDS;
  return lat != null && lng != null && lat <= b.north && lat >= b.south && lng <= b.east && lng >= b.west;
}
/* A hand-typed address (no Google match) counts only if it names a known
   Chicagoland town — there's nothing else to verify it against. */
function typedAddressInChicagoland(address){
  const town = parseTown(address);
  return !!town && KNOWN_CHICAGOLAND_TOWNS.has(town.toLowerCase());
}

function openAddRestaurant(){
  if(!canManageListings()){
    alert('Only the ledger manager can add listings.');
    return;
  }
  $('#modalRoot').innerHTML = `
    <div class="overlay" id="ov">
      <div class="modal paper add-modal" role="dialog" aria-modal="true" aria-labelledby="addTitle">
        <div class="paper-head">
          <div>
            <h2 id="addTitle">New listing</h2>
            <div class="paper-sub">Search it, tap it, done. Address, website and guides fill themselves in.</div>
          </div>
          <button type="button" class="close-btn" id="closeAdd" aria-label="Close">×</button>
        </div>
        <div class="places-notice" id="placesNotice" style="display:none;">
          Restaurant search isn't available right now, so manual entry is open below.
        </div>
        <div class="field">
          <label for="rName" id="rNameLabel">Restaurant</label>
          <div class="addr-autocomplete-wrap">
            <label class="search-pill big">${SEARCH_ICON}<input type="text" id="rName" placeholder="Search for a restaurant" autocomplete="off"></label>
            <ul id="nameSuggestions" class="addr-suggestions" style="display:none;"></ul>
          </div>
        </div>
        <div class="field" id="manualAddrField" style="display:none;">
          <label for="rAddr">Address</label>
          <div class="addr-autocomplete-wrap">
            <input type="text" id="rAddr" placeholder="e.g. 123 Main St, Oak Park, IL" autocomplete="off">
            <ul id="addrSuggestions" class="addr-suggestions" style="display:none;"></ul>
          </div>
        </div>
        <div class="filing-under" id="filingUnder" style="display:none;"></div>
        <div class="paper-actions">
          <a href="#" id="manualToggle" class="text-link">Not on Google Maps? Add it by hand</a>
          <button type="button" class="btn quiet" id="cancelAdd">Cancel</button>
          <button type="button" class="btn" id="saveAdd">Add listing</button>
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
  // Where the chips came from: 'google' (its place type), 'name' (guessed
  // from the name because Google only said "restaurant"), or null. Once the
  // user edits a chip, the guess never overwrites their choice.
  let tagSource = null;
  let tagsTouched = false;
  let manualAddressPlace = null;
  /* Editable guide chips, live in the modal before saving. Guides file
     themselves (from Google, or guessed from the name) and the user can
     change them; a spot may also be saved with none. */
  function renderFilingUnder(){
    const fu = $('#filingUnder');
    if(!fu) return;
    fu.style.display = '';
    const datalist = guideSuggestions().map(c=>`<option value="${escapeHtml(c)}">`).join('');
    fu.innerHTML = `<span class="filing-label">Filing under</span>
      ${pendingTags.map(t=>`<span class="tag-pill">${escapeHtml(t)}<button type="button" class="tag-x" data-tag="${escapeHtml(t)}" aria-label="Remove ${escapeHtml(t)}">×</button></span>`).join('')}
      <input type="text" id="addTagInput" class="tag-add" list="addTagList" placeholder="+ Add a guide" aria-label="Add a guide">
      <datalist id="addTagList">${datalist}</datalist>
      ${tagSource === 'name' && pendingTags.length && !tagsTouched ? '<span class="filing-note" id="guessNote">Guessed from the name. Change it if it\'s wrong.</span>' : ''}
      ${!pendingTags.length ? '<span class="filing-note">No guide yet. It can be added later from the listing.</span>' : ''}`;
    $$('#filingUnder .tag-x').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        tagsTouched = true;
        pendingTags = pendingTags.filter(t => t !== btn.dataset.tag);
        renderFilingUnder();
      });
    });
    const inp = $('#addTagInput');
    const commitTag = (refocus)=>{
      const val = inp.value.trim();
      if(!val) return;
      tagsTouched = true;
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
    tagSource = null;
    tagsTouched = false;
    $('#rName').placeholder = 'Restaurant name';
    $('#nameSuggestions').style.display = 'none';
    $('#nameSuggestions').innerHTML = '';
    $('#rName').focus();
    $('#manualAddrField').style.display = '';
    $('#manualToggle').style.display = 'none';
    renderFilingUnder();
  }
  $('#manualToggle').addEventListener('click', (ev)=>{ ev.preventDefault(); enableManualMode(); });

  /* Restaurant-name search — a custom dropdown, not Google's auto-
     rendering PlaceAutocompleteElement widget, because the widget can't
     be filtered per-result. Queried with no server-side type restriction
     (Places API (New) caps includedPrimaryTypes at 5 exact-match values —
     nowhere near enough to cover the 60+ types GOOGLE_TYPE_TAG knows
     about), then filtered client-side against FOOD_DRINK_TYPES so results
     stay restaurant/food-scoped without a 5-type ceiling silently
     excluding real businesses (ice cream shops, steakhouses, etc.) and
     force-routing them into manual mode with no website/phone/coordinates. */
  let nameDebounce = null;
  let placesBlocked = false;
  const nameList = $('#nameSuggestions');
  // The Places library, loaded once per window. Loading it is free; only
  // the requests below are billed.
  let placesLibrary = null;
  const loadPlaces = async ()=> placesLibrary || (placesLibrary = await google.maps.importLibrary('places'));
  // Google bills every keystroke's suggestions plus the final pick as ONE
  // request when they share a session token. One token per search, retired
  // once a result is picked (that pick's fetchFields closes the session).
  let nameSession = null;
  /* A blocked or misconfigured key fails every request, which would
     otherwise look like a dead search box — say so and open manual entry. */
  function placesUnavailable(err){
    console.warn('Restaurant search unavailable — opening manual entry.', err);
    if(placesBlocked) return;
    placesBlocked = true;
    $('#placesNotice').style.display = '';
    enableManualMode();
  }
  function hideNameSuggestions(){
    nameList.style.display = 'none';
    nameList.innerHTML = '';
  }
  async function selectPlace(prediction){
    const place = prediction.toPlace();
    await place.fetchFields({ fields: ['displayName','formattedAddress','location','internationalPhoneNumber','websiteURI','id','types','primaryType','addressComponents'] });
    nameSession = null;
    hideNameSuggestions();
    const lat = place.location ? place.location.lat() : null;
    const lng = place.location ? place.location.lng() : null;
    if(!placeInChicagoland(place.addressComponents, lat, lng)){
      selectedPlace = null;
      $('#rName').value = '';
      alert(`${place.displayName || 'That spot'} is outside Chicagoland — The Rounds only covers ${CHICAGOLAND_AREA_TEXT}.`);
      return;
    }
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
      lat, lng,
      phone: place.internationalPhoneNumber || null,
      website: place.websiteURI || null,
      placeId: place.id || null,
    };
    $('#rName').value = selectedPlace.name;
    // Google's type said nothing about the food ("restaurant")? File it by
    // what the name says instead.
    if(tags.length){ pendingTags = tags; tagSource = 'google'; }
    else { pendingTags = guessGuidesFromName(selectedPlace.name); tagSource = pendingTags.length ? 'name' : null; }
    tagsTouched = false;
    renderFilingUnder();
  }
  // Manual entry has no Google type at all: guess from the name as it's
  // typed, until the user sets the chips themselves.
  let guessDebounce = null;
  $('#rName').addEventListener('input', ()=>{
    if(!manualMode || tagsTouched) return;
    clearTimeout(guessDebounce);
    guessDebounce = setTimeout(()=>{
      // The user may have set a guide while this was waiting.
      if(tagsTouched) return;
      pendingTags = guessGuidesFromName($('#rName').value);
      tagSource = pendingTags.length ? 'name' : null;
      renderFilingUnder();
    }, 300);
  });
  $('#rName').addEventListener('input', ()=>{
    selectedPlace = null; // any edit invalidates a previously picked match
    clearTimeout(nameDebounce);
    const q = $('#rName').value.trim();
    if(manualMode || placesBlocked || q.length < 3){ hideNameSuggestions(); return; }
    nameDebounce = setTimeout(async ()=>{
      try{
        const { AutocompleteSuggestion, AutocompleteSessionToken } = await loadPlaces();
        if(!nameSession) nameSession = new AutocompleteSessionToken();
        const { suggestions } = await AutocompleteSuggestion.fetchAutocompleteSuggestions({
          input: q,
          locationRestriction: CHICAGOLAND_BOUNDS,
          sessionToken: nameSession,
        });
        if($('#rName').value.trim() !== q) return; // stale response, input moved on
        const picks = (suggestions || [])
          .filter(s => (s.placePrediction.types || []).some(t => FOOD_DRINK_TYPES.has(t)))
          .filter(s => ILLINOIS_SUGGESTION.test(s.placePrediction.text.text))
          .slice(0, 6);
        if(!picks.length){ hideNameSuggestions(); return; }
        nameList.innerHTML = picks.map((s, i)=>`<li data-i="${i}">${escapeHtml(s.placePrediction.text.text)}</li>`).join('');
        nameList.style.display = '';
        $$('li', nameList).forEach((li, i)=>{
          li.addEventListener('mousedown', (ev)=>{
            ev.preventDefault(); // fires before #rName's blur, so the pick isn't lost
            selectPlace(picks[i].placePrediction).catch(placesUnavailable);
          });
        });
      }catch(err){
        hideNameSuggestions();
        placesUnavailable(err);
      }
    }, 300);
  });
  $('#rName').addEventListener('blur', ()=> setTimeout(hideNameSuggestions, 150));

  // If the Maps script itself can't load, go straight to manual entry.
  // (Loading the library costs nothing — no search request is made.)
  loadPlaces().catch(placesUnavailable);

  /* Address autocomplete for manual mode only — the Places-search path
     already gets its address straight from the selected restaurant, so
     #rAddr never even renders there. #rAddr stays the actual source of
     truth (typing a freeform address and never picking a suggestion still
     saves fine, same as before); suggestions are a layered enhancement
     that additionally captures lat/lng, which manual entries never got
     before and which the map view / neighborhood filing both need. */
  let addrDebounce = null;
  let addrSession = null;
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
        const { AutocompleteSuggestion, AutocompleteSessionToken } = await loadPlaces();
        if(!addrSession) addrSession = new AutocompleteSessionToken();
        const { suggestions } = await AutocompleteSuggestion.fetchAutocompleteSuggestions({
          input: q,
          locationRestriction: CHICAGOLAND_BOUNDS,
          // 'geocode' was a legacy Autocomplete-widget filter value — the
          // Places API (New) used here only accepts real Table A types.
          includedPrimaryTypes: ['street_address', 'route', 'premise', 'subpremise'],
          sessionToken: addrSession,
        });
        if($('#rAddr').value.trim() !== q) return; // stale response, input moved on
        const picks = (suggestions || [])
          .filter(s => ILLINOIS_SUGGESTION.test(s.placePrediction.text.text))
          .slice(0, 6);
        if(!picks.length){ hideAddrSuggestions(); return; }
        addrList.innerHTML = picks.map((s, i)=>`<li data-i="${i}">${escapeHtml(s.placePrediction.text.text)}</li>`).join('');
        addrList.style.display = '';
        $$('li', addrList).forEach((li, i)=>{
          li.addEventListener('mousedown', async (ev)=>{
            ev.preventDefault(); // fires before #rAddr's blur, so the pick isn't lost
            const prediction = picks[i].placePrediction;
            const place = prediction.toPlace();
            await place.fetchFields({ fields: ['formattedAddress', 'location', 'addressComponents'] });
            addrSession = null;
            hideAddrSuggestions();
            const lat = place.location ? place.location.lat() : null;
            const lng = place.location ? place.location.lng() : null;
            if(!placeInChicagoland(place.addressComponents, lat, lng)){
              $('#rAddr').value = '';
              manualAddressPlace = null;
              alert(`That address is outside Chicagoland — The Rounds only covers ${CHICAGOLAND_AREA_TEXT}.`);
              return;
            }
            $('#rAddr').value = place.formattedAddress || prediction.text.text;
            // Verified in the service area; coordinates when Google has them.
            manualAddressPlace = { lat, lng };
          });
        });
      }catch(err){
        console.warn('Address autocomplete unavailable — manual typing still works.', err);
        hideAddrSuggestions();
      }
    }, 300);
  });
  $('#rAddr').addEventListener('blur', ()=> setTimeout(hideAddrSuggestions, 150));

  $('#saveAdd').addEventListener('click', async (e)=>{
    if(!canManageListings()) return;
    const name = manualMode ? $('#rName').value.trim() : (selectedPlace ? selectedPlace.name : '');
    const address = manualMode ? $('#rAddr').value.trim() : (selectedPlace ? selectedPlace.address : '');
    if(!name || (manualMode && !address)){
      alert(manualMode ? 'Name and address are required. (If it\'s not on Google Maps, the full address is on you.)' : 'Search and select a restaurant, or switch to manual entry.');
      return;
    }
    if(manualMode && !manualAddressPlace && !typedAddressInChicagoland(address)){
      alert(`The Rounds only covers ${CHICAGOLAND_AREA_TEXT}. Pick the address from the suggestions so it can be checked, or include a Chicagoland town (e.g. "123 Main St, Oak Park, IL").`);
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
    if(manualMode && manualAddressPlace && manualAddressPlace.lat != null){
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
  const canEditListing = canManageListings();
  const canLogVisit = canWriteLedger();
  const currentUid = window.RoundsFirebase?.auth?.currentUser?.uid;
  const vs = visitsFor(id);
  const avg = avgRating(vs);
  const datalist = guideSuggestions().map(c=>`<option value="${escapeHtml(c)}">`).join('');
  const guides = guideLine(r);
  const mapsHref = r.mapsUrl || (r.address ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(r.name + ' ' + r.address)}` : '');
  const dishCount = menuOf(r).length;
  const menuDate = menuCheckedDate(r);
  $('#modalRoot').innerHTML = `
    <div class="overlay sheet-overlay" id="ov">
      <div class="modal paper listing-modal" data-detail-id="${escapeHtml(id)}" role="dialog" aria-modal="true" aria-labelledby="detailName">
        <div class="sheet-handle" aria-hidden="true"></div>
        <div class="detail-top">
        <div class="detail-head">
          <div class="detail-head-text">
            ${canEditListing ? `<div class="tag-row" id="tagRow">
              ${(r.categories||[]).map(t=>`<span class="tag-pill">${escapeHtml(t)}<button class="tag-x" data-tag="${escapeHtml(t)}" aria-label="Remove ${escapeHtml(t)}">×</button></span>`).join('')}
              <input type="text" id="newTag" class="tag-add" list="tagList" placeholder="+ Add a guide" aria-label="Add a guide">
              <datalist id="tagList">${datalist}</datalist>
            </div>` : (guides ? `<div class="detail-guides">${escapeHtml(guides)}</div>` : '')}
            <div class="detail-name-row" id="nameRow">
              <h2 class="detail-name" id="detailName">${nameLinkHtml(r)}</h2>
              ${canEditListing ? `<button type="button" class="rename-btn" id="renameBtn" aria-label="Rename ${escapeHtml(r.name)}" title="Rename"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg></button>` : ''}
            </div>
          </div>
          <button class="close-btn" id="closeDet" aria-label="Close">×</button>
        </div>
            <div class="detail-links">
              ${r.address ? `<span class="detail-addr">${PIN_ICON}${escapeHtml(r.address)}</span>` : ''}
              ${mapsHref ? `<a href="${escapeHtml(mapsHref)}" target="_blank" rel="noopener" class="link-pill"><span class="wide-only">Open in Google Maps</span><span class="phone-only">Directions</span></a>` : ''}
              ${r.yelp ? `<a href="${escapeHtml(r.yelp)}" target="_blank" rel="noopener" class="link-pill">Yelp</a>` : ''}
              ${r.phone ? `<a href="tel:${r.phone.replace(/[^+\d]/g,'')}" class="link-pill"><span class="wide-only">${escapeHtml(r.phone)}</span><span class="phone-only">Call</span></a>` : ''}
            </div>
        </div>
        ${(canLogVisit || canEditListing) ? `<div class="detail-actions">
          ${canLogVisit ? '<button class="btn" id="logVisitBtn">+ Log a visit</button>' : ''}
          ${canEditListing ? '<button class="btn quiet danger" id="deleteRestBtn">Delete listing</button>' : ''}
        </div>` : ''}
        <section class="visit-list">
          <div class="section-head">
            <h3>Visits</h3>
            ${vs.length ? `<span class="section-sub">${vs.length} visit${vs.length===1?'':'s'} · ${avg.toFixed(1)} average</span>` : ''}
          </div>
          <div id="visitItems">
            ${vs.length ? vs.map(v=>`
              <div class="visit-item" data-vid="${v.id}">
                <div class="visit-top">
                  <span class="visit-who">${escapeHtml(reviewerName(v))}</span>
                  <span class="visit-date">${fmtDate(v.date)}</span>
                  ${starsHtml(v.rating)}
                  <span class="return-pill ${v.wouldReturn ? 'yes' : 'no'}">${v.wouldReturn ? 'Would go back' : "Wouldn't go back"}</span>
                  <span class="visit-tools">
                    ${canLogVisit && v.authorUid === currentUid ? `<button type="button" class="visit-edit" data-vid="${v.id}">Edit</button>` : ''}
                    ${(canLogVisit && v.authorUid === currentUid) || canEditListing ? `<button type="button" class="trash" data-vid="${v.id}">Remove</button>` : ''}
                  </span>
                </div>
                ${visitAteHtml(v)}
                ${v.notes ? `<div class="visit-line"><span class="visit-lbl">Review</span> ${escapeHtml(v.notes)}</div>` : ''}
              </div>
            `).join('') : `<div class="no-visits">No visits logged yet.</div>`}
          </div>
        </section>
        <section class="menu-section">
          <div class="section-head menu-head">
            <h3>Menu</h3>
            ${dishCount ? `<span class="section-sub">${dishCount} dish${dishCount===1?'':'es'}${menuDate ? ` · checked ${fmtDate(menuDate)}` : ''}</span>` : ''}
            ${dishCount ? `<label class="search-pill menu-search">${SEARCH_ICON}<input type="search" id="menuSearch" placeholder="Search this menu" aria-label="Search this menu" autocomplete="off"></label>` : ''}
          </div>
          <div class="menu-acc" id="menuChips"></div>
        </section>
      </div>
    </div>
  `;
  // The menu: sections that open and close, a search box, and how many
  // logged visits ordered each dish.
  const menuEl = $('#menuChips');
  const menuState = { query: '', open: new Set([GROUP_FAVORITES, defaultOpenSection(menuGroupsFor(r))]), showAll: false };
  const renderMenu = ()=>{ menuEl.innerHTML = menuAccordionHtml(r, menuState); };
  renderMenu();
  menuEl.addEventListener('click', (e)=>{
    const head = e.target.closest('.menu-sec-head');
    if(head){
      const sec = head.closest('.menu-group').dataset.section;
      if(menuState.open.has(sec)) menuState.open.delete(sec); else menuState.open.add(sec);
      renderMenu();
      return;
    }
    if(e.target.closest('.menu-more')){ menuState.showAll = true; renderMenu(); }
  });
  const menuSearch = $('#menuSearch');
  if(menuSearch) menuSearch.addEventListener('input', ()=>{ menuState.query = menuSearch.value; renderMenu(); });
  // Rename: only the shown name changes. Visits, menu, guides and curated
  // links stay attached (they follow the listing's id and curatedKey()).
  const renameBtn = $('#renameBtn');
  if(renameBtn) renameBtn.addEventListener('click', ()=>{
    $('#nameRow').innerHTML = `<form class="rename-form" id="renameForm">
      <input type="text" id="renameInput" maxlength="120" value="${escapeHtml(r.name)}" aria-label="Listing name">
      <button type="submit" class="btn">Save</button>
      <button type="button" class="btn quiet" id="renameCancel">Cancel</button>
    </form>`;
    const input = $('#renameInput');
    input.focus(); input.select();
    $('#renameCancel').addEventListener('click', ()=> openDetail(id));
    $('#renameForm').addEventListener('submit', async (e)=>{
      e.preventDefault();
      if(!canManageListings()) return;
      const next = input.value.trim().replace(/\s+/g, ' ');
      if(!next){ alert('A listing needs a name.'); return; }
      if(next === r.name){ openDetail(id); return; }
      if(restaurants.some(x => x.id !== id && x.name.toLowerCase() === next.toLowerCase())){
        alert(`There's already a listing called "${next}".`);
        return;
      }
      if(!r.curatedName) r.curatedName = r.name;
      r.name = next;
      await saveRestaurants();
      openDetail(id);
      renderAll();
    });
  });
  $('#closeDet').addEventListener('click', closeModal);
  $('#ov').addEventListener('click', (e)=>{ if(e.target.id==='ov') closeModal(); });
  $$('.visit-edit', $('#modalRoot')).forEach(btn => btn.addEventListener('click', ()=> openLogVisit(id, btn.dataset.vid)));
  const logVisitButton = $('#logVisitBtn');
  if(logVisitButton) logVisitButton.addEventListener('click', ()=> openLogVisit(id));
  const deleteRestaurantButton = $('#deleteRestBtn');
  if(deleteRestaurantButton) deleteRestaurantButton.addEventListener('click', async ()=>{
    if(!canManageListings()){
      alert('Only the ledger manager can delete listings.');
      return;
    }
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
      if(!canManageListings()){
        alert('Only the ledger manager can edit listing tags.');
        return;
      }
      e.stopPropagation();
      removeTagFromRestaurant(id, btn.dataset.tag);
      await saveRestaurants();
      openDetail(id);
      renderAll();
    });
  });
  const newTagInput = $('#newTag');
  const commitTag = async ()=>{
    if(!canManageListings()){
      alert('Only the ledger manager can add listing tags.');
      return;
    }
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
  if(newTagInput){
    newTagInput.addEventListener('keydown', (e)=>{
      if(e.key === 'Enter'){ e.preventDefault(); commitTag(); }
    });
    newTagInput.addEventListener('blur', commitTag);
  }
  $$('.trash', $('#modalRoot')).forEach(btn=>{
    btn.addEventListener('click', async (e)=>{
      // Authors remove their own visits; the owner can remove any (spam,
      // or a review that doesn't belong) — firestore.rules allows the same.
      const target = visits.find(v=>v.id===e.target.dataset.vid);
      const own = target?.authorUid === currentUid;
      if(!canWriteLedger() || !(own || canManageListings())){
        alert('You can only remove your own visits.');
        return;
      }
      if(!own && !confirm(`Remove ${target.reviewer ? target.reviewer + "'s" : 'this'} visit? This can't be undone.`)) return;
      const vid = e.target.dataset.vid;
      visits = visits.filter(v=>v.id!==vid);
      await saveVisits();
      openDetail(id);
      renderAll();
    });
  });
}

/* Log a Visit, or edit one of your own (visitId). Each dish you check can
   carry its own stars and the changes you asked for ("no onions"); the
   visit's notes are the overall review. */
const DISH_MOD_MAX = 200;
function openLogVisit(restaurantId, visitId){
  if(!canWriteLedger()){
    alert('Sign in to log a visit.');
    return;
  }
  const myUid = window.RoundsFirebase.auth.currentUser.uid;
  const editing = visitId ? visits.find(v => v.id === visitId) : null;
  if(visitId && (!editing || editing.authorUid !== myUid)){
    alert('You can only edit your own visits.');
    return;
  }
  const rest = restaurants.find(x=>x.id===restaurantId);
  const menu = rest ? menuOf(rest) : [];
  const today = localDateStr();
  let rating = editing ? editing.rating : 0;
  let wouldReturn = editing ? editing.wouldReturn : null;
  let selectedDate = editing ? editing.date : today;
  let calViewYear = parseInt(selectedDate.slice(0,4));
  let calViewMonth = parseInt(selectedDate.slice(5,7)) - 1;

  // What's checked, and each checked dish's stars and changes. Lives here,
  // so closing a section or searching never loses any of it.
  const picked = new Set();
  const details = new Map(); // dish -> { rating, mod }
  // Dishes an older visit recorded that aren't on the menu any more stay
  // on the visit untouched.
  const keptAte = [];
  if(editing){
    const byLower = new Map(menu.map(d => [d.toLowerCase(), d]));
    ateList(editing).forEach(d=>{
      const onMenu = byLower.get(String(d).toLowerCase());
      if(onMenu) picked.add(onMenu); else keptAte.push(d);
    });
    (editing.dishDetails || []).forEach(x=>{
      const onMenu = byLower.get(String(x.dish || '').toLowerCase());
      if(onMenu) details.set(onMenu, { rating: x.rating || 0, mod: x.mod || '' });
    });
  }

  $('#modalRoot').innerHTML = `
    <div class="overlay" id="ov2">
      <div class="modal paper log-modal" role="dialog" aria-modal="true" aria-labelledby="logTitle">
        <div class="paper-head">
          <div class="log-who">
            <h2 id="logTitle">${editing ? 'Edit visit' : 'Log a visit'}${rest ? ` · ${escapeHtml(rest.name)}` : ''}</h2>
            <div class="logged-by">${editing ? 'Your visit, as' : 'Logging as'} <b>${escapeHtml(myUsername())}</b></div>
          </div>
          <button type="button" class="close-btn" id="closeLog" aria-label="Close">×</button>
        </div>
        <div class="log-grid">
        <div class="log-left">
        <div class="field log-date">
          <div class="field-row"><span class="field-label" id="dateLabel">Date</span>
          <button type="button" class="date-display" id="dateDisplay" aria-describedby="dateLabel">${fmtDate(selectedDate)}</button></div>
          <div class="mini-cal" id="miniCal">
            <div class="mini-cal-head">
              <button type="button" id="calPrev" aria-label="Previous month">‹</button>
              <span id="calMonthLabel"></span>
              <button type="button" id="calNext" aria-label="Next month">›</button>
            </div>
            <div class="mini-cal-grid" id="calGrid"></div>
          </div>
        </div>
        <div class="field log-rating">
          <span class="field-label" id="ratingLabel">Overall rating</span>
          ${starSliderHtml({ id: 'starPick', value: rating, label: 'Overall rating', size: 'big' })}
        </div>
        <div class="field log-return">
          <span class="field-label" id="returnLabel">Would you go back?</span>
          <div class="toggle-pair" role="group" aria-labelledby="returnLabel">
            <button type="button" class="yes" id="wrYes" aria-pressed="false">Yes</button>
            <button type="button" class="no" id="wrNo" aria-pressed="false">No</button>
          </div>
        </div>
        <div class="field log-notes">
          <label for="vNotes">Overall review <span class="label-note">(optional)</span></label>
          <textarea id="vNotes" maxlength="2000" placeholder="How was it overall? Service, vibe, the wait…">${editing ? escapeHtml(editing.notes || '') : ''}</textarea>
        </div>
        </div>
        <div class="field log-ate">
          <div class="field-row">
            <span class="field-label">What did you eat?</span>
            ${menu.length ? `<label class="search-pill dish-search">${SEARCH_ICON}<input type="search" id="dishSearch" placeholder="Find a dish" aria-label="Find a dish" autocomplete="off"></label>` : ''}
          </div>
          ${menu.length ? `<div class="dish-hint">Check a dish to rate it and note any changes you asked for.</div><div class="dish-checklist menu-acc" id="dishArea"></div>` : '<div class="no-dishes">No menu on file yet. Type what you had below.</div>'}
          <input type="text" id="vAte" class="something-else" placeholder="+ Something not on the menu" aria-label="Something not on the menu">
        </div>
        </div>
        <div class="paper-actions">
          <button type="button" class="btn quiet" id="cancelLog">Cancel</button>
          <button type="button" class="btn" id="saveLog">${editing ? 'Save changes' : 'Save visit'}</button>
        </div>
      </div>
    </div>
  `;

  const dishState = { query: '', open: new Set([defaultOpenSection(rest ? menuGroupsFor(rest) : [])]), showAll: false };
  // Editing: open every section that holds a dish you had, so it's visible.
  if(editing && rest) menuGroupsFor(rest).forEach(g=>{ if(g.title && g.dishes.some(d => picked.has(d))) dishState.open.add(g.title); });
  const dishArea = $('#dishArea');
  const detailHtml = (d)=>{
    const x = details.get(d) || { rating: 0, mod: '' };
    return `<div class="dish-detail">
      ${starSliderHtml({ value: x.rating, label: `Your rating for ${d}`, size: 'small' })}
      <input type="text" class="dish-mod" maxlength="${DISH_MOD_MAX}" value="${escapeHtml(x.mod)}" placeholder="Any changes? e.g. no onions" aria-label="Changes to ${escapeHtml(d)}">
    </div>`;
  };
  const pickRow = (d)=> `<div class="dish-pick" data-dish="${escapeHtml(d)}"><label class="dish-check"><input type="checkbox" data-dish="${escapeHtml(d)}"${picked.has(d) ? ' checked' : ''}><span>${escapeHtml(d)}</span></label>${picked.has(d) ? detailHtml(d) : ''}</div>`;
  // Each dish's own stars: a change goes to every row of that dish.
  const wireDishSliders = ()=>{
    if(!dishArea) return;
    dishArea.querySelectorAll('.star-slider:not([data-wired])').forEach(el => wireStarSlider(el, { clearable: true, onChange: (v)=>{
      const d = el.closest('.dish-pick').dataset.dish;
      details.set(d, { mod: '', ...(details.get(d) || {}), rating: v });
      rowsFor(d).forEach(row=>{ const other = row.querySelector('.star-slider'); if(other && other !== el) other._setStars(v); });
    }}));
  };
  const renderDishes = ()=>{ if(dishArea){ dishArea.innerHTML = menuAccordionHtml(rest, dishState, pickRow); wireDishSliders(); } };
  // A dish listed in two sections has two rows; every change goes to both.
  const rowsFor = (d)=> [...dishArea.querySelectorAll('.dish-pick')].filter(el => el.dataset.dish === d);
  renderDishes();
  if(dishArea){
    dishArea.addEventListener('change', (e)=>{
      const box = e.target.closest('input[type="checkbox"][data-dish]');
      if(!box) return;
      const d = box.dataset.dish;
      if(box.checked) picked.add(d); else picked.delete(d);
      rowsFor(d).forEach(row=>{
        row.querySelector('input[type="checkbox"]').checked = box.checked;
        const open = row.querySelector('.dish-detail');
        if(box.checked && !open) row.insertAdjacentHTML('beforeend', detailHtml(d));
        if(!box.checked && open) open.remove();
      });
      wireDishSliders();
    });
    dishArea.addEventListener('input', (e)=>{
      const mod = e.target.closest('.dish-mod');
      if(!mod) return;
      const d = mod.closest('.dish-pick').dataset.dish;
      details.set(d, { ...(details.get(d) || { rating: 0 }), mod: mod.value });
      rowsFor(d).forEach(row=>{ const other = row.querySelector('.dish-mod'); if(other && other !== mod) other.value = mod.value; });
    });
    dishArea.addEventListener('click', (e)=>{
      const head = e.target.closest('.menu-sec-head');
      if(head && !head.classList.contains('static')){
        const sec = head.closest('.menu-group').dataset.section;
        if(dishState.open.has(sec)) dishState.open.delete(sec); else dishState.open.add(sec);
        renderDishes();
      } else if(e.target.closest('.menu-more')){ dishState.showAll = true; renderDishes(); }
    });
    $('#dishSearch').addEventListener('input', (e)=>{ dishState.query = e.target.value; renderDishes(); });
  }

  function renderCalendar(){
    const grid = $('#calGrid');
    const label = $('#calMonthLabel');
    const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    label.textContent = monthNames[calViewMonth] + ' ' + calViewYear;
    const firstDay = new Date(calViewYear, calViewMonth, 1).getDay();
    const daysInMonth = new Date(calViewYear, calViewMonth+1, 0).getDate();
    let html = ['S','M','T','W','T','F','S'].map(d=>`<div class="cal-dow">${d}</div>`).join('');
    for(let i=0;i<firstDay;i++) html += `<div class="cal-cell cal-blank"></div>`;
    for(let day=1; day<=daysInMonth; day++){
      const dStr = `${calViewYear}-${String(calViewMonth+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
      const isSel = dStr === selectedDate;
      const isToday = dStr === today;
      html += `<button type="button" class="cal-cell${isSel?' selected':''}${isToday?' today':''}" data-date="${dStr}">${day}</button>`;
    }
    grid.innerHTML = html;
    $$('.cal-cell:not(.cal-blank)', grid).forEach(cell=>{
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

  wireStarSlider($('#starPick'), { onChange: (v)=>{ rating = v; } });
  const setReturn = (yes)=>{
    wouldReturn = yes;
    $('#wrYes').classList.toggle('on', yes); $('#wrYes').setAttribute('aria-pressed', String(yes));
    $('#wrNo').classList.toggle('on', !yes); $('#wrNo').setAttribute('aria-pressed', String(!yes));
  };
  if(wouldReturn !== null) setReturn(wouldReturn);
  $('#wrYes').addEventListener('click', ()=> setReturn(true));
  $('#wrNo').addEventListener('click', ()=> setReturn(false));
  $('#closeLog').addEventListener('click', ()=> openDetail(restaurantId));
  $('#cancelLog').addEventListener('click', ()=> openDetail(restaurantId));
  $('#ov2').addEventListener('click', (e)=>{ if(e.target.id==='ov2') openDetail(restaurantId); });

  $('#saveLog').addEventListener('click', async (e)=>{
    if(!canWriteLedger()) return;
    if(!rating){ alert('Pick a rating.'); return; }
    if(wouldReturn === null){ alert('Let us know if you\'d go back.'); return; }
    // Every account has a username before it can get here (the sign-in
    // flow asks for one); it's what the review shows.
    const reviewerName = myUsername();
    if(!reviewerName){ alert('Pick a username first — it\'s shown on your reviews.'); return; }
    const date = selectedDate || today;
    const typedDish = $('#vAte').value.trim();
    const ate = [...picked, ...keptAte];
    if(typedDish && !ate.some(d => String(d).toLowerCase() === typedDish.toLowerCase())) ate.push(typedDish);
    // Only dishes that got stars or changes are recorded here; the plain
    // "what I had" list stays in `ate`. Always written (even empty) so an
    // edit that clears every dish's stars really clears them.
    const dishDetails = [...picked].map(d=>{
      const x = details.get(d) || {};
      const out = { dish: d };
      if(x.rating) out.rating = x.rating;
      const mod = String(x.mod || '').trim().slice(0, DISH_MOD_MAX);
      if(mod) out.mod = mod;
      return out;
    }).filter(x => x.rating || x.mod);
    const notes = $('#vNotes').value.trim();
    if(editing){
      Object.assign(editing, { date, ate, dishDetails, rating, wouldReturn, notes, reviewer: reviewerName });
    } else {
      visits.push({ id: uid(), restaurantId, date, ate, dishDetails, rating, wouldReturn, notes, reviewer: reviewerName, authorUid: myUid, createdAt: Date.now() });
    }
    if(typedDish && addDishToMenu(restaurantId, typedDish)) await saveRestaurants();
    await saveVisits();
    if(!editing){
      const rect = e.target.getBoundingClientRect();
      spawnConfetti(rect.left + rect.width/2, rect.top + rect.height/2);
    }
    openDetail(restaurantId);
    renderAll();
  });
}

$('#addRestaurantBtn').addEventListener('click', openAddRestaurant);
$('#railToggle').addEventListener('click', openRail);
$('#railScrim').addEventListener('click', closeRail);

$('#sortSelect').addEventListener('change', (e)=>{
  sortBy = e.target.value;
  if(sortBy === 'distance') requestUserLocation();
  renderContent();
});

let searchDebounce = null;
$('#searchBox').addEventListener('input', (e)=>{
  searchQuery = e.target.value;
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(renderContent, 150);
});

/* The three filters. On phones they fold behind one "Filters" button,
   which shows how many are on. */
function syncFilterChips(){
  const on = { unvisitedToggle: unvisitedOnly, gemsToggle: gemsOnly, touristToggle: touristOnly, recentToggle: recentOnly };
  Object.entries(on).forEach(([id, active])=>{
    const chip = document.getElementById(id);
    chip.classList.toggle('active', active);
    chip.setAttribute('aria-pressed', String(active));
  });
  const count = Object.values(on).filter(Boolean).length;
  const badge = $('#filtersCount');
  badge.hidden = !count;
  badge.textContent = count ? String(count) : '';
}
$('#filtersToggle').addEventListener('click', ()=>{
  const open = !$('#filterChips').classList.contains('open');
  $('#filterChips').classList.toggle('open', open);
  $('#filtersToggle').setAttribute('aria-expanded', String(open));
});
$('#unvisitedToggle').addEventListener('click', ()=>{ unvisitedOnly = !unvisitedOnly; syncFilterChips(); renderContent(); });
$('#gemsToggle').addEventListener('click', ()=>{ gemsOnly = !gemsOnly; syncFilterChips(); renderContent(); });
$('#touristToggle').addEventListener('click', ()=>{ touristOnly = !touristOnly; syncFilterChips(); renderContent(); });
$('#recentToggle').addEventListener('click', ()=>{ recentOnly = !recentOnly; syncFilterChips(); renderContent(); });

$$('#viewOpts button').forEach(btn=>{
  btn.addEventListener('click', ()=>{
    viewMode = btn.dataset.view;
    $$('#viewOpts button').forEach(b=>{ b.classList.toggle('active', b===btn); b.setAttribute('aria-pressed', String(b===btn)); });
    renderContent();
    renderListingsBackdrop();
  });
});


/* The curated guide listings predate the live app, so they all carry this
   one fixed "added" date — stamping them with the moment they were seeded
   made every curated spot look brand new (all 248 under Recently Added, and
   Date Added sorting meaningless). Only listings added through New Listing
   carry their real add time. `seeded: true` marks a curated record. */
const CURATED_ADDED_AT = Date.UTC(2026, 6, 1); // July 1, 2026
/* Each curated guide reaches a listing once. `seedTags` remembers which
   ones it has been given, so a guide (or gem) Brianna removes in the app
   stays removed, while a guide newly added to the curated data still
   arrives — once. Listings from before this existed count as having been
   given every curated guide already (they all were, every startup). */
async function seedIfNeeded(){
  let added = false;
  const seedCats = new Map();
  SEED_RESTAURANTS.forEach(s=>{
    const key = s.name.toLowerCase();
    if(!seedCats.has(key)) seedCats.set(key, []);
    if(!seedCats.get(key).includes(s.category)) seedCats.get(key).push(s.category);
  });
  SEED_RESTAURANTS.forEach(s=>{
    const existing = restaurants.find(r => curatedKey(r) === s.name.toLowerCase());
    if(existing){
      if(!Array.isArray(existing.seedTags)){
        existing.seedTags = [...seedCats.get(s.name.toLowerCase())];
        added = true;
      } else if(!existing.seedTags.includes(s.category)){
        addTagToRestaurant(existing.id, s.category);
        existing.seedTags.push(s.category);
        added = true;
      }
      if(!existing.address && s.address){ existing.address = s.address; added = true; }
    } else {
      restaurants.push({ id: uid(), name: s.name, categories: [s.category], seedTags: [s.category], address: s.address || '', createdAt: CURATED_ADDED_AT, seeded: true });
      added = true;
    }
  });
  if(added) await saveRestaurants();
}

/* Migration: curated listings seeded before CURATED_ADDED_AT existed got
   the seeding moment as their createdAt. Re-date them once (the `seeded`
   flag marks it done). Safe to re-run. */
async function redateCuratedListings(){
  const curatedNames = new Set(SEED_RESTAURANTS.map(s => s.name.toLowerCase()));
  let changed = false;
  restaurants.forEach(r=>{
    if(r.seeded || !curatedNames.has(curatedKey(r))) return;
    if(!r.createdAt || r.createdAt > CURATED_ADDED_AT) r.createdAt = CURATED_ADDED_AT;
    r.seeded = true;
    changed = true;
  });
  if(changed) await saveRestaurants();
}


async function enrichAddresses(){
  let changed = false;
  ADDRESS_LOOKUP.forEach(entry=>{
    const r = restaurants.find(x => curatedKey(x) === entry.name.toLowerCase());
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
  // Renamed 2026-11-16 at Brianna's request: the gems are her own picks.
  'Chicago Gems': 'Personal Gems',
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
  "Watta Potato by Yogis Bistro": ["Chicago Gems", "Personal Gems"],
  "Tastee Rolls": ["Chicago Gems", "Personal Gems"],
  // Hot Dogs / Halal never came from a guide — retired as categories.
  "Portillo's": ["Hot Dogs"],
  "Devil Dawgs": ["Hot Dogs"],
  "Maxwell Street Depot": ["Hot Dogs"],
  "Halal Smash Burger & Phillies": ["Halal"],
};
async function removeStrayTags(){
  let changed = false;
  Object.entries(REMOVED_TAGS_BY_NAME).forEach(([name, tagsToRemove])=>{
    const r = restaurants.find(x => curatedKey(x) === name.toLowerCase());
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
    const r = restaurants.find(x => curatedKey(x) === entry.name.toLowerCase());
    if(!r) return;
    // Entries are versioned: bumping `v` re-applies a corrected menu on
    // devices that already seeded an older one. `retire` names seed dishes
    // the correction removes — user-added dishes are never touched.
    const ver = entry.v || 1;
    const seeded = r.menuSeeded === true ? 1 : (r.menuSeeded || 0);
    if(seeded >= ver){
      // Already seeded. Older versions stamped menuUpdated with the moment
      // seeding ran (a meaningless date); correct it to the curation date.
      if(entry.asOf && r.menuUpdated !== entry.asOf){ r.menuUpdated = entry.asOf; changed = true; }
      return;
    }
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
    // When the menu was last checked against its source (YYYY-MM-DD) —
    // not when this device happened to seed it.
    if(entry.asOf) r.menuUpdated = entry.asOf;
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
    restaurants.filter(r => REMOVED_LISTING_NAMES.some(n => n.toLowerCase() === curatedKey(r))).map(r => r.id)
  );
  if(removeIds.size === 0) return;
  restaurants = restaurants.filter(r => !removeIds.has(r.id));
  visits = visits.filter(v => !removeIds.has(v.restaurantId));
  await saveRestaurants();
  await saveVisits();
}

async function waitForFirebase(){
  if(window.RoundsFirebase) return window.RoundsFirebase;
  return new Promise((resolve)=>{
    const timeout = setTimeout(()=> resolve(null), 10000);
    window.addEventListener('rounds-firebase-ready', ()=>{
      clearTimeout(timeout);
      resolve(window.RoundsFirebase || null);
    }, { once: true });
  });
}

(async function init(){
  await loadData();
  const firebase = await waitForFirebase();
  let watcher = null;
  let cloudAvailable = false;
  let owner = false;

  if(firebase){
    try{
      await firebase.authStateReady;
      owner = firebase.isOwner();
      bootedAsOwner = owner;
      watcher = firebase.watchSharedLedger();
      const shared = await watcher.ready;
      cloudAvailable = true;
      const hasCloudData = shared.restaurants.length > 0 || shared.visits.length > 0;
      if(owner){
        const mergeById = (cloudRecords, localRecords)=>{
          const cloudIds = new Set(cloudRecords.map((record)=> record.id));
          return [...cloudRecords, ...localRecords.filter((record)=> !cloudIds.has(record.id))];
        };
        restaurants = mergeById(shared.restaurants, restaurants);
        visits = mergeById(shared.visits, visits);
      } else {
        restaurants = shared.restaurants;
        visits = shared.visits;
      }
      if(hasCloudData || !owner){
        await store.set('restaurants', JSON.stringify(restaurants));
        await store.set('visits', JSON.stringify(visits));
      }
    }catch(error){
      console.warn('Shared ledger unavailable; using this browser\'s cached copy.', error);
      if(watcher) watcher.unsubscribe();
      watcher = null;
      setSharedLedgerStatus('Offline copy', true);
    }
  }

  if(owner || !firebase){
    await migrateCategories();
    await seedIfNeeded();
    await redateCuratedListings();
    await enrichAddresses();
    await removeClosedPlaces();
    await renameCuisineTags();
    await stripParentDessertTag();
    await removeStrayTags();
    await removeRemovedListings();
    await seedMenusFromVisits();
    await seedCuratedMenus();
    await assignAreas();
  }

  if(cloudAvailable && watcher){
    if(owner){
      const ownerUid = firebase.auth.currentUser.uid;
      visits.forEach((visit)=> { if(!visit.authorUid) visit.authorUid = ownerUid; });
      try{
        await firebase.syncSharedLedger('restaurants', restaurants);
        await firebase.syncSharedLedger('visits', visits);
      }catch(error){
        console.error('Could not initialize the shared ledger:', error);
        watcher.unsubscribe();
        watcher = null;
        cloudAvailable = false;
        setSharedLedgerStatus('Sync issue', true);
      }
    }
  }

  if(cloudAvailable && watcher){
    sharedLedgerReady = true;
    watcher.subscribe(async (changes)=>{
      if(changes.restaurants) restaurants = changes.restaurants;
      if(changes.visits) visits = changes.visits;
      if(changes.restaurants) await store.set('restaurants', JSON.stringify(restaurants));
      if(changes.visits) await store.set('visits', JSON.stringify(visits));
      if(dataLoaded) renderAll();
    });
    setSharedLedgerStatus('Shared');
  }

  // Everyone's public username, live, for the names on reviews.
  if(firebase && cloudAvailable){
    firebase.watchProfiles((byUid)=>{
      profilesByUid = byUid;
      if(!dataLoaded) return;
      const openDetailId = $('#modalRoot .modal[data-detail-id]')?.dataset.detailId;
      if(openDetailId && !$('#modalRoot .log-modal')) openDetail(openDetailId);
    });
  }

  applyHash(); // restores the view from the address (empty hash = landing)
  appBooted = true;
  moveOldAccountVisits();
  reloadIfOwnerSignedInAfterBoot(); // owner signed in while init() was running
  // Signals that restaurants/visits/saveRestaurants/renderAll are safe to
  // touch from outside the app (e.g. test fixtures via page.evaluate),
  // mirroring the rounds-firebase-ready event in firebase-init.js.
  window.dispatchEvent(new Event('rounds-app-ready'));
  // Boundary data (city neighborhoods + suburb towns) loads in the
  // background; neighborhood stamps persist on each record once assigned,
  // so these are real fetches only the first time.
  Promise.allSettled([loadHoodGeo(), loadTownGeo()]).then(async ()=>{
    if(hoodGeo && owner) await assignNeighborhoods(hoodGeo);
    renderAll();
    // Background boot work (boundary data + the owner's neighborhood
    // writes) is done. Lets test fixtures avoid reloading/closing a page
    // while those writes are still in flight.
    window.dispatchEvent(new Event('rounds-boot-settled'));
  });
})();
