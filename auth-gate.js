/* Sign-in gate for The Rounds. Classic script (not a module) so it can run
   as soon as it's parsed rather than waiting on module deferral — it just
   waits for firebase-init.js's ready signal instead, since that module
   script may not have finished by the time this one runs.
   Phase 1 only: this doesn't touch app.js's data yet (still localStorage-
   backed) — it just gates the UI behind a real signed-in user and creates
   the users/{uid} profile doc. Phases 4+ wire the actual data layer to
   Firestore and replace this file's temporary "signed in as" chip with a
   real header treatment. */
(function(){
  function init(){
    const {
      auth, googleProvider, db,
      signInWithPopup, signInWithRedirect, getRedirectResult,
      createUserWithEmailAndPassword, signInWithEmailAndPassword,
      sendPasswordResetEmail, onAuthStateChanged, signOut, updateProfile,
      doc, setDoc, getDoc, serverTimestamp,
    } = window.RoundsFirebase;

    /* Popup and redirect each fail in a different, specific context — pick
       the one that actually works for the context this page is running in,
       rather than a single global choice:
       - Popup breaks inside an installed/standalone PWA (no reliable
         opener/opened-window relationship for the result to come back on).
         It works fine in a normal browser tab, desktop or mobile.
       - Redirect is the standard fix for standalone mode, but depends on
         Firebase correlating state across a full navigation to Google and
         back — Safari's cross-site tracking protection can interrupt that,
         especially testing over plain http://localhost. */
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches
      || window.navigator.standalone === true;

    // Only relevant in standalone mode — that's the only case that ever
    // initiates a redirect in the first place, so checking for a pending
    // result in normal-tab/popup mode is pure overhead that can surface
    // confusing, irrelevant errors (e.g. transient IndexedDB hiccups) on
    // every plain page load before anyone's clicked anything.
    if(isStandalone){
      getRedirectResult(auth).catch((err)=> showError(friendlyAuthError(err)));
    }

    let mode = 'signin'; // 'signin' | 'signup'

    function escapeHtml(s){
      const d = document.createElement('div');
      d.textContent = s;
      return d.innerHTML;
    }

    function showError(msg){
      const el = document.getElementById('authError');
      el.textContent = msg;
      el.style.display = '';
    }
    function clearError(){
      const el = document.getElementById('authError');
      el.style.display = 'none';
      el.textContent = '';
    }

    function setMode(next){
      mode = next;
      document.getElementById('authNameField').style.display = mode === 'signup' ? '' : 'none';
      document.getElementById('authSubmitBtn').textContent = mode === 'signup' ? 'Create Account' : 'Sign In';
      document.getElementById('authModeToggle').textContent = mode === 'signup'
        ? 'Already have an account? Sign in'
        : 'New here? Create an account';
      clearError();
    }

    document.getElementById('authModeToggle').addEventListener('click', (e)=>{
      e.preventDefault();
      setMode(mode === 'signup' ? 'signin' : 'signup');
    });

    document.getElementById('googleSignInBtn').addEventListener('click', async ()=>{
      clearError();
      try{
        if(isStandalone) await signInWithRedirect(auth, googleProvider);
        else await signInWithPopup(auth, googleProvider);
      }
      catch(err){ showError(friendlyAuthError(err)); }
    });

    document.getElementById('authSubmitBtn').addEventListener('click', async ()=>{
      clearError();
      const email = document.getElementById('authEmail').value.trim();
      const password = document.getElementById('authPassword').value;
      const name = document.getElementById('authName').value.trim();
      if(!email || !password){ showError('Enter an email and password.'); return; }
      try{
        if(mode === 'signup'){
          if(!name){ showError('Enter a name — it\'s shown on your reviews.'); return; }
          const cred = await createUserWithEmailAndPassword(auth, email, password);
          await updateProfile(cred.user, { displayName: name });
          // onAuthStateChanged already fired (with the pre-update user) by
          // the time updateProfile resolves, so the chip it rendered is
          // stale — cred.user is the same object updateProfile just
          // mutated in place, so re-render with it directly.
          renderSignedInChip(cred.user);
        } else {
          await signInWithEmailAndPassword(auth, email, password);
        }
      }catch(err){ showError(friendlyAuthError(err)); }
    });

    document.getElementById('authForgotLink').addEventListener('click', async (e)=>{
      e.preventDefault();
      clearError();
      const email = document.getElementById('authEmail').value.trim();
      if(!email){ showError('Enter your email above, then click "Forgot password?" again.'); return; }
      try{
        await sendPasswordResetEmail(auth, email);
        showError('Password reset email sent — check your inbox.');
      }catch(err){ showError(friendlyAuthError(err)); }
    });

    function friendlyAuthError(err){
      // Log the real error every time this runs — the on-screen message is
      // deliberately simplified, but that must never be the only place the
      // failure detail exists. Silently swallowing the real error here is
      // exactly what made this bug hard to diagnose earlier.
      console.error('Auth/Firestore error:', err && err.name, err && err.code, err && err.message, err);
      const map = {
        'auth/invalid-email': 'That email address looks off.',
        'auth/user-not-found': 'No account with that email — try creating one.',
        'auth/wrong-password': 'Wrong password.',
        'auth/invalid-credential': 'Email or password is wrong.',
        'auth/email-already-in-use': 'That email already has an account — try signing in instead.',
        'auth/weak-password': 'Password needs to be at least 6 characters.',
        'auth/popup-closed-by-user': 'Sign-in was closed before finishing.',
      };
      return map[err.code] || (err.message || 'Something went wrong.');
    }

    let signedInChip = null;
    function renderSignedInChip(user){
      if(signedInChip) signedInChip.remove();
      signedInChip = document.createElement('div');
      signedInChip.className = 'signed-in-chip';
      signedInChip.innerHTML = `<span>Signed in as ${escapeHtml(user.displayName || user.email)}</span><button id="authSignOutBtn">Sign out</button>`;
      document.body.appendChild(signedInChip);
      document.getElementById('authSignOutBtn').addEventListener('click', ()=> signOut(auth));
    }

    onAuthStateChanged(auth, async (user)=>{
      const loading = document.getElementById('authLoading');
      const gate = document.getElementById('authGate');
      const wrap = document.querySelector('.wrap');
      if(loading) loading.style.display = 'none';

      if(user){
        gate.style.display = 'none';
        if(wrap) wrap.style.display = '';
        renderSignedInChip(user);
        try{
          const userRef = doc(db, 'users', user.uid);
          const existing = await getDoc(userRef);
          const payload = {
            displayName: user.displayName || user.email,
            email: user.email,
            photoURL: user.photoURL || null,
          };
          if(!existing.exists()) payload.createdAt = serverTimestamp();
          await setDoc(userRef, payload, { merge: true });
        }catch(err){ console.warn('Could not write users/{uid} doc', err); }
      } else {
        gate.style.display = '';
        if(wrap) wrap.style.display = 'none';
        if(signedInChip){ signedInChip.remove(); signedInChip = null; }
      }
    });
  }

  if(window.RoundsFirebase) init();
  else window.addEventListener('rounds-firebase-ready', init, { once: true });
})();
