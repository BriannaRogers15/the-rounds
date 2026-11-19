#!/usr/bin/env node
/* Checks data/menu-lookup.js before it's published. Run by the daily menu
   routine before every push, and by CI on every push and pull request.

     node scripts/check-menus.js [--base=<git ref>]

   The base is the published version to compare against (default
   origin/develop). Checks:
   - every entry is well formed (fields, dates, dish lists, choices);
   - entry names are unique;
   - a new or changed entry lists its sources;
   - an entry never loses more than half its dishes in one go, unless the
     published version already flagged the drop (pendingShrink) at least
     7 days earlier, so a half-loaded or broken menu page can't wipe a menu;
   - a changed menu file comes with a new service worker version, so
     open tabs pick it up.
   Exits 1 and lists every problem when anything fails. */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const MENU_FILE = 'data/menu-lookup.js';
const SW_FILE = 'service-worker.js';
const SHRINK_WAIT_DAYS = 7;
const KNOWN_FIELDS = new Set(['name', 'asOf', 'sections', 'dishes', 'source', 'renamed', 'none', 'seenAdded', 'pendingShrink', 'options', 'v', 'retire']);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const baseArg = process.argv.find((a) => a.startsWith('--base='));
const base = baseArg ? baseArg.slice('--base='.length) : (process.env.MENU_BASE || 'origin/develop');

