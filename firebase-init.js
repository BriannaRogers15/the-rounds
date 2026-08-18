/* Firebase SDK setup — loaded as a module (see index.html). app.js and the
   data/*.js files it depends on are still classic scripts sharing one
   global scope (modules can't see another script's top-level `const`
   bindings like SEED_RESTAURANTS), so this attaches what's needed to
   `window.RoundsFirebase` instead of exporting via `import`. Once Phase 4
   removes the data/*.js dependency, app.js can move to `import` directly. */
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.17.1/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup,
  createUserWithEmailAndPassword, signInWithEmailAndPassword,
  sendPasswordResetEmail, onAuthStateChanged, signOut, updateProfile,
} from "https://www.gstatic.com/firebasejs/12.17.1/firebase-auth.js";
import {
  getFirestore, doc, setDoc, getDoc, addDoc, updateDoc, deleteDoc,
  collection, onSnapshot, serverTimestamp, arrayUnion, arrayRemove,
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
const googleProvider = new GoogleAuthProvider();

window.RoundsFirebase = {
  auth, db, googleProvider,
  signInWithPopup, createUserWithEmailAndPassword, signInWithEmailAndPassword,
  sendPasswordResetEmail, onAuthStateChanged, signOut, updateProfile,
  doc, setDoc, getDoc, addDoc, updateDoc, deleteDoc,
  collection, onSnapshot, serverTimestamp, arrayUnion, arrayRemove,
};
window.dispatchEvent(new Event('rounds-firebase-ready'));
