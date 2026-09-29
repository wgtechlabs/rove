import { mountChat } from './chat.js';

const main = document.querySelector('#main');
const signout = document.querySelector('#signout');
let disposeChat;

async function api(path, body) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...(body === undefined
      ? {}
      : {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
  });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(
      data.message || 'This request could not be completed. Try again.',
    );
    error.status = response.status;
    throw error;
  }
  return data;
}

function show(content) {
  disposeChat?.();
  disposeChat = undefined;
  main.className = 'auth-layout';
  main.removeAttribute('aria-busy');
  main.innerHTML = content; // All templates are static; user values are assigned with textContent/value.
  main.querySelector('h1')?.focus();
}

const passwordFields = `
  <label for="password">Password</label>
  <input id="password" name="password" type="password" autocomplete="new-password" minlength="12" maxlength="128" required aria-describedby="password-hint">
  <p class="hint" id="password-hint">Use at least 12 characters. A password manager can help.</p>
  <label for="confirm">Confirm password</label>
  <input id="confirm" name="confirm" type="password" autocomplete="new-password" minlength="12" maxlength="128" required>`;

function bindForm(action) {
  const form = main.querySelector('form');
  const error = main.querySelector('[role="alert"]');
  const button = form.querySelector('[type="submit"]');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    error.textContent = '';
    const values = Object.fromEntries(new FormData(form));
    if ('confirm' in values && values.confirm !== values.password) {
      error.textContent =
        'The passwords do not match. Enter the same password in both fields.';
      form.querySelector('#confirm').focus();
      return;
    }
    const label = button.textContent;
    button.disabled = true;
    button.textContent = 'Please wait…';
    form.setAttribute('aria-busy', 'true');
    try {
      await action(values);
    } catch (failure) {
      error.textContent =
        failure instanceof TypeError
          ? 'Rove could not be reached. Check your connection and try again.'
          : failure.message;
      error.focus();
    } finally {
      button.disabled = false;
      button.textContent = label;
      form.removeAttribute('aria-busy');
    }
  });
}

function setup() {
  document.title = 'Set up Rove';
  show(`<section class="intro">
    <h1 tabindex="-1">Make Rove yours.</h1>
    <p>Start with an administrator account. This is your place to manage Rove and shape how it works with your company.</p>
    <ol class="steps"><li class="current" aria-current="step"><span>1</span>Create your account</li><li><span>2</span>Save your recovery key</li><li><span>3</span>Sign in to Rove</li></ol>
    <p class="small">Already deployed? Your setup secret is in the environment settings of your hosting service.</p>
  </section><section class="form-panel" aria-labelledby="form-title">
    <h2 id="form-title">Create administrator</h2><p class="description">First-time setup for this Rove instance.</p>
    <form>
      <label for="setupSecret">Setup secret</label><input id="setupSecret" name="setupSecret" type="password" autocomplete="off" maxlength="1024" required aria-describedby="setup-hint">
      <p class="hint" id="setup-hint">Enter the value of ROVE_SETUP_SECRET from your deployment.</p>
      <label for="name">Your name</label><input id="name" name="name" autocomplete="name" maxlength="80" required>
      <label for="email">Email address</label><input id="email" name="email" type="email" autocomplete="username" maxlength="254" required>
      ${passwordFields}
      <p role="alert" tabindex="-1" class="error"></p><button class="primary" type="submit">Create administrator</button>
    </form><p class="small footnote">Setup closes after this account is created. Public registration is disabled.</p>
  </section>`);
  bindForm(async (values) => {
    const result = await api('/api/setup', values);
    recoveryReceipt(result.recoveryKey, false);
  });
}