function parseLookup(src, label) {
  try {
    return vm.runInNewContext(`${src}\n;MENU_LOOKUP`, {}, { filename: label });
  } catch (error) {
    return { error: `${label} doesn't load: ${error.message}` };
  }
}
function fromGit(ref, file) {
  try {
    return execFileSync('git', ['show', `${ref}:${file}`], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}
function swVersion(src) {
  const m = src && src.match(/CACHE_NAME = 'the-rounds-v(\d+)'/);
  return m ? Number(m[1]) : null;
}
function validDate(s) {
  if (typeof s !== 'string' || !DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
// Today in Chicago, where the app lives.
function today() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}
function nonEmptyStrings(list) {
  return Array.isArray(list) && list.length > 0 && list.every((d) => typeof d === 'string' && d.trim() === d && d.length > 0);
}
// Every dish an entry lists, lowercased.
function dishSet(entry) {
  if (!entry || entry.none) return new Set();
  const all = entry.sections ? Object.values(entry.sections).flat() : (entry.dishes || []);
  return new Set(all.map((d) => String(d).toLowerCase()));
}

function checkEntry(e, i, problems) {
  const where = typeof e?.name === 'string' && e.name ? `"${e.name}"` : `entry #${i + 1}`;
  const bad = (msg) => problems.push(`${where}: ${msg}`);
  if (!e || typeof e !== 'object' || Array.isArray(e)) return bad('is not an object');
  for (const k of Object.keys(e)) if (!KNOWN_FIELDS.has(k)) bad(`unknown field "${k}"`);
  if (typeof e.name !== 'string' || !e.name.trim() || e.name.trim() !== e.name) bad('needs a name (no leading/trailing spaces)');
  if (!validDate(e.asOf)) bad(`asOf must be a real date written YYYY-MM-DD (got ${JSON.stringify(e.asOf)})`);
  else if (e.asOf > today()) bad(`asOf ${e.asOf} is in the future`);

  const hasMenu = e.sections !== undefined || e.dishes !== undefined;
  if (e.none !== undefined && e.none !== true) bad('none must be true when present');
  if (e.none === true && hasMenu) bad('has none:true and also dishes');
  if (e.none !== true && !hasMenu) bad('needs sections (or none:true when the spot has no menu)');
  if (e.sections !== undefined && e.dishes !== undefined) bad('has both sections and dishes');
  if (e.sections !== undefined) {
    if (!e.sections || typeof e.sections !== 'object' || Array.isArray(e.sections) || !Object.keys(e.sections).length) bad('sections must be an object of section name → dishes');
    else for (const [sec, dishes] of Object.entries(e.sections)) {
      if (!sec.trim()) bad('has a section with no name');
      if (!nonEmptyStrings(dishes)) { bad(`section "${sec}" must be a non-empty list of dish names (no blank names or stray spaces)`); continue; }
      const seen = new Set();
      for (const d of dishes) {
        if (seen.has(d.toLowerCase())) bad(`section "${sec}" lists "${d}" twice`);
        seen.add(d.toLowerCase());
      }
    }
  }
  if (e.dishes !== undefined) {
    if (!nonEmptyStrings(e.dishes)) bad('dishes must be a non-empty list of dish names');
    else {
      const seen = new Set();
      for (const d of e.dishes) {
        if (seen.has(d.toLowerCase())) bad(`lists "${d}" twice`);
        seen.add(d.toLowerCase());
      }
    }
  }
  const dishes = dishSet(e);

  if (e.source !== undefined) {
    if (!Array.isArray(e.source) || !e.source.length || !e.source.every((u) => typeof u === 'string' && /^https?:\/\/\S+$/.test(u))) bad('source must be a list of http(s) links');
  }
  if (e.renamed !== undefined) {
    if (!e.renamed || typeof e.renamed !== 'object' || Array.isArray(e.renamed)) bad('renamed must map old dish name → new dish name');
    else for (const [from, to] of Object.entries(e.renamed)) {
      if (typeof to !== 'string' || !to) bad(`renamed "${from}" needs a new name`);
      else if (!dishes.has(to.toLowerCase())) bad(`renamed "${from}" → "${to}", but "${to}" isn't on the menu`);
      if (dishes.has(from.toLowerCase())) bad(`renamed "${from}" is still on the menu under its old name`);
    }
  }
  if (e.seenAdded !== undefined && !(Array.isArray(e.seenAdded) && e.seenAdded.every((d) => typeof d === 'string' && d))) bad('seenAdded must be a list of dish names');
  if (e.pendingShrink !== undefined && !validDate(e.pendingShrink)) bad('pendingShrink must be a date written YYYY-MM-DD');
  if (e.retire !== undefined && !(Array.isArray(e.retire) && e.retire.every((d) => typeof d === 'string'))) bad('retire must be a list of dish names');
  if (e.v !== undefined && !(Number.isInteger(e.v) && e.v > 0)) bad('v must be a positive whole number');
  if (e.options !== undefined) {
    if (!e.options || typeof e.options !== 'object' || Array.isArray(e.options)) bad('options must map dish → { choice group → choices }');
    else for (const [dish, groups] of Object.entries(e.options)) {
      if (!dishes.has(dish.toLowerCase())) bad(`options for "${dish}", which isn't on the menu`);
      if (!groups || typeof groups !== 'object' || Array.isArray(groups) || !Object.keys(groups).length) { bad(`options for "${dish}" must map choice group → choices`); continue; }
      for (const [group, choices] of Object.entries(groups)) {
        if (!group.trim()) bad(`options for "${dish}" has a group with no name`);
        if (!nonEmptyStrings(choices)) bad(`options for "${dish}" → "${group}" must be a non-empty list of choices`);
        else if (new Set(choices.map((c) => c.toLowerCase())).size !== choices.length) bad(`options for "${dish}" → "${group}" lists a choice twice`);
      }
    }
  }
}

function main() {
  const problems = [];
  const src = fs.readFileSync(path.join(ROOT, MENU_FILE), 'utf8');
  const current = parseLookup(src, MENU_FILE);
  if (current.error || !Array.isArray(current)) {
    console.error(current.error || `${MENU_FILE} must define MENU_LOOKUP as a list`);
    process.exit(1);
  }
  current.forEach((e, i) => checkEntry(e, i, problems));
  const byName = new Map();
  for (const e of current) {
    const key = String(e?.name || '').toLowerCase();
    if (byName.has(key)) problems.push(`"${e.name}" is listed twice`);
    byName.set(key, e);
  }

  const baseSrc = fromGit(base, MENU_FILE);
  if (baseSrc === null) {
    console.warn(`Couldn't read ${MENU_FILE} at ${base}; skipped the checks against the published version.`);
  } else if (baseSrc !== src) {
    const previous = parseLookup(baseSrc, `${base}:${MENU_FILE}`);
    const prevByName = new Map(Array.isArray(previous) ? previous.map((e) => [String(e.name).toLowerCase(), e]) : []);
    const now = today();
    // New or changed entries say where the menu came from.
    for (const e of current) {
      const before = prevByName.get(String(e.name).toLowerCase());
      if (before && JSON.stringify(before) === JSON.stringify(e)) continue;
      if (!Array.isArray(e.source) || !e.source.length) problems.push(`"${e.name}" is ${before ? 'changed' : 'new'} but has no source links`);
    }
    // No entry loses more than half its dishes at once without a waiting period.
    for (const [key, before] of prevByName) {
      const was = dishSet(before);
      if (!was.size) continue;
      const after = byName.get(key);
      const nowDishes = dishSet(after);
      const renamed = Object.fromEntries(Object.entries(after?.renamed || {}).map(([a, b]) => [a.toLowerCase(), b.toLowerCase()]));
      const lost = [...was].filter((d) => !nowDishes.has(d) && !nowDishes.has(renamed[d])).length;
      if (lost * 2 <= was.size) continue;
      const flagged = before.pendingShrink && validDate(before.pendingShrink) ? daysBetween(before.pendingShrink, now) : null;
      if (flagged !== null && flagged >= SHRINK_WAIT_DAYS) continue;
      problems.push(`"${before.name}" would lose ${lost} of ${was.size} dishes${after ? '' : ' (entry removed)'}. ` +
        (flagged === null
          ? `Publish pendingShrink:"${now}" on the current entry first, and apply the drop once it's ${SHRINK_WAIT_DAYS} days old and the menu still shows it.`
          : `Its pendingShrink is only ${flagged} day(s) old; wait until it's ${SHRINK_WAIT_DAYS}.`));
    }
    // A changed menu needs a new service worker version.
    const was = swVersion(fromGit(base, SW_FILE));
    const is = swVersion(fs.readFileSync(path.join(ROOT, SW_FILE), 'utf8'));
    if (is === null) problems.push(`${SW_FILE} has no CACHE_NAME 'the-rounds-vN'`);
    else if (was !== null && is <= was) problems.push(`${MENU_FILE} changed, so ${SW_FILE}'s CACHE_NAME must go above the-rounds-v${was} (it's v${is})`);
  }

  if (problems.length) {
    console.error(`Menu check failed (${problems.length} problem${problems.length === 1 ? '' : 's'}):`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log(`Menu check passed: ${current.length} entries${baseSrc !== null && baseSrc !== src ? `, compared with ${base}` : ''}.`);
}

main();
