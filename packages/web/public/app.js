/**
 * CF Session Hub dashboard.
 *
 * A thin client over the core service's REST API: it renders entries, drives
 * the SSO passcode modal and keeps itself up to date over the SSE stream.
 * It never sees a token — the API only ever reports expiry timestamps.
 */

const entriesEl = document.getElementById('entries');
const emptyEl = document.getElementById('empty-state');
const rootEl = document.getElementById('root-path');
const streamEl = document.getElementById('stream-state');
const toastEl = document.getElementById('toast');

const dialog = document.getElementById('login-dialog');
const loginTitle = document.getElementById('login-title');
const loginMessage = document.getElementById('login-message');
const loginError = document.getElementById('login-error');
const passcodeInput = document.getElementById('passcode-input');
const passcodeLink = document.getElementById('passcode-url');

/** id -> entry, the dashboard's view of the world. */
const entries = new Map();
let loginTarget = null;

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    // Only declare a JSON body when there actually is one.
    headers: options.body ? { 'content-type': 'application/json' } : {},
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
  return payload;
}

function toast(message) {
  toastEl.textContent = message;
  toastEl.dataset.visible = 'true';
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    toastEl.dataset.visible = 'false';
  }, 2400);
}

async function copy(text, what) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${what} copied`);
  } catch {
    // Clipboard access can be refused; fall back to a selectable prompt.
    window.prompt(`Copy ${what}:`, text);
  }
}

function countdown(entry) {
  if (!entry.expiresAt) return 'no token';
  const seconds = Math.round((new Date(entry.expiresAt).getTime() - Date.now()) / 1000);
  if (seconds <= 0) return 'expired';
  if (seconds < 90) return `expires in ${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `expires in ${minutes}m`;
  return `expires in ${Math.round(minutes / 60)}h`;
}

function render() {
  const list = [...entries.values()].sort((a, b) => a.label.localeCompare(b.label));
  emptyEl.hidden = list.length > 0;
  if (list.length === 0) {
    emptyEl.textContent = 'No CF home directories yet. Add one below.';
  }

  const existing = new Map([...entriesEl.querySelectorAll('.entry')].map((el) => [el.dataset.id, el]));
  for (const [id, el] of existing) {
    if (!entries.has(id)) el.remove();
  }

  let previous = null;
  for (const entry of list) {
    let el = existing.get(entry.id);
    if (!el) {
      el = buildCard(entry.id);
      entriesEl.appendChild(el);
    }
    updateCard(el, entry);
    if (previous && previous.nextElementSibling !== el) {
      previous.after(el);
    }
    previous = el;
  }
}

function buildCard(id) {
  const el = document.createElement('article');
  el.className = 'entry';
  el.dataset.id = id;
  el.innerHTML = `
    <div class="entry-head">
      <span class="entry-label"></span>
      <span class="entry-id"></span>
      <span class="badge"></span>
      <span class="countdown"></span>
    </div>
    <div class="meta">
      <span>API <code data-field="api"></code></span>
      <span>Org <code data-field="org"></code></span>
      <span>Space <code data-field="space"></code></span>
    </div>
    <p class="entry-error" hidden></p>
    <div class="actions">
      <button data-action="login">Log in</button>
      <button data-action="verify" class="secondary">Verify</button>
      <button data-action="copy-home" class="secondary">Copy CF_HOME</button>
      <button data-action="copy-snippet" class="secondary">Copy Claude Code snippet</button>
      <button data-action="logout" class="secondary">Log out</button>
      <label class="keepalive">
        <input type="checkbox" data-action="keepalive" /> keep alive
      </label>
    </div>
  `;
  el.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action]');
    if (button) void onAction(button, id);
  });
  el.querySelector('input[data-action="keepalive"]').addEventListener('change', (event) => {
    void setKeepAlive(id, event.target.checked);
  });
  return el;
}

function updateCard(el, entry) {
  el.querySelector('.entry-label').textContent = entry.label;
  el.querySelector('.entry-id').textContent = entry.id === entry.label ? '' : entry.id;
  const badge = el.querySelector('.badge');
  badge.textContent = entry.status;
  badge.dataset.status = entry.status;
  el.querySelector('.countdown').textContent = countdown(entry);
  el.querySelector('[data-field="api"]').textContent = entry.api ?? '—';
  el.querySelector('[data-field="org"]').textContent = entry.org ?? entry.defaultOrg ?? '—';
  el.querySelector('[data-field="space"]').textContent = entry.space ?? entry.defaultSpace ?? '—';

  const error = el.querySelector('.entry-error');
  error.textContent = entry.lastError ?? '';
  error.hidden = !entry.lastError;

  const keepAlive = el.querySelector('input[data-action="keepalive"]');
  if (document.activeElement !== keepAlive) keepAlive.checked = entry.keepAlive;

  const loginButton = el.querySelector('button[data-action="login"]');
  loginButton.textContent = entry.status === 'active' ? 'Re-login' : 'Log in';
  loginButton.disabled = entry.loginState === 'logging_in';
}

