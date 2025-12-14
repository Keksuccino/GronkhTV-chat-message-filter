// ==UserScript==
// @name         gronkh.tv Chat Filter (Text/Regex)
// @namespace    https://gronkh.tv/
// @version      0.1.2
// @description  Adds a chat-settings option to filter messages by plain text or regex (persistent, manageable list).
// @match        https://gronkh.tv/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const STORAGE_KEY = 'gronkhTvChatFilterRulesV1';
  const STYLE_ID = 'tm-gronkh-chat-filter-style';
  const MODAL_ID = 'tm-gronkh-chat-filter-modal';
  const MENU_ITEM_ATTR = 'data-tm-chat-filter-item';

  const SELECTORS = {
    chatSettingsTrigger: 'grnk-chat-replay button[gruipopover="Chat Einstellungen"].cdk-menu-trigger, button[aria-label="Chat Einstellungen"].cdk-menu-trigger',
    overlayContainer: '.cdk-overlay-container',
    menuRoot: '[role="menu"], .cdk-menu',
    chatMessageBox: '.cr-message-box',
    chatMessageContainer: '.cr-message-container',
  };

  const state = {
    lastSettingsClickTs: 0,
    lastSettingsTrigger: null,
    pendingMenuInjectUntil: 0,
    compiled: [],
    enabled: true,
    version: 1,
    elementVersion: new WeakMap(),
    observers: [],
  };

  function now() {
    return Date.now();
  }

  function safeJsonParse(str, fallback) {
    try {
      return JSON.parse(str);
    } catch {
      return fallback;
    }
  }

  function loadRules() {
    const raw = localStorage.getItem(STORAGE_KEY);
    const data = safeJsonParse(raw, null);
    if (!data || typeof data !== 'object') return { enabled: true, rules: [] };
    const enabled = typeof data.enabled === 'boolean' ? data.enabled : true;
    const rules = Array.isArray(data.rules) ? data.rules : [];
    return { enabled, rules: rules.filter((r) => r && typeof r === 'object') };
  }

  function saveRules(data) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  }

  function newId() {
    return `r_${Math.random().toString(16).slice(2)}_${Date.now().toString(16)}`;
  }

  function normalizeText(text) {
    return (text || '').replace(/\\s+/g, ' ').trim();
  }

  function compileRule(rule) {
    if (!rule || typeof rule !== 'object') return null;
    if (!rule.enabled) return null;
    const mode = rule.mode === 'regex' ? 'regex' : 'text';
    const pattern = String(rule.pattern || '').trim();
    if (!pattern) return null;

    if (mode === 'text') {
      const caseInsensitive = !!rule.caseInsensitive;
      const needle = caseInsensitive ? pattern.toLowerCase() : pattern;
      return {
        id: rule.id,
        test: (haystack) => {
          if (!haystack) return false;
          const h = caseInsensitive ? haystack.toLowerCase() : haystack;
          return h.includes(needle);
        },
        describe: () => `text:${pattern}${caseInsensitive ? ' (i)' : ''}`,
      };
    }

    // regex
    let flags = String(rule.flags || '').trim();
    // Safety: avoid runaway flags; allow only common JS flags.
    flags = flags.replace(/[^dgimsuvy]/g, '');
    try {
      const re = new RegExp(pattern, flags);
      return {
        id: rule.id,
        test: (haystack) => re.test(haystack),
        describe: () => `/${pattern}/${flags}`,
      };
    } catch {
      return null;
    }
  }

  function rebuildMatchers() {
    const data = loadRules();
    state.enabled = !!data.enabled;
    state.compiled = (data.rules || []).map(compileRule).filter(Boolean);
    state.version += 1;
  }

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      :root {
        --tm-cf-text: var(--d-bg_dark_h-0-text, #f8f8ff);
        --tm-cf-muted: rgba(248, 248, 255, 0.72);
        --tm-cf-border: rgba(255, 255, 255, 0.12);
        --tm-cf-surface: color-mix(in srgb, var(--d-bg_dark_h-25, #191919) 70%, rgba(35, 30, 55, 1) 30%);
        --tm-cf-surface-2: color-mix(in srgb, var(--d-bg_dark_h-50, #1d1d1d) 70%, rgba(35, 30, 55, 1) 30%);
        --tm-cf-accent: var(--d-quartenary_h-400, #c94cee);
        --tm-cf-accent-2: var(--d-bg_bright_h-600, #576794);
        --tm-cf-danger: #ef4444;
      }

      @supports not (color-mix(in srgb, #000 50%, #fff 50%)) {
        :root {
          --tm-cf-surface: rgba(18, 19, 26, 0.92);
          --tm-cf-surface-2: rgba(18, 19, 26, 0.78);
        }
      }

      .tm-gronkh-chat-filter-hidden { display: none !important; }

      /* Modal */
      #${MODAL_ID} { position: fixed; inset: 0; z-index: 2147483647; display: none; }
      #${MODAL_ID}[data-open="1"] { display: block; }
      #${MODAL_ID} .tm-backdrop { position: absolute; inset: 0; background: rgba(0,0,0,.62); backdrop-filter: blur(2px); }
      #${MODAL_ID} .tm-panel {
        position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
        width: min(920px, calc(100vw - 24px));
        max-height: min(80vh, 820px);
        color: var(--tm-cf-text);
        background:
          radial-gradient(1200px 380px at 25% -10%, rgba(201, 76, 238, 0.16), transparent 60%),
          radial-gradient(900px 420px at 90% 0%, rgba(87, 103, 148, 0.18), transparent 55%),
          linear-gradient(180deg, rgba(255,255,255,0.06), rgba(255,255,255,0)),
          var(--tm-cf-surface);
        border: 1px solid var(--tm-cf-border);
        border-radius: 16px;
        box-shadow:
          0 18px 60px rgba(0,0,0,.62),
          inset 0 1px 0 rgba(255,255,255,.08);
        overflow: hidden;
        font: inherit;
      }
      #${MODAL_ID} .tm-header {
        display: flex; align-items: center; justify-content: space-between;
        padding: 14px 16px;
        background: linear-gradient(180deg, rgba(0,0,0,.22), rgba(0,0,0,0));
        border-bottom: 1px solid rgba(255,255,255,.10);
      }
      #${MODAL_ID} .tm-title { font-weight: 700; letter-spacing: .2px; }
      #${MODAL_ID} .tm-close {
        appearance: none; border: 1px solid rgba(255,255,255,.16);
        background: rgba(255,255,255,.06); color: var(--tm-cf-text);
        border-radius: 10px; padding: 6px 10px; cursor: pointer;
      }
      #${MODAL_ID} .tm-body { padding: 14px 16px 16px; overflow: auto; max-height: calc(80vh - 56px); }
      #${MODAL_ID} .tm-row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-bottom: 12px; }
      #${MODAL_ID} .tm-row .tm-spacer { flex: 1; }
      #${MODAL_ID} .tm-note { color: var(--tm-cf-muted); font-size: 12px; line-height: 1.45; }
      #${MODAL_ID} .tm-btn {
        appearance: none; border: 1px solid rgba(255,255,255,.16);
        background: rgba(255,255,255,.06); color: var(--tm-cf-text);
        border-radius: 12px; padding: 8px 10px; cursor: pointer;
        box-shadow: inset 0 1px 0 rgba(255,255,255,.06);
      }
      #${MODAL_ID} .tm-btn:hover { background: rgba(255,255,255,.085); }
      #${MODAL_ID} .tm-btn:active { transform: translateY(0.5px); }
      #${MODAL_ID} .tm-btn.tm-primary {
        background: rgba(201, 76, 238, .16);
        border-color: rgba(201, 76, 238, .44);
      }
      #${MODAL_ID} .tm-btn.tm-primary:hover { background: rgba(201, 76, 238, .22); }
      #${MODAL_ID} .tm-btn.tm-danger {
        background: rgba(239, 68, 68, .14);
        border-color: rgba(239, 68, 68, .40);
      }
      #${MODAL_ID} .tm-btn.tm-danger:hover { background: rgba(239, 68, 68, .20); }
      #${MODAL_ID} input[type="text"], #${MODAL_ID} select {
        background: rgba(0,0,0,.20); color: var(--tm-cf-text);
        border: 1px solid rgba(255,255,255,.12);
        border-radius: 12px;
        padding: 8px 10px;
        outline: none;
      }
      #${MODAL_ID} input[type="text"]::placeholder { color: rgba(248,248,255,.50); }
      #${MODAL_ID} input[type="text"]:focus, #${MODAL_ID} select:focus {
        border-color: rgba(201, 76, 238, .55);
        box-shadow: 0 0 0 3px rgba(201, 76, 238, .18);
      }
      #${MODAL_ID} table { width: 100%; border-collapse: collapse; }
      #${MODAL_ID} th, #${MODAL_ID} td { padding: 10px 8px; border-bottom: 1px solid rgba(255,255,255,.08); vertical-align: top; }
      #${MODAL_ID} thead th {
        text-align: left; font-size: 12px;
        color: rgba(248,248,255,.80);
        background: rgba(0,0,0,.16);
      }
      #${MODAL_ID} tbody tr:hover td { background: rgba(255,255,255,.04); }
      #${MODAL_ID} .tm-pill {
        display: inline-block; font-size: 12px; padding: 2px 8px;
        border-radius: 999px; border: 1px solid rgba(255,255,255,.14);
        background: rgba(0,0,0,.18);
      }
      #${MODAL_ID} .tm-pattern { word-break: break-word; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono, monospace; font-size: 12px; }
      #${MODAL_ID} .tm-muted { color: var(--tm-cf-muted); font-size: 12px; }

      /* Slightly nicer checkboxes on dark backgrounds */
      #${MODAL_ID} input[type="checkbox"] {
        accent-color: var(--tm-cf-accent);
      }

      /* Scrollbar to match gronkh dark UI */
      #${MODAL_ID} .tm-body {
        scrollbar-width: thin;
        scrollbar-color: rgba(255, 255, 255, 0.22) rgba(0, 0, 0, 0.18);
      }
      #${MODAL_ID} .tm-body::-webkit-scrollbar { width: 10px; height: 10px; }
      #${MODAL_ID} .tm-body::-webkit-scrollbar-track { background: rgba(0,0,0,.18); border-radius: 999px; }
      #${MODAL_ID} .tm-body::-webkit-scrollbar-thumb {
        background: rgba(255,255,255,.20);
        border-radius: 999px;
        border: 2px solid rgba(0,0,0,.18);
        background-clip: padding-box;
      }
      #${MODAL_ID} .tm-body:hover::-webkit-scrollbar-thumb { background: rgba(255,255,255,.28); }
    `;
    document.documentElement.appendChild(style);
  }

  function ensureModal() {
    ensureStyle();
    let root = document.getElementById(MODAL_ID);
    if (root) return root;

    root = document.createElement('div');
    root.id = MODAL_ID;
    root.innerHTML = `
      <div class="tm-backdrop"></div>
      <div class="tm-panel" role="dialog" aria-modal="true" aria-label="Chat Filter">
        <div class="tm-header">
          <div class="tm-title">Chat Filter</div>
          <button class="tm-close" type="button">Schließen</button>
        </div>
        <div class="tm-body"></div>
      </div>
    `;
    document.documentElement.appendChild(root);

    const close = () => closeModal();
    root.querySelector('.tm-backdrop')?.addEventListener('click', close);
    root.querySelector('.tm-close')?.addEventListener('click', close);
    document.addEventListener('keydown', (e) => {
      if (root.getAttribute('data-open') !== '1') return;
      if (e.key === 'Escape') close();
    });
    return root;
  }

  function openModal() {
    const root = ensureModal();
    renderModal();
    root.setAttribute('data-open', '1');
  }

  function closeModal() {
    const root = document.getElementById(MODAL_ID);
    if (!root) return;
    root.setAttribute('data-open', '0');
  }

  function renderModal() {
    const root = ensureModal();
    const body = root.querySelector('.tm-body');
    if (!body) return;

    const data = loadRules();
    const rules = data.rules || [];

    const esc = (s) =>
      String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\"/g, '&quot;')
        .replace(/'/g, '&#39;');

    body.innerHTML = `
      <div class="tm-row">
        <label style="display:flex; align-items:center; gap:8px;">
          <input id="tm-enabled" type="checkbox" ${data.enabled ? 'checked' : ''} />
          <span>Filter aktiv</span>
        </label>
        <span class="tm-spacer"></span>
        <button id="tm-add" class="tm-btn tm-primary" type="button">+ Regel hinzufügen</button>
      </div>
      <div class="tm-note" style="margin-bottom:12px;">
        Regeln werden auf neue Chat-Nachrichten angewendet. <span class="tm-muted">Tipp:</span>
        Regex ist JavaScript-Regex (ohne <span class="tm-pattern">/ /</span>-Delimiter), Flags wie <span class="tm-pattern">i</span> oder <span class="tm-pattern">m</span>.
      </div>

      <table>
        <thead>
          <tr>
            <th>Aktiv</th>
            <th>Typ</th>
            <th>Pattern</th>
            <th>Optionen</th>
          </tr>
        </thead>
        <tbody>
          ${
            rules.length
              ? rules
                  .map((r) => {
                    const mode = r.mode === 'regex' ? 'regex' : 'text';
                    const enabled = !!r.enabled;
                    const meta =
                      mode === 'text'
                        ? `${r.caseInsensitive ? 'case-insensitive' : 'case-sensitive'}`
                        : `flags: ${esc(String(r.flags || ''))}`;
                    return `
                      <tr data-id="${esc(r.id)}">
                        <td><input class="tm-rule-enabled" type="checkbox" ${enabled ? 'checked' : ''} /></td>
                        <td><span class="tm-pill">${mode === 'regex' ? 'Regex' : 'Text'}</span></td>
                        <td>
                          <div class="tm-pattern">${esc(String(r.pattern || ''))}</div>
                          <div class="tm-muted">${esc(meta)}</div>
                        </td>
                        <td style="white-space:nowrap;">
                          <button class="tm-btn tm-edit" type="button">Bearbeiten</button>
                          <button class="tm-btn tm-danger tm-delete" type="button">Löschen</button>
                        </td>
                      </tr>
                    `;
                  })
                  .join('')
              : `<tr><td colspan="4" class="tm-muted">Keine Regeln angelegt.</td></tr>`
          }
        </tbody>
      </table>
    `;

    body.querySelector('#tm-enabled')?.addEventListener('change', (e) => {
      const enabled = !!e.target?.checked;
      saveRules({ enabled, rules });
      rebuildMatchers();
      applyToAllVisibleChats();
    });

    body.querySelector('#tm-add')?.addEventListener('click', () => {
      const rule = { id: newId(), enabled: true, mode: 'text', pattern: '', caseInsensitive: true, flags: 'i' };
      openRuleEditor(rule, { isNew: true });
    });

    body.querySelectorAll('tr[data-id]').forEach((row) => {
      const id = row.getAttribute('data-id');
      const rule = rules.find((r) => r.id === id);
      if (!rule) return;

      row.querySelector('.tm-rule-enabled')?.addEventListener('change', (e) => {
        rule.enabled = !!e.target?.checked;
        saveRules({ enabled: data.enabled, rules });
        rebuildMatchers();
        applyToAllVisibleChats();
        renderModal();
      });

      row.querySelector('.tm-edit')?.addEventListener('click', () => openRuleEditor({ ...rule }, { isNew: false }));
      row.querySelector('.tm-delete')?.addEventListener('click', () => {
        const next = rules.filter((r) => r.id !== id);
        saveRules({ enabled: data.enabled, rules: next });
        rebuildMatchers();
        applyToAllVisibleChats();
        renderModal();
      });
    });
  }

  function openRuleEditor(rule, { isNew }) {
    const root = ensureModal();
    const body = root.querySelector('.tm-body');
    if (!body) return;

    const escAttr = (s) =>
      String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\"/g, '&quot;')
        .replace(/'/g, '&#39;');

    const mode = rule.mode === 'regex' ? 'regex' : 'text';
    const pattern = String(rule.pattern || '');
    const flags = String(rule.flags || 'i');
    const enabled = !!rule.enabled;
    const caseInsensitive = !!rule.caseInsensitive;

    body.innerHTML = `
      <div class="tm-row">
        <button id="tm-back" class="tm-btn" type="button">← Zurück</button>
        <span class="tm-spacer"></span>
        <button id="tm-save" class="tm-btn tm-primary" type="button">${isNew ? 'Hinzufügen' : 'Speichern'}</button>
      </div>

      <div class="tm-row">
        <label style="display:flex; align-items:center; gap:8px;">
          <input id="tm-rule-enabled" type="checkbox" ${enabled ? 'checked' : ''} />
          <span>Regel aktiv</span>
        </label>
      </div>

      <div class="tm-row">
        <label style="min-width:120px;">Typ</label>
        <select id="tm-mode">
          <option value="text" ${mode === 'text' ? 'selected' : ''}>Text (enthält)</option>
          <option value="regex" ${mode === 'regex' ? 'selected' : ''}>Regex</option>
        </select>
      </div>

      <div class="tm-row">
        <label style="min-width:120px;">Pattern</label>
        <input id="tm-pattern" type="text" style="flex:1; min-width: 280px;" placeholder="z.B. spoiler oder (?:badword1|badword2)" value="${escAttr(pattern)}" />
      </div>

      <div id="tm-text-options" class="tm-row" style="${mode === 'text' ? '' : 'display:none;'}">
        <label style="min-width:120px;">Optionen</label>
        <label style="display:flex; align-items:center; gap:8px;">
          <input id="tm-ci" type="checkbox" ${caseInsensitive ? 'checked' : ''} />
          <span>Case-insensitive</span>
        </label>
      </div>

      <div id="tm-regex-options" class="tm-row" style="${mode === 'regex' ? '' : 'display:none;'}">
        <label style="min-width:120px;">Flags</label>
        <input id="tm-flags" type="text" style="width:120px;" value="${escAttr(flags)}" />
        <span class="tm-muted">z.B. <span class="tm-pattern">i</span>, <span class="tm-pattern">m</span></span>
      </div>

      <div id="tm-error" class="tm-note" style="display:none; color: #fecaca; margin-top: 10px;"></div>
    `;

    const back = body.querySelector('#tm-back');
    const save = body.querySelector('#tm-save');
    const modeEl = body.querySelector('#tm-mode');
    const patEl = body.querySelector('#tm-pattern');
    const flagsEl = body.querySelector('#tm-flags');
    const enabledEl = body.querySelector('#tm-rule-enabled');
    const ciEl = body.querySelector('#tm-ci');
    const textOpt = body.querySelector('#tm-text-options');
    const reOpt = body.querySelector('#tm-regex-options');
    const errEl = body.querySelector('#tm-error');

    const showError = (msg) => {
      if (!errEl) return;
      errEl.textContent = msg;
      errEl.style.display = msg ? 'block' : 'none';
    };

    modeEl?.addEventListener('change', () => {
      const m = modeEl.value === 'regex' ? 'regex' : 'text';
      if (textOpt) textOpt.style.display = m === 'text' ? '' : 'none';
      if (reOpt) reOpt.style.display = m === 'regex' ? '' : 'none';
      showError('');
    });

    back?.addEventListener('click', () => renderModal());

    save?.addEventListener('click', () => {
      const data = loadRules();
      const rules = data.rules || [];

      const next = {
        id: rule.id || newId(),
        enabled: !!enabledEl?.checked,
        mode: modeEl?.value === 'regex' ? 'regex' : 'text',
        pattern: String(patEl?.value || '').trim(),
        caseInsensitive: !!ciEl?.checked,
        flags: String(flagsEl?.value || '').trim(),
      };

      if (!next.pattern) {
        showError('Pattern darf nicht leer sein.');
        return;
      }

      // Validate compile
      const compiled = compileRule(next);
      if (next.enabled && !compiled) {
        showError('Ungültige Regex oder Regel konnte nicht kompiliert werden.');
        return;
      }

      const existingIdx = rules.findIndex((r) => r.id === next.id);
      if (existingIdx >= 0) rules[existingIdx] = next;
      else rules.unshift(next);

      saveRules({ enabled: data.enabled, rules });
      rebuildMatchers();
      applyToAllVisibleChats();
      renderModal();
    });
  }

  function shouldHideText(text) {
    if (!state.enabled) return false;
    if (!state.compiled.length) return false;
    for (const m of state.compiled) {
      try {
        if (m.test(text)) return true;
      } catch {
        // ignore matcher errors
      }
    }
    return false;
  }

  function applyToMessageBox(box) {
    if (!box || !(box instanceof Element)) return;
    if (state.elementVersion.get(box) === state.version) return;
    state.elementVersion.set(box, state.version);

    const text = normalizeText(box.textContent);
    if (!text) return;
    const hide = shouldHideText(text);
    box.classList.toggle('tm-gronkh-chat-filter-hidden', hide);
  }

  function applyToChatContainer(container) {
    if (!container || !(container instanceof Element)) return;
    container.querySelectorAll(SELECTORS.chatMessageBox).forEach(applyToMessageBox);
  }

  function applyToAllVisibleChats() {
    document.querySelectorAll(SELECTORS.chatMessageContainer).forEach(applyToChatContainer);
  }

  function attachChatObservers() {
    // Observe message containers for new messages.
    document.querySelectorAll(SELECTORS.chatMessageContainer).forEach((container) => {
      if (container.__tmChatFilterObserved) return;
      container.__tmChatFilterObserved = true;

      const mo = new MutationObserver((mutations) => {
        for (const mu of mutations) {
          for (const node of mu.addedNodes || []) {
            if (!(node instanceof Element)) continue;
            if (node.matches?.(SELECTORS.chatMessageBox)) {
              applyToMessageBox(node);
            } else {
              node.querySelectorAll?.(SELECTORS.chatMessageBox)?.forEach(applyToMessageBox);
            }
          }
        }
      });
      mo.observe(container, { childList: true, subtree: true });
      state.observers.push(mo);
      applyToChatContainer(container);
    });
  }

  function makeMenuItemLike(existingButton) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'Chat Filter…';
    btn.setAttribute(MENU_ITEM_ATTR, '1');

    if (existingButton && existingButton instanceof Element) {
      // Copy visual styling hooks from the menu’s own items.
      btn.className = existingButton.className || '';
      const role = existingButton.getAttribute('role');
      if (role) btn.setAttribute('role', role);
      const tabindex = existingButton.getAttribute('tabindex');
      if (tabindex != null) btn.setAttribute('tabindex', tabindex);
      btn.removeAttribute('disabled');
      btn.removeAttribute('aria-disabled');
    } else {
      // Fallback styling if we couldn't find a menu item sample.
      btn.style.cssText = [
        'width: 100%',
        'text-align: left',
        'padding: 10px 12px',
        'background: transparent',
        'color: inherit',
        'border: 0',
        'cursor: pointer',
        'font: inherit',
      ].join(';');
    }

    return btn;
  }

  function isLikelyTooltipRoot(el) {
    if (!el || !(el instanceof Element)) return false;
    // Common pattern: tooltip content uses role="tooltip"
    if (el.getAttribute('role') === 'tooltip') return true;
    if (el.querySelector('[role="tooltip"]')) return true;
    // Avoid injecting into tooltips that contain the settings label.
    const txt = (el.textContent || '').trim();
    if (/^Chat\\s+Einstellungen$/i.test(txt)) return true;
    return false;
  }

  function ensureInjectedIntoMenuRoot(menuRoot) {
    if (!menuRoot || !(menuRoot instanceof Element)) return;
    if (isLikelyTooltipRoot(menuRoot)) return;
    if (menuRoot.querySelector(`[${MENU_ITEM_ATTR}]`)) return;

    // Only inject shortly after chat settings button click.
    if (now() > state.pendingMenuInjectUntil) return;

    const sampleItem = menuRoot.querySelector('button, [role="menuitem"], .cdk-menu-item');
    if (!sampleItem) return;

    const container = sampleItem.parentElement || menuRoot;
    const item = makeMenuItemLike(sampleItem);
    item.addEventListener('click', () => {
      // Let the click bubble so the menu can close if it wants to; open modal async.
      setTimeout(() => openModal(), 0);
    });
    container.appendChild(item);

    // If Angular re-renders the menu, keep the entry present while it's mounted.
    if (!menuRoot.__tmChatFilterKeepAlive) {
      const mo = new MutationObserver(() => {
        if (!document.contains(menuRoot)) {
          mo.disconnect();
          return;
        }
        if (menuRoot.querySelector(`[${MENU_ITEM_ATTR}]`)) return;
        ensureInjectedIntoMenuRoot(menuRoot);
      });
      mo.observe(menuRoot, { childList: true, subtree: true });
      menuRoot.__tmChatFilterKeepAlive = mo;
    }
  }

  function observeOverlayForMenus() {
    const overlay = document.querySelector(SELECTORS.overlayContainer);
    if (!overlay) return;
    if (overlay.__tmChatFilterObserved) return;
    overlay.__tmChatFilterObserved = true;

    const mo = new MutationObserver((mutations) => {
      for (const mu of mutations) {
        for (const node of mu.addedNodes || []) {
          if (!(node instanceof Element)) continue;
          // Only act if we are expecting the chat settings menu to open.
          if (now() > state.pendingMenuInjectUntil) continue;

          const menus = [];
          if (node.matches?.(SELECTORS.menuRoot)) menus.push(node);
          node.querySelectorAll?.(SELECTORS.menuRoot)?.forEach((m) => menus.push(m));

          for (const menuRoot of menus) {
            if (isLikelyTooltipRoot(menuRoot)) continue;
            // Defer one tick so Angular finishes rendering menu items.
            setTimeout(() => ensureInjectedIntoMenuRoot(menuRoot), 0);
          }
        }
      }
    });
    mo.observe(overlay, { childList: true, subtree: true });
    state.observers.push(mo);
  }

  function observeSettingsClicks() {
    document.addEventListener(
      'click',
      (e) => {
        const t = e.target instanceof Element ? e.target : null;
        if (!t) return;
        const trigger = t.closest(SELECTORS.chatSettingsTrigger);
        if (!trigger) return;
        state.lastSettingsClickTs = now();
        state.lastSettingsTrigger = trigger;
        state.pendingMenuInjectUntil = now() + 2500;
      },
      true,
    );
  }

  function boot() {
    ensureStyle();
    rebuildMatchers();
    attachChatObservers();
    observeOverlayForMenus();
    observeSettingsClicks();

    // Keep up with SPA changes.
    let pending = false;
    const mo = new MutationObserver(() => {
      if (pending) return;
      pending = true;
      setTimeout(() => {
        pending = false;
        attachChatObservers();
        applyToAllVisibleChats();
        observeOverlayForMenus();
      }, 300);
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
    state.observers.push(mo);
  }

  boot();
})();
