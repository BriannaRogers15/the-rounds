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
      doc, setDoc, getDoc, serverTimestamp, writeBatch,
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
    const rememberMe = document.getElementById('rememberMe');
    const passwordInput = document.getElementById('authPassword');
    try{
      rememberMe.checked = localStorage.getItem('rounds:keep-signed-in') !== 'false';
    }catch(_error){}
    rememberMe.addEventListener('change', ()=>{
      try{ localStorage.setItem('rounds:keep-signed-in', String(rememberMe.checked)); }
      catch(_error){}
    });

    document.getElementById('togglePassword').addEventListener('click', (event)=>{
      const button = event.currentTarget;
      const showing = passwordInput.type === 'password';
      passwordInput.type = showing ? 'text' : 'password';
      button.textContent = showing ? 'Hide' : 'Show';
      button.setAttribute('aria-label', showing ? 'Hide password' : 'Show password');
      button.setAttribute('aria-pressed', String(showing));
    });

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

    async function applyChosenPersistence(){
      const keepSignedIn = document.getElementById('rememberMe')?.checked ?? true;
      await window.RoundsFirebase.applyAuthPersistence(keepSignedIn);
    }

    function enterGuestMode(){
      window.roundsGuestMode = true;
      const gate = document.getElementById('authGate');
      const wrap = document.querySelector('.wrap');
      if(gate) gate.style.display = 'none';
      if(wrap) wrap.style.display = '';
      document.getElementById('guestNotice').hidden = false;
      document.body.classList.add('guest-mode');
      clearError();
      window.dispatchEvent(new Event('rounds-access-changed'));
    }

    window.showRoundsAuthGate = ()=>{
      window.roundsGuestMode = false;
      document.getElementById('authGate').style.display = '';
      document.querySelector('.wrap').style.display = 'none';
      document.getElementById('guestNotice').hidden = true;
      document.body.classList.remove('guest-mode');
      window.dispatchEvent(new Event('rounds-access-changed'));
    };

    function setMode(next){
      mode = next;
      document.getElementById('authNameField').style.display = mode === 'signup' ? '' : 'none';
      document.getElementById('authSubmitBtn').textContent = mode === 'signup' ? 'Create account' : 'Sign in';
      setUsernameStatus('authNameStatus', '');
      document.getElementById('authModeToggle').textContent = mode === 'signup'
        ? 'Have an account? Sign in'
        : 'Create an account';
      passwordInput.autocomplete = mode === 'signup' ? 'new-password' : 'current-password';
      clearError();
    }

    document.getElementById('authModeToggle').addEventListener('click', (e)=>{
      e.preventDefault();
      setMode(mode === 'signup' ? 'signin' : 'signup');
    });

    document.getElementById('googleSignInBtn').addEventListener('click', async ()=>{
      clearError();
      try{
        await applyChosenPersistence();
        pendingMethod = 'google.com';
        if(isStandalone) await signInWithRedirect(auth, googleProvider);
        else await signInWithPopup(auth, googleProvider);
      }
      catch(err){ showError(friendlyAuthError(err)); }
    });

    document.getElementById('authGuestLink').addEventListener('click', (e)=>{
      e.preventDefault();
      enterGuestMode();
    });
    document.getElementById('guestSignInBtn').addEventListener('click', ()=> window.showRoundsAuthGate());

    document.getElementById('authSubmitBtn').addEventListener('click', async ()=>{
      clearError();
      const email = document.getElementById('authEmail').value.trim();
      const password = passwordInput.value;
      const username = document.getElementById('authName').value.trim();
      const emailInput = document.getElementById('authEmail');
      if(mode === 'signup'){
        const problem = validateUsername(username);
        if(problem){ showError(problem); return; }
      }
      if(!email || !emailInput.validity.valid){ showError('Enter a valid email address.'); return; }
      if(!password){ showError('Enter your password.'); return; }
      try{
        await applyChosenPersistence();
        if(mode === 'signup'){
          if(!(await isUsernameFree(username))){ showError(`"${username}" is taken — try another.`); return; }
          // The account exists first; reserving the username needs it. If
          // someone grabs the name in between, the username step catches it.
          signupUsername = username;
          pendingMethod = 'password';
          await createUserWithEmailAndPassword(auth, email, password);
        } else {
          pendingMethod = 'password';
          await signInWithEmailAndPassword(auth, email, password);
        }
      }catch(err){ pendingMethod = null; signupUsername = null; showError(friendlyAuthError(err)); }
    });
    passwordInput.addEventListener('keydown', (event)=>{
      if(event.key === 'Enter') document.getElementById('authSubmitBtn').click();
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
        'auth/email-already-in-use': 'That email already has an account — sign in instead (or use Continue with Google if that\'s how it was made).',
        'auth/account-exists-with-different-credential': 'That email already has an account that signs in with its password.',
        'auth/weak-password': 'Password needs to be at least 6 characters.',
        'auth/popup-closed-by-user': 'Sign-in was closed before finishing.',
      };
      return map[err.code] || (err.message || 'Something went wrong.');
    }

    /* ---------- Accounts: username (public) and display name (private) ----------
       Every account has a username: unique, shown on its reviews, reserved
       in usernames/{lowercased} so the database itself refuses a duplicate.
       The display name is private (only the account sees it, in the pill
       and on Profile) and starts out as the username. */
    const USERNAME_RE = /^[A-Za-z0-9_.]{3,20}$/;
    // Usernames are public, so a short list of words is refused outright
    // (firestore.rules refuses the same list).
    const BLOCKED_USERNAME_PARTS = ['fuck', 'shit', 'bitch', 'cunt', 'nigg', 'fag', 'whore', 'slut', 'rape', 'nazi', 'hitler', 'retard', 'pussy', 'cock', 'dick', 'porn'];
    const RESERVED_USERNAMES = ['admin', 'owner', 'moderator', 'support', 'therounds', 'rounds', 'guest'];
    function validateUsername(raw){
      const name = String(raw || '').trim();
      if(!name) return 'Pick a username — it\'s shown on your reviews.';
      if(!USERNAME_RE.test(name)) return 'Usernames are 3–20 letters, numbers, _ or . (no spaces).';
      const flat = name.toLowerCase().replace(/[._]/g, '');
      if(RESERVED_USERNAMES.includes(flat) || BLOCKED_USERNAME_PARTS.some(w => flat.includes(w))) return 'That username isn\'t allowed — try another.';
      return null;
    }
    async function isUsernameFree(name){
      const snap = await getDoc(doc(db, 'usernames', name.toLowerCase()));
      return !snap.exists() || snap.data().uid === auth.currentUser?.uid;
    }
    const account = { profile: null, displayName: '', signInMethod: null };
    window.RoundsAccount = {
      get profile(){ return account.profile; },
      get displayName(){ return account.displayName; },
      get signInMethod(){ return account.signInMethod; },
      validateUsername, isUsernameFree,
      claimUsername: (name)=> claimUsername(name),
      setDisplayName: (name)=> window.setRoundsDisplayName(name),
    };
    /* One atomic write: the profile's username, the new reservation, and
       releasing the old one. If the name was just taken, the database
       refuses the whole write. */
    async function claimUsername(raw){
      const user = auth.currentUser;
      if(!user) throw new Error('Not signed in.');
      const username = String(raw || '').trim();
      const problem = validateUsername(username);
      if(problem) throw new Error(problem);
      const key = username.toLowerCase();
      const current = account.profile?.username;
      const batch = writeBatch(db);
      batch.set(doc(db, 'profiles', user.uid), { username });
      batch.set(doc(db, 'usernames', key), { uid: user.uid, username });
      if(current && current.toLowerCase() !== key) batch.delete(doc(db, 'usernames', current.toLowerCase()));
      try{ await batch.commit(); }
      catch(err){
        if(err && err.code === 'permission-denied') throw new Error(`"${username}" is taken — try another.`);
        throw err;
      }
      account.profile = { username };
      window.dispatchEvent(new CustomEvent('rounds-username-changed', { detail: { uid: user.uid, username } }));
      return username;
    }

    /* The private display name: the Firebase profile (so it follows the
       account) and users/{uid}, which only the account itself can read. */
    const MAX_NAME_LENGTH = 80;
    window.setRoundsDisplayName = async (rawName)=>{
      const user = auth.currentUser;
      const name = String(rawName || '').trim();
      if(!user) throw new Error('Not signed in.');
      if(!name) throw new Error('Enter a name.');
      if(name.length > MAX_NAME_LENGTH) throw new Error(`Keep it under ${MAX_NAME_LENGTH} characters.`);
      await updateProfile(user, { displayName: name });
      await setDoc(doc(db, 'users', user.uid), { displayName: name }, { merge: true });
      account.displayName = name;
      renderSignedInChip();
      window.dispatchEvent(new CustomEvent('rounds-display-name-changed', { detail: { uid: user.uid, name } }));
      return name;
    };

    function setUsernameStatus(id, text, kind){
      const el = document.getElementById(id);
      if(!el) return;
      el.textContent = text;
      el.dataset.kind = kind || '';
    }
    /* Live "available / taken" under a username box. */
    function wireUsernameCheck(inputId, statusId){
      const input = document.getElementById(inputId);
      let t = null, seq = 0;
      input.addEventListener('input', ()=>{
        clearTimeout(t);
        const name = input.value.trim();
        if(!name){ setUsernameStatus(statusId, ''); return; }
        const problem = validateUsername(name);
        if(problem){ setUsernameStatus(statusId, problem, 'bad'); return; }
        const mine = ++seq;
        setUsernameStatus(statusId, 'Checking…');
        t = setTimeout(async ()=>{
          try{
            const free = await isUsernameFree(name);
            if(mine !== seq) return;
            setUsernameStatus(statusId, free ? `${name} is available` : `${name} is taken`, free ? 'good' : 'bad');
          }catch(_e){ if(mine === seq) setUsernameStatus(statusId, ''); }
        }, 300);
      });
    }
    wireUsernameCheck('authName', 'authNameStatus');
    wireUsernameCheck('usernameInput', 'usernameStatus');

    let signedInChip = null;
    function renderSignedInChip(){
      const user = auth.currentUser;
      if(!user) return;
      if(signedInChip) signedInChip.remove();
      const name = account.displayName || account.profile?.username || user.email;
      signedInChip = document.createElement('div');
      signedInChip.className = 'signed-in-chip';
      // The name opens Profile (username, display name, account, visits).
      signedInChip.innerHTML = `<span class="chip-label">Signed in as</span><a href="#v=profile" id="chipProfileLink" class="chip-name" aria-label="Your profile (${escapeHtml(name)})"><span class="chip-name-text">${escapeHtml(name)}</span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/></svg></a><button type="button" id="authSignOutBtn">Sign out</button>`;
      (document.getElementById('accountSlot') || document.body).appendChild(signedInChip);
      document.getElementById('authSignOutBtn').addEventListener('click', ()=> signOut(auth));
    }

    // Which way the current sign-in started ('password' | 'google.com'),
    // and the username typed on the sign-up form, if any.
    let pendingMethod = null;
    let signupUsername = null;
    const methodLabel = (m)=> m === 'google.com' ? 'Continue with Google' : 'your email and password';

    function showApp(){
      const gate = document.getElementById('authGate');
      const wrap = document.querySelector('.wrap');
      document.getElementById('usernameGate').style.display = 'none';
      gate.style.display = 'none';
      if(wrap) wrap.style.display = '';
      window.dispatchEvent(new Event('rounds-access-changed'));
      renderSignedInChip();
      // Sign-in bookkeeping is done. app.js waits for this before
      // reloading for the owner's startup.
      window.dispatchEvent(new Event('rounds-signed-in'));
    }
    /* Every account picks a username before using the app: sign-ups whose
       name was grabbed in the meantime, first Google sign-ins, and accounts
       from before usernames existed. */
    function showUsernameGate(suggestion){
      document.getElementById('authGate').style.display = 'none';
      const wrap = document.querySelector('.wrap');
      if(wrap) wrap.style.display = 'none';
      const gateEl = document.getElementById('usernameGate');
      gateEl.style.display = '';
      const input = document.getElementById('usernameInput');
      if(suggestion && !input.value) input.value = suggestion;
      input.dispatchEvent(new Event('input'));
      input.focus();
    }
    document.getElementById('usernameSave').addEventListener('click', async ()=>{
      const input = document.getElementById('usernameInput');
      const errEl = document.getElementById('usernameError');
      errEl.style.display = 'none';
      try{
        const username = await claimUsername(input.value);
        // The display name starts out as the username (private; change it
        // any time on Profile).
        await window.setRoundsDisplayName(username);
        showApp();
      }catch(err){
        console.error('Could not save username:', err);
        errEl.textContent = err.message || 'Could not save that — try again.';
        errEl.style.display = '';
      }
    });
    document.getElementById('usernameInput').addEventListener('keydown', (e)=>{ if(e.key === 'Enter') document.getElementById('usernameSave').click(); });
    document.getElementById('usernameSignOut').addEventListener('click', (e)=>{ e.preventDefault(); signOut(auth); });

    onAuthStateChanged(auth, async (user)=>{
      const loading = document.getElementById('authLoading');
      const gate = document.getElementById('authGate');
      const wrap = document.querySelector('.wrap');
      if(loading) loading.style.display = 'none';

      if(user){
        window.roundsGuestMode = false;
        document.body.classList.remove('guest-mode');
        document.getElementById('guestNotice').hidden = true;
        const method = pendingMethod;
        pendingMethod = null;
        // Checking the account's username takes a moment; say so rather
        // than show a blank page.
        gate.style.display = 'none';
        if(wrap) wrap.style.display = 'none';
        if(loading){ loading.textContent = 'Signing you in…'; loading.style.display = ''; }
        let userDoc = null, profileDoc = null;
        try{
          [userDoc, profileDoc] = await Promise.all([getDoc(doc(db, 'users', user.uid)), getDoc(doc(db, 'profiles', user.uid))]);
        }catch(err){ console.warn('Could not read the account records', err); }
        const data = userDoc && userDoc.exists() ? userDoc.data() : {};
        // One way in per email: an account made with a password signs in
        // with its password, a Google account with Google.
        const createdWith = data.signInMethod || null;
        if(method && createdWith && method !== createdWith && user.providerData.some(p => p.providerId === createdWith)){
          await signOut(auth);
          if(loading) loading.style.display = 'none';
          gate.style.display = '';
          if(wrap) wrap.style.display = 'none';
          showError(`This email signs in with ${methodLabel(createdWith)}.`);
          return;
        }
        if(loading) loading.style.display = 'none';
        account.signInMethod = createdWith || method || user.providerData[0]?.providerId || null;
        account.profile = profileDoc && profileDoc.exists() ? profileDoc.data() : null;
        account.displayName = data.displayName || user.displayName || '';
        try{
          const payload = { email: user.email, photoURL: null };
          if(!userDoc || !userDoc.exists()) payload.createdAt = serverTimestamp();
          if(!createdWith && account.signInMethod) payload.signInMethod = account.signInMethod;
          await setDoc(doc(db, 'users', user.uid), payload, { merge: true });
        }catch(err){ console.warn('Could not write users/{uid} doc', err); }

        if(account.profile && account.profile.username){
          showApp();
          return;
        }
        // A fresh sign-up reserves the username it typed; if that fails
        // (taken meanwhile) — or there's none yet — ask for one.
        if(signupUsername){
          const wanted = signupUsername;
          signupUsername = null;
          try{
            await claimUsername(wanted);
            await window.setRoundsDisplayName(wanted);
            showApp();
            return;
          }catch(err){
            document.getElementById('usernameError').textContent = err.message;
            document.getElementById('usernameError').style.display = '';
          }
        }
        const suggestion = (account.displayName || '').replace(/[^A-Za-z0-9_.]/g, '').slice(0, 20);
        showUsernameGate(suggestion);
      } else if(window.roundsGuestMode){
        document.getElementById('usernameGate').style.display = 'none';
        gate.style.display = 'none';
        if(wrap) wrap.style.display = '';
        document.getElementById('guestNotice').hidden = false;
        document.body.classList.add('guest-mode');
        account.profile = null; account.displayName = '';
        window.dispatchEvent(new Event('rounds-access-changed'));
        if(signedInChip){ signedInChip.remove(); signedInChip = null; }
      } else {
        document.getElementById('usernameGate').style.display = 'none';
        document.body.classList.remove('guest-mode');
        document.getElementById('guestNotice').hidden = true;
        gate.style.display = '';
        if(wrap) wrap.style.display = 'none';
        account.profile = null; account.displayName = '';
        window.dispatchEvent(new Event('rounds-access-changed'));
        if(signedInChip){ signedInChip.remove(); signedInChip = null; }
      }
    });
  }

  if(window.RoundsFirebase) init();
  else window.addEventListener('rounds-firebase-ready', init, { once: true });
})();
