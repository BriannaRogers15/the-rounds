/* Firebase SDK setup — loaded as a module (see index.html). app.js and the
   data/*.js files it depends on are still classic scripts sharing one
   global scope (modules can't see another script's top-level `const`
   bindings like SEED_RESTAURANTS), so this attaches what's needed to
   `window.RoundsFirebase` instead of exporting via `import`. Once Phase 4
   removes the data/*.js dependency, app.js can move to `import` directly. */
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.17.1/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult,
  createUserWithEmailAndPassword, signInWithEmailAndPassword,
  sendPasswordResetEmail, onAuthStateChanged, signOut, updateProfile,
  setPersistence, browserLocalPersistence, browserSessionPersistence,
  connectAuthEmulator,
} from "https://www.gstatic.com/firebasejs/12.17.1/firebase-auth.js";
import {
  getFirestore, doc, setDoc, getDoc, addDoc, updateDoc, deleteDoc,
  collection, getDocs, onSnapshot, writeBatch, serverTimestamp, arrayUnion, arrayRemove,
  connectFirestoreEmulator,
} from "https://www.gstatic.com/firebasejs/12.17.1/firebase-firestore.js";

// Public web-app config — not a secret, access control is entirely the
// Firestore security rules' job, not this config being hidden.
const firebaseConfig = {
  apiKey: "AIzaSyBJXlf9VL_mZk1F1bn546tENb5jA-7hnDQ",
  authDomain: "the-rounds-fc02a.firebaseapp.com",
  projectId: "the-rounds-fc02a",
  storageBucket: "the-rounds-fc02a.firebasestorage.app",
  messagingSenderId: "1019683557135",
  appId: "1:1019683557135:web:b93f73c71c4cfc60c2787a",
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// Test-only seam: window.__ROUNDS_TEST__ is never set in production (it's
// assigned via Playwright's addInitScript, which runs before this module
// evaluates), so this branch is dead code outside the test suite — prod
// behavior is unchanged. Points at the local Firebase Emulator Suite
// instead of the real the-rounds-fc02a project so tests never touch real
// user data and don't depend on live network/Google availability.
if(window.__ROUNDS_TEST__?.useEmulators){
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFirestoreEmulator(db, '127.0.0.1', 8080);
}

const googleProvider = new GoogleAuthProvider();
const OWNER_UID = 'pyrbuH8HHGQ2wus3OQvkMRq2Qol1';
let keepSignedIn = true;
try{ keepSignedIn = localStorage.getItem('rounds:keep-signed-in') !== 'false'; }
catch(_error){}
const authStateReady = setPersistence(auth, keepSignedIn ? browserLocalPersistence : browserSessionPersistence)
  .catch((error)=> console.error('Could not set default auth persistence:', error))
  .then(()=> new Promise((resolve)=> onAuthStateChanged(auth, resolve)));
// What Firestore is known to hold, per doc id, as a serialized snapshot
// (stableJson string) — never a live object. syncSharedLedger diffs the
// app's records against this to decide what to write. It used to hold the
// very objects handed to the app (and shallow copies sharing their nested
// arrays), so any in-place edit — categories.push(), menu.push(), r.town =
// ... — silently changed the baseline too, the diff saw no change, and the
// edit never reached Firestore. Strings can't be mutated out from under it.
const ledgerCache = { restaurants: new Map(), visits: new Map() };
let ledgerWriteQueue = Promise.resolve();

// Default to the safer local storage persistence, but let each sign-in flow
// choose between a session-only or remember-me experience explicitly.
const applyAuthPersistence = async (rememberMe = true) => {
  const persistence = rememberMe ? browserLocalPersistence : browserSessionPersistence;
  await setPersistence(auth, persistence);
};

function snapshotItems(snapshot, kind){
  const items = snapshot.docs.map((entry)=> ({ ...entry.data(), id: entry.id }));
  ledgerCache[kind] = new Map(items.map((item)=> [item.id, stableJson(item)]));
  return items;
}

function watchSharedLedger(){
  let readyResolve;
  let readyReject;
  let onUpdate = null;
  const initial = { restaurants: [], visits: [] };
  const firstSnapshots = new Set();
  const ready = new Promise((resolve, reject)=> { readyResolve = resolve; readyReject = reject; });
  const handleError = (kind, error)=>{
    console.error(`Could not read shared ${kind}:`, error);
    if(firstSnapshots.size < 2) readyReject(error);
  };
  const publish = (kind, items)=> {
    initial[kind] = items;
    if(firstSnapshots.size === 2){
      if(onUpdate) onUpdate({ [kind]: items });
      return;
    }
    firstSnapshots.add(kind);
    if(firstSnapshots.size === 2) readyResolve({ ...initial });
  };
  const stopRestaurants = onSnapshot(collection(db, 'restaurants'), (snapshot)=>
    publish('restaurants', snapshotItems(snapshot, 'restaurants')),
    (error)=> handleError('restaurants', error));
  const stopVisits = onSnapshot(collection(db, 'visits'), (snapshot)=>
    publish('visits', snapshotItems(snapshot, 'visits')),
    (error)=> handleError('visits', error));

  return {
    ready,
    subscribe(callback){
      onUpdate = callback;
      // Latest published items (publish() keeps `initial` current). The
      // app owns and mutates these freely — the diff baseline lives
      // separately in ledgerCache as strings.
      callback({ restaurants: initial.restaurants, visits: initial.visits });
    },
    unsubscribe(){ stopRestaurants(); stopVisits(); },
  };
}

function stableJson(value){
  if(Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if(value && typeof value === 'object'){
    return `{${Object.keys(value).sort().map((key)=> `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function syncSharedLedger(kind, records){
  const write = ledgerWriteQueue.catch(()=>{}).then(async ()=>{
    const user = auth.currentUser;
    if(!user) throw new Error('Sign in before saving shared ledger changes.');
    const previous = ledgerCache[kind];
    // Deep-copied via JSON so a write in flight isn't affected by the app
    // mutating the same record before commit().
    const next = new Map(records.map((record)=> [record.id, JSON.parse(JSON.stringify(record))]));
    const operations = [];

    next.forEach((record, id)=>{
      const json = stableJson(record);
      if(previous.get(id) !== json){
        operations.push({ type: 'set', id, record, json });
      }
    });
    previous.forEach((record, id)=>{
      if(!next.has(id)) operations.push({ type: 'delete', id });
    });

    for(let offset = 0; offset < operations.length; offset += 450){
      const batch = writeBatch(db);
      const slice = operations.slice(offset, offset + 450);
      slice.forEach((operation)=>{
        const ref = doc(db, kind, operation.id);
        if(operation.type === 'delete') batch.delete(ref);
        else batch.set(ref, operation.record, { merge: true });
      });
      await batch.commit();
      slice.forEach((operation)=>{
        if(operation.type === 'delete') previous.delete(operation.id);
        else previous.set(operation.id, operation.json);
      });
    }
  });
  ledgerWriteQueue = write.catch(()=>{});
  return write;
}

window.RoundsFirebase = {
  auth, db, googleProvider,
  signInWithPopup, signInWithRedirect, getRedirectResult,
  createUserWithEmailAndPassword, signInWithEmailAndPassword,
  sendPasswordResetEmail, onAuthStateChanged, signOut, updateProfile,
  setPersistence, browserLocalPersistence, browserSessionPersistence,
  applyAuthPersistence,
  authStateReady,
  isOwner: ()=> auth.currentUser?.uid === OWNER_UID,
  watchSharedLedger, syncSharedLedger,
  doc, setDoc, getDoc, addDoc, updateDoc, deleteDoc,
  collection, getDocs, onSnapshot, serverTimestamp, arrayUnion, arrayRemove,
};
window.dispatchEvent(new Event('rounds-firebase-ready'));
