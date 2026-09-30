import { mountManage } from './manage.js';
// Static markup only. Conversation and account values always use textContent/value.
export function mountChat(main, admin, api, expire, signout) {
  let alive = true;
  let busy = false;
  let settings;
  let current;
  let conversations = [];
  let manager;
  const drafts = new Map();
  const avatar = document.querySelector('.brand-mark');
  avatar.dataset.expression = 'idle';
  document.title = 'Chat · Rove';
  main.className = 'workspace';
  main.innerHTML = `
    <aside class="sidebar" aria-label="Conversations">
      <div class="sidebar-heading"><h2>Conversations</h2><button id="new-chat" class="secondary" type="button">New chat</button></div>
      <p id="list-status" class="small" role="status">Loading conversations…</p>
      <nav id="conversation-list" aria-label="Saved conversations"></nav>
      <div class="sidebar-account"><button id="manage-open" class="secondary" type="button">Customize Rove</button><button id="settings-open" class="secondary" type="button">Model settings</button><strong id="account-name"></strong><span id="account-email" class="small"></span><span class="small">Administrator</span></div>
    </aside>
    <div class="workspace-content">
      <p id="workspace-error" class="error" role="alert" tabindex="-1"></p><button id="reload-workspace" class="secondary" type="button" hidden>Reload workspace</button>
      <section id="chat-view" class="chat-view" aria-labelledby="chat-title">
        <div class="chat-heading"><h1 id="chat-title" tabindex="-1">Start a conversation</h1><p id="model-label" class="small">Loading model settings…</p><button id="proposals-open" class="secondary" type="button">View proposals</button></div><div id="proposal-list" hidden></div>
        <div id="messages" class="messages" role="log" aria-label="Messages" aria-live="polite" aria-relevant="additions"></div>
        <div id="chat-empty" class="chat-empty"><h2>A place to think things through.</h2><p id="empty-description">Connect a model, then start a conversation with Rove.</p><button id="connect-model" class="primary" type="button" hidden>Connect a model</button></div>
        <form id="composer" class="composer"><label for="message">Message Rove</label><textarea id="message" name="content" rows="3" maxlength="4000" placeholder="What would you like to work on?" required aria-describedby="composer-hint"></textarea><div class="composer-actions"><p id="composer-hint" class="small">Enter for a new line. Ctrl or ⌘ + Enter to send.</p><button id="send-message" class="primary" type="submit">Send message</button></div><p id="send-status" class="small" role="status"></p></form>
      </section>
      <section id="manage-view" class="settings-view" hidden></section>
      <section id="settings-view" class="settings-view" aria-labelledby="settings-title" hidden>
        <div class="settings-heading"><div><h1 id="settings-title" tabindex="-1">Model settings</h1><p class="description">Choose an OpenAI-compatible endpoint for your conversations.</p></div><button id="settings-close" class="secondary" type="button">Back to chat</button></div>
        <form id="model-settings">
          <label for="base-url">Endpoint URL</label><input id="base-url" name="baseURL" type="url" maxlength="500" required placeholder="https://api.openai.com/v1" aria-describedby="endpoint-hint"><p id="endpoint-hint" class="hint">Messages and system instructions are sent to this provider. Changing the endpoint requires a new API key.</p>
          <label for="model-id">Model ID</label><input id="model-id" name="model" maxlength="100" required placeholder="Enter a model supported by your provider">
          <label for="api-key">API key</label><input id="api-key" name="apiKey" type="password" maxlength="1000" autocomplete="new-password" spellcheck="false" aria-describedby="key-hint"><p id="key-hint" class="hint"></p>
          <label for="system-prompt">System instructions <span class="optional">(optional)</span></label><textarea id="system-prompt" name="systemPrompt" rows="5" maxlength="2000" placeholder="Describe how Rove should respond." aria-describedby="system-hint"></textarea><p id="system-hint" class="hint">Applied to new messages in every conversation. Up to 2,000 characters.</p>
          <div class="settings-actions"><button id="save-settings" class="primary" type="submit">Save settings</button><button id="disconnect-model" class="secondary" type="button" hidden>Disconnect model</button></div>
          <p id="settings-status" class="hint" role="status"></p>
        </form>
      </section>
    </div>`;
  const find = (selector) => main.querySelector(selector);
  const error = find('#workspace-error');
  const composer = find('#composer');
  const message = find('#message');
  const settingsView = find('#settings-view');
  const chatView = find('#chat-view');
  const send = find('#send-message');
  find('#account-name').textContent = admin.name;
  find('#account-email').textContent = admin.email;

  function setBusy(value) {
    busy = value;
    main.setAttribute('aria-busy', String(value));
    for (const control of main.querySelectorAll('button, input, textarea')) {
      control.disabled = value;
    }
    signout.disabled = value;
    find('#settings-open').disabled = value || !settings;
    find('#new-chat').disabled = value || !settings;
    find('#proposals-open').disabled = value || !current;
    message.disabled =
      value || !settings?.configured || Boolean(current?.pending);
    send.disabled = value || !settings?.configured || Boolean(current?.pending);
  }

  async function run(action) {
    if (busy || !alive) return;
    error.textContent = '';
    avatar.dataset.expression = 'idle';
    setBusy(true);
    try {
      await action();
    } catch (failure) {
      if (!alive) return;
      if (failure.status === 401) {
        expire();
        return;
      }
      error.textContent =
        failure instanceof TypeError
          ? 'Rove could not be reached. Check your connection and try again.'
          : failure.message;
      if (!settings) {
        find('#reload-workspace').hidden = false;
        find('#list-status').textContent = 'Conversations could not be loaded.';
        find('#model-label').textContent =
          'Model settings could not be loaded.';
        composer.hidden = true;
      }
      error.focus();
    } finally {
      if (alive) setBusy(false);
    }
  }

  function renderList() {
    const list = find('#conversation-list');
    list.replaceChildren();
    find('#list-status').textContent = conversations.length
      ? ''
      : 'Your conversations will appear here.';
    for (const conversation of conversations) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'conversation-link';
      button.textContent = conversation.title;
      button.title = conversation.title;
      if (current?.id === conversation.id)
        button.setAttribute('aria-current', 'page');
      button.onclick = () =>
        run(async () => {
          const result = await api(
            `/api/admin/conversations/${conversation.id}`,
          );
          if (!alive) return;
          current = result;
          showChat();
          renderList();
        });
      button.disabled = busy;
      list.append(button);
    }
  }

  function updateConversation(conversation) {
    current = conversation;
    find('#proposal-list').hidden = true;
    conversations = [
      conversation,
      ...conversations.filter((item) => item.id !== conversation.id),
    ];
    renderList();
  }

  function renderMessages() {
    const messages = find('#messages');
    messages.replaceChildren();
    for (const item of current?.messages ?? []) {
      const article = document.createElement('article');
      article.className = `message message-${item.role === 'user' ? 'user' : 'assistant'}`;
      const label = document.createElement('h2');
      label.textContent = item.role === 'user' ? 'You' : 'Rove';
      const content = document.createElement('div');
      content.className = 'message-content';
      content.textContent = item.content;
      article.append(label, content);
      messages.append(article);
    }
    if (current?.pending) {
      const pending = current.pending;
      const panel = document.createElement('section');
      panel.className = 'approval';
      const heading = document.createElement('h2');
      heading.textContent =
        pending.status === 'waiting'
          ? 'Review this action'
          : 'Continue after the saved result';
      const description = document.createElement('p');
      description.textContent = `${pending.name}: ${pending.description || 'Proposed action.'} Administrator approval is required. Review the exact arguments below. Approval expires after 15 minutes.`;
      const args = document.createElement('pre');
      try {
        args.textContent = JSON.stringify(
          pending.detail ? JSON.parse(pending.detail) : pending.arguments,
          null,
          2,
        );
      } catch {
        args.textContent = pending.detail;
      }
      const actions = document.createElement('div');
      actions.className = 'settings-actions';
      for (const decision of pending.status === 'waiting'
        ? ['approve', 'deny']
        : ['approve']) {
        const control = document.createElement('button');
        control.type = 'button';
        control.className = decision === 'approve' ? 'primary' : 'secondary';
        control.textContent =
          pending.status !== 'waiting'
            ? 'Continue reply'
            : decision === 'approve'
              ? 'Approve this action'
              : 'Deny action';
        control.onclick = () =>
          run(async () => {
            avatar.dataset.expression = 'thinking';
            const result = await api(
              `/api/admin/conversations/${current.id}/approval`,
              { approvalId: pending.id, decision },
            );
            if (!alive) return;
            avatar.dataset.expression = 'idle';
            updateConversation(result);
            renderMessages();
          });
        actions.append(control);
      }
      panel.append(heading, description, args, actions);
      messages.append(panel);
    }
    find('#chat-empty').hidden = Boolean(current?.messages.length);
    find('#chat-title').textContent = current?.title || 'Start a conversation';
    message.value = drafts.get(current?.id)?.content || '';
    send.textContent = drafts.get(current?.id)?.requestId
      ? 'Retry message'
      : 'Send message';
  }

  function showChat() {
    find('#manage-view').hidden = true;
    settingsView.hidden = true;
    chatView.hidden = false;
    document.title = 'Chat · Rove';
    renderMessages();
    find('#chat-title').focus();
  }

  function renderSettings() {
    find('#base-url').value = settings.baseURL;
    find('#model-id').value = settings.model;
    find('#system-prompt').value = settings.systemPrompt;
    find('#api-key').value = '';
    find('#api-key').required = !settings.configured;
    find('#key-hint').textContent = settings.configured
      ? 'A key is saved. Leave this blank to keep it, or enter a replacement.'
      : 'Enter the API key for this provider. Saved keys are never shown here.';
    find('#disconnect-model').hidden = !settings.configured;
    find('#model-label').textContent = settings.configured
      ? settings.model
      : 'No model connected';
    find('#connect-model').hidden = settings.configured;
    find('#empty-description').textContent = settings.configured
      ? 'Ask a question, explore an idea, or work through a draft. Conversations are saved in this Rove instance.'
      : 'Connect a model in settings to start chatting. Your existing conversations stay available.';
    composer.hidden = !settings.configured;
  }

  function showSettings() {
    if (busy || !settings) return;
    error.textContent = '';
    avatar.dataset.expression = 'idle';
    find('#settings-status').textContent = '';
    renderSettings();
    find('#manage-view').hidden = true;
    chatView.hidden = true;
    settingsView.hidden = false;
    document.title = 'Model settings · Rove';
    find('#settings-title').focus();
  }

  find('#proposals-open').onclick = () =>
    run(async () => {
      const { aips } = await api(`/api/admin/aips/${current.id}`);
      if (!alive) return;
      const list = find('#proposal-list');
      list.replaceChildren();
      list.hidden = false;
      if (!aips.length) {
        const empty = document.createElement('p');
        empty.className = 'hint';
        empty.textContent =
          'No proposals in this conversation. Connect GitHub in Customize Rove, then ask Rove to draft an AIP.';
        list.append(empty);
      }
      for (const aip of aips) {
        const details = document.createElement('details');
        details.className = 'configuration-row';
        const title = document.createElement('summary');
        title.textContent = `${aip.title} · ${aip.status}`;
        const content = document.createElement('pre');
        content.className = 'proposal-content';
        content.textContent = JSON.stringify(aip, null, 2);
        details.append(title, content);
        list.append(details);
      }
    });
  find('#manage-open').onclick = () =>
    run(async () => {
      const view = find('#manage-view');
      manager?.dispose();
      manager = mountManage(view, api, run, showChat);
      await manager.load();
      if (!alive) return;
      chatView.hidden = true;
      settingsView.hidden = true;
      view.hidden = false;
      document.title = 'Customize · Rove';
      view.querySelector('h1').focus();
    });
  find('#settings-open').onclick = showSettings;
  find('#connect-model').onclick = showSettings;
  find('#settings-close').onclick = showChat;
  find('#base-url').oninput = () => {
    find('#api-key').required =
      !settings.configured ||
      find('#base-url').value.trim() !== settings.baseURL;
  };
  find('#new-chat').onclick = () => {
    if (!settings?.configured) return showSettings();
    run(async () => {
      const conversation = await api('/api/admin/conversations', {});
      if (!alive) return;
      updateConversation(conversation);
      showChat();
      // Focus after run() enables the composer.
      requestAnimationFrame(() => {
        if (alive) message.focus();
      });
    });
  };
  message.oninput = () => {
    const previous = drafts.get(current?.id);
    drafts.set(current?.id, {
      content: message.value,
      requestId:
        previous?.content === message.value ? previous.requestId : undefined,
    });
    send.textContent = 'Send message';
  };
  message.onkeydown = (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      if (!busy) composer.requestSubmit();
    }
  };
  composer.onsubmit = (event) => {
    event.preventDefault();
    if (!message.value.trim() || busy) return;
    const draft = drafts.get(current?.id);
    const content = message.value;
    const requestId =
      draft?.content === content && draft.requestId
        ? draft.requestId
        : crypto.randomUUID();
    drafts.set(current?.id, { content, requestId });
    run(async () => {
      find('#send-status').textContent =
        'Waiting for Rove… You can retry if the request fails.';
      send.textContent = 'Waiting…';
      try {
        if (!current) {
          const conversation = await api('/api/admin/conversations', {});
          if (!alive) return;
          drafts.delete(undefined);
          drafts.set(conversation.id, { content, requestId });
          updateConversation(conversation);
        }
        avatar.dataset.expression = 'thinking';
        const conversation = await api(
          `/api/admin/conversations/${current.id}/messages`,
          { content, requestId },
        );
        if (!alive) return;
        avatar.dataset.expression = 'idle';
        drafts.delete(current.id);
        updateConversation(conversation);
        renderMessages();
        message.scrollIntoView({ block: 'nearest' });
        requestAnimationFrame(() => {
          if (alive) message.focus();
        });
      } catch (failure) {
        if (alive) avatar.dataset.expression = 'unsure';
        throw failure;
      } finally {
        if (alive) {
          find('#send-status').textContent = '';
          send.textContent = drafts.get(current?.id)?.requestId
            ? 'Retry message'
            : 'Send message';
        }
      }
    });
  };
  find('#model-settings').onsubmit = (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    if (!values.apiKey) delete values.apiKey;
    run(async () => {
      find('#settings-status').textContent = 'Saving settings…';
      try {
        const result = await api('/api/admin/settings', values);
        if (!alive) return;
        settings = result;
        renderSettings();
        find('#settings-status').textContent =
          'Settings saved. Send a message to check the provider connection.';
      } catch (failure) {
        if (alive) find('#settings-status').textContent = '';
        throw failure;
      }
    });
  };
  find('#disconnect-model').onclick = () =>
    run(async () => {
      const result = await api('/api/admin/settings/disconnect', {});
      if (!alive) return;
      settings = result;
      renderSettings();
      find('#settings-status').textContent =
        'Model disconnected. Your saved conversations are still available.';
    });

  const initialize = () =>
    run(async () => {
      const [config, result] = await Promise.all([
        api('/api/admin/settings'),
        api('/api/admin/conversations'),
      ]);
      if (!alive) return;
      settings = config;
      find('#reload-workspace').hidden = true;
      conversations = result.conversations;
      renderSettings();
      renderList();
      find('#chat-title').focus();
    });
  find('#reload-workspace').onclick = initialize;
  initialize();
  return () => {
    alive = false;
    manager?.dispose();
    avatar.dataset.expression = 'idle';
    signout.disabled = false;
    drafts.clear();
  };
}