async function onAction(button, id) {
  const entry = entries.get(id);
  if (!entry) return;
  const action = button.dataset.action;
  button.disabled = true;
  try {
    if (action === 'login') {
      await openLogin(entry);
    } else if (action === 'verify') {
      const result = await api(`/api/entries/${encodeURIComponent(id)}/verify`, { method: 'POST' });
      toast(result.ok ? `${entry.label} is usable` : `${entry.label}: ${result.error}`);
    } else if (action === 'logout') {
      await api(`/api/entries/${encodeURIComponent(id)}/logout`, { method: 'POST' });
      toast(`${entry.label} logged out`);
    } else if (action === 'copy-home') {
      const handoff = await api(`/api/entries/${encodeURIComponent(id)}/handoff`);
      await copy(handoff.exportLine, 'CF_HOME export');
    } else if (action === 'copy-snippet') {
      const handoff = await api(`/api/entries/${encodeURIComponent(id)}/handoff`);
      await copy(handoff.claudeMdSnippet, 'Claude Code snippet');
    }
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
  }
}

async function setKeepAlive(id, keepAlive) {
  try {
    await api(`/api/entries/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: { keepAlive },
    });
  } catch (error) {
    toast(error.message);
  }
}

async function openLogin(entry) {
  loginTarget = entry.id;
  loginTitle.textContent = `Log in to ${entry.label}`;
  loginError.textContent = '';
  passcodeInput.value = '';
  loginMessage.textContent = 'Opening your browser…';
  passcodeLink.hidden = true;
  dialog.showModal();
  await startLogin(entry.id);
  passcodeInput.focus();
}

async function startLogin(id) {
  try {
    const result = await api(`/api/entries/${encodeURIComponent(id)}/login/start`, { method: 'POST' });
    passcodeLink.hidden = false;
    passcodeLink.href = result.passcodeUrl;
    loginMessage.textContent = result.browserOpened
      ? 'Your browser was opened. Authenticate with your passkey, then paste the one-time passcode here.'
      : 'Open the passcode page below, authenticate, then paste the one-time passcode here.';
    if (result.browserError) loginError.textContent = result.browserError;
  } catch (error) {
    loginMessage.textContent = 'Could not start the login flow.';
    loginError.textContent = error.message;
  }
}

document.getElementById('submit-passcode').addEventListener('click', async () => {
  if (!loginTarget) return;
  const passcode = passcodeInput.value.trim();
  if (!passcode) {
    loginError.textContent = 'Paste the one-time passcode from the browser page.';
    return;
  }
  loginError.textContent = '';
  loginMessage.textContent = 'Finishing login…';
  try {
    const result = await api(`/api/entries/${encodeURIComponent(loginTarget)}/login/complete`, {
      method: 'POST',
      body: { passcode },
    });
    passcodeInput.value = '';
    dialog.close();
    toast(`${result.entry.label} is ${result.entry.status}`);
    loginTarget = null;
  } catch (error) {
    // Keep the dialog open: the entry stays in waiting_passcode and the user
    // can fetch a fresh passcode.
    loginMessage.textContent = 'Login failed.';
    loginError.textContent = error.message;
    passcodeInput.value = '';
    passcodeInput.focus();
  }
});

document.getElementById('reopen-browser').addEventListener('click', () => {
  if (loginTarget) void startLogin(loginTarget);
});

dialog.addEventListener('close', () => {
  passcodeInput.value = '';
  loginTarget = null;
});

document.getElementById('add-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const errorEl = document.getElementById('add-error');
  errorEl.textContent = '';
  const data = Object.fromEntries(new FormData(form).entries());
  try {
    const result = await api('/api/entries', { method: 'POST', body: data });
    form.reset();
    toast(`${result.entry.label} added`);
  } catch (error) {
    errorEl.textContent = error.message;
  }
});

function applyEvent(event) {
  if (event.type === 'entries') {
    entries.clear();
    for (const entry of event.entries) entries.set(entry.id, entry);
  } else if (event.type === 'entry') {
    entries.set(event.entry.id, event.entry);
  } else if (event.type === 'removed') {
    entries.delete(event.id);
  }
  render();
}

function connect() {
  const source = new EventSource('/api/events');
  source.addEventListener('open', () => {
    streamEl.dataset.state = 'live';
    streamEl.textContent = 'live';
  });
  source.addEventListener('message', (event) => applyEvent(JSON.parse(event.data)));
  source.addEventListener('error', () => {
    streamEl.dataset.state = 'offline';
    streamEl.textContent = 'reconnecting…';
    // EventSource reconnects on its own; nothing to do but show the state.
  });
}

async function boot() {
  try {
    const health = await api('/api/health');
    rootEl.textContent = health.root;
  } catch {
    rootEl.textContent = 'core service unreachable';
  }
  try {
    const { entries: list } = await api('/api/entries');
    applyEvent({ type: 'entries', entries: list });
  } catch (error) {
    emptyEl.textContent = error.message;
  }
  connect();
  // Countdowns tick locally; the server only pushes real status changes.
  setInterval(render, 30_000);
}

void boot();