function login() {
  document.title = 'Sign in · Rove';
  signout.hidden = true;
  show(`<section class="intro"><h1 tabindex="-1">Welcome back.</h1><p>Sign in to your company’s Rove.</p></section>
    <section class="form-panel" aria-labelledby="form-title"><h2 id="form-title">Administrator sign-in</h2>
    <form><label for="email">Email address</label><input id="email" name="email" type="email" autocomplete="username" maxlength="254" required>
    <label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" maxlength="128" required>
    <p role="alert" tabindex="-1" class="error"></p><button class="primary" type="submit">Sign in</button></form>
    <button id="recover" class="text-button">Forgot your password?</button></section>`);
  main.querySelector('#recover').onclick = recovery;
  bindForm(async (values) => {
    await api('/api/auth/sign-in/email', values);
    await load();
  });
}

function recovery() {
  document.title = 'Recover account · Rove';
  show(`<section class="intro"><h1 tabindex="-1">Get back into Rove.</h1><p>Use the recovery key you saved when you created your administrator account.</p><p class="small">Your current sessions will be signed out, and you’ll receive a new recovery key.</p></section>
    <section class="form-panel" aria-labelledby="form-title"><h2 id="form-title">Reset your password</h2>
    <form><label for="recoveryKey">Recovery key</label><input id="recoveryKey" name="recoveryKey" type="password" autocomplete="off" maxlength="1024" required>
    ${passwordFields}<p role="alert" tabindex="-1" class="error"></p><button class="primary" type="submit">Reset password</button></form>
    <button id="back" class="text-button">Back to sign-in</button></section>`);
  main.querySelector('#back').onclick = login;
  bindForm(async (values) => {
    const result = await api('/api/recover', values);
    recoveryReceipt(result.recoveryKey, true);
  });
}

function recoveryReceipt(key, reset) {
  document.title = 'Save your recovery key · Rove';
  show(`<section class="intro"><h1 tabindex="-1">${reset ? 'Your password is reset.' : 'Your account is ready.'}</h1><p>One more thing before you sign in: save your recovery key somewhere safe.</p></section>
    <section class="form-panel" aria-labelledby="form-title"><h2 id="form-title">Save your recovery key</h2><p>This key can reset your administrator password. Store it in your password manager. It is only shown once.</p>
    <label for="saved-key">${reset ? 'New recovery key' : 'Recovery key'}</label><textarea id="saved-key" readonly rows="3" spellcheck="false"></textarea>
    <p class="hint">${reset ? 'Your previous recovery key no longer works.' : 'Keep this separate from your deployment’s setup secret.'}</p>
    <label class="checkbox"><input id="saved" type="checkbox">I have saved my recovery key</label>
    <button id="continue" class="primary" disabled>Continue to sign-in</button></section>`);
  main.querySelector('#saved-key').value = key;
  const button = main.querySelector('#continue');
  main.querySelector('#saved').onchange = (event) => {
    button.disabled = !event.target.checked;
  };
  button.onclick = login;
}

function dashboard(admin) {
  disposeChat?.();
  signout.hidden = false;
  disposeChat = mountChat(main, admin, api, login, signout);
}

signout.onclick = async () => {
  signout.disabled = true;
  try {
    await api('/api/auth/sign-out', {});
    login();
  } catch {
    const error = main.querySelector('[role="alert"]');
    error.textContent = 'Sign-out failed. Check your connection and try again.';
    error.focus();
  } finally {
    signout.disabled = false;
  }
};

async function load() {
  try {
    const state = await api('/api/setup');
    if (state.required) return setup();
    try {
      dashboard(await api('/api/admin/me'));
    } catch (error) {
      if (error.status === 401) login();
      else throw error;
    }
  } catch (error) {
    show(
      `<section class="intro"><h1 tabindex="-1">Rove couldn’t open.</h1><p role="alert" class="error"></p><button id="retry" class="secondary">Try again</button></section>`,
    );
    main.querySelector('[role="alert"]').textContent =
      error.status === 403
        ? 'This account does not have administrator access.'
        : 'Check your connection and try again.';
    signout.hidden = error.status !== 403;
    main.querySelector('#retry').onclick = load;
  }
}
load();
