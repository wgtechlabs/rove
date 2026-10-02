import { renderPluginPages } from './plugin-pages.js';
import { renderPlugins } from './plugins.js';

// User-controlled values only enter textContent or form controls.
export function mountManage(root, api, run, back, requestAction) {
  let section = 'skills';
  let state;
  let alive = true;
  let runtime;
  const selectedVersions = new Map();
  const actionDrafts = new Map();
  const labels = {
    plugins: 'Plugins',
    pages: 'Pages & actions',
    skills: 'Skills',
    servers: 'Tools & MCP',
    bundles: 'Local bundles',
    slack: 'Slack',
    github: 'GitHub & AIPs',
  };
  root.innerHTML = `<div class="settings-heading"><div><h1 tabindex="-1">Customize Rove</h1><p class="description">Teach your workflow. Connect only what your company needs.</p></div><button type="button" class="secondary" id="manage-back">Back to chat</button></div><nav class="manage-nav" aria-label="Configuration"></nav><p id="manage-status" class="hint" role="status"></p><div id="manage-content"></div>`;
  root.querySelector('#manage-back').onclick = back;
  const content = root.querySelector('#manage-content');
  const nav = root.querySelector('nav');
  function node(tag, text, className) {
    const element = document.createElement(tag);
    if (text) element.textContent = text;
    if (className) element.className = className;
    return element;
  }
  function button(text, action, primary = false) {
    const element = node('button', text, primary ? 'primary' : 'secondary');
    element.type = 'button';
    element.onclick = action;
    return element;
  }
  function field(form, name, label, type = 'text', value = '', hint = '') {
    const id = `manage-${name}`;
    const caption = node('label', label);
    caption.htmlFor = id;
    const input = node(type === 'textarea' ? 'textarea' : 'input');
    input.id = id;
    input.name = name;
    if (type === 'textarea') {
      input.rows = 6;
      input.maxLength = 24000;
    } else input.type = type;
    if (type === 'checkbox') {
      caption.className = 'checkbox';
      input.checked = Boolean(value);
      caption.prepend(input);
      form.append(caption);
    } else {
      input.value = value;
      if (type === 'password') input.autocomplete = 'new-password';
      form.append(caption, input);
    }
    if (hint) {
      const help = node('p', hint, 'hint');
      help.id = `${id}-hint`;
      input.setAttribute('aria-describedby', help.id);
      form.append(help);
    }
    return input;
  }
  function submit(form, text, save) {
    const control = button(text, null, true);
    control.type = 'submit';
    form.append(control);
    form.onsubmit = (event) => {
      event.preventDefault();
      root.querySelector('#manage-status').textContent = '';
      run(async () => {
        await save();
        if (alive) {
          await load();
          root.querySelector('#manage-status').textContent = 'Changes saved.';
        }
      });
    };
  }
  function intro(title, description) {
    const heading = node('h2', title);
    heading.tabIndex = -1;
    content.append(heading, node('p', description, 'description'));
  }
  function edit(item = {}) {
    root.querySelector('#manage-status').textContent = '';
    content.replaceChildren();
    const kind = { skills: 'skill', servers: 'server', bundles: 'plugin' }[
      section
    ];
    intro(
      `${item.id ? 'Edit' : 'Add'} ${kind === 'plugin' ? 'local bundle' : kind}`,
      kind === 'server'
        ? 'A connection makes tools available for review. Each call still needs administrator approval.'
        : 'Enabled instructions are sent to your model with every new message.',
    );
    const form = node('form');
    content.append(form);
    const name = field(form, 'name', 'Name', 'text', item.name || '');
    name.required = true;
    name.maxLength = 80;
    const enabled = field(
      form,
      'enabled',
      'Enabled',
      'checkbox',
      item.enabled ?? false,
    );
    let markdown;
    let url;
    let bearer;
    let bundle;
    if (kind === 'skill') {
      markdown = field(
        form,
        'markdown',
        'Instructions',
        'textarea',
        item.markdown || '',
        'Describe the workflow in plain language or Markdown. Up to 8,000 characters.',
      );
      markdown.maxLength = 8000;
      markdown.required = true;
    }
    if (kind === 'server') {
      url = field(
        form,
        'url',
        'MCP server URL',
        'url',
        item.url || '',
        'Use a remote Streamable HTTP endpoint. Public HTTPS is required in production.',
      );
      url.required = true;
      bearer = field(
        form,
        'bearerToken',
        'Bearer token (optional)',
        'password',
        '',
        'Leave blank to keep the saved token for this endpoint.',
      );
    }
    if (kind === 'plugin') {
      bundle = field(
        form,
        'bundle',
        'Skill bundle',
        'textarea',
        JSON.stringify(
          item.skills || [
            {
              name: 'Example workflow',
              markdown: 'Describe your workflow here.',
            },
          ],
          null,
          2,
        ),
        'A local JSON array of named Markdown skills. Bundles cannot run code or grant tool permissions.',
      );
      bundle.required = true;
    }
    submit(form, 'Save changes', async () => {
      const body = {
        kind,
        name: name.value,
        enabled: enabled.checked,
        ...(item.id ? { id: item.id } : {}),
      };
      if (markdown) body.markdown = markdown.value;
      if (url) {
        body.url = url.value;
        body.bearerToken = bearer.value;
      }
      if (bundle) {
        try {
          body.skills = JSON.parse(bundle.value);
        } catch {
          throw new Error('Enter a valid JSON array of skills.');
        }
      }
      await api('/api/admin/extensions', body);
    });
    content.append(button('Cancel', () => render()));
    name.focus();
  }
  function renderCollection() {
    const descriptions = {
      skills:
        'Teach Rove your language, processes, and expectations. Start with a short, specific workflow.',
      servers:
        'Connect remote MCP servers, discover their tools, then approve each proposed call in its conversation.',
      bundles:
        'Import related skills as one bundle. Enable or disable the bundle together.',
    };
    intro(labels[section], descriptions[section]);
    content.append(
      button(
        `Add ${section === 'servers' ? 'connection' : section.slice(0, -1)}`,
        () => edit(),
      ),
    );
    const items = state[section === 'bundles' ? 'plugins' : section];
    if (!items.length)
      content.append(
        node(
          'p',
          'Nothing added yet. Rove starts with your instructions and grows with your company.',
          'hint',
        ),
      );
    for (const item of items) {
      const row = node('section', null, 'configuration-row');
      row.append(
        node('h3', item.name),
        node('p', item.enabled ? 'Enabled' : 'Disabled', 'small'),
      );
      if (item.url) row.append(node('p', item.url, 'small'));
      const actions = node('div', null, 'settings-actions');
      if (item.managedBy) {
        row.append(
          node(
            'p',
            'Managed by an installed plugin. Review its version and settings in Plugins.',
            'hint',
          ),
        );
        actions.append(
          button('Open Plugins', () =>
            run(async () => {
              section = 'plugins';
              await load();
            }),
          ),
        );
      } else actions.append(button('Edit', () => edit(item)));
      if (section === 'servers') {
        if (!item.managedBy)
          actions.append(
            button('Discover tools', () =>
              run(async () => {
                state = await api('/api/admin/extensions/probe', {
                  id: item.id,
                });
                if (alive) render();
              }),
            ),
          );
        row.append(
          node(
            'p',
            item.tools.length
              ? `${item.tools.length} tools discovered. Each requires approval.`
              : 'Discover tools after saving this connection.',
            'hint',
          ),
        );
        for (const tool of item.tools)
          row.append(
            node(
              'p',
              `${tool.name}: ${tool.description || 'No description supplied.'}`,
              'tool-summary',
            ),
          );
      }
      row.append(actions);
      content.append(row);
    }
  }
  function renderSlack() {
    intro(
      'Slack',
      'Keep web chat available while Rove joins selected Slack conversations. Only the people and channels you allow can use it.',
    );
    if (state.health?.state === 'failed')
      content.append(node('p', state.health.message, 'error'));
    if (state.failures?.length)
      content.append(
        node(
          'p',
          `${state.failures.map((item) => `${item.count} ${item.status} deliveries`).join(', ')}. Check Slack before retrying uncertain deliveries.`,
          'error',
        ),
      );
    const instructions = node('p', null, 'hint');
    instructions.textContent =
      'Create a Slack app with app_mentions:read, im:history, and chat:write. Subscribe to app_mention and message.im. Enable the App Home Messages tab. Add the two request URLs below in Slack.';
    content.append(
      instructions,
      node('p', `${location.origin}/api/slack/events`, 'endpoint'),
      node('p', `${location.origin}/api/slack/interactivity`, 'endpoint'),
    );
    const form = node('form');
    content.append(form);
    const enabled = field(
      form,
      'enabled',
      'Enable Slack',
      'checkbox',
      state.enabled,
    );
    const token = field(
      form,
      'botToken',
      'Bot token',
      'password',
      '',
      'Leave saved credentials blank to keep them.',
    );
    const secret = field(form, 'signingSecret', 'Signing secret', 'password');
    const users = field(
      form,
      'allowedUsers',
      'Allowed user IDs',
      'text',
      state.allowedUsers.join(', '),
      'Comma-separated Slack member IDs. An empty list denies everyone.',
    );
    const channels = field(
      form,
      'allowedChannels',
      'Allowed channel IDs',
      'text',
      state.allowedChannels.join(', '),
      'Channel messages must mention Rove. Shared external channels are excluded.',
    );
    const admins = field(
      form,
      'adminUsers',
      'Administrator user IDs',
      'text',
      state.adminUsers.join(', '),
      'Only these allowed users may approve actions in Slack.',
    );
    const dm = field(
      form,
      'allowDM',
      'Allow direct messages from allowed users',
      'checkbox',
      state.allowDM,
    );
    const ids = (input) => input.value.split(/[\s,]+/).filter(Boolean);
    submit(form, 'Save Slack configuration', () =>
      api('/api/admin/slack', {
        enabled: enabled.checked,
        botToken: token.value,
        signingSecret: secret.value,
        allowedUsers: ids(users),
        allowedChannels: ids(channels),
        adminUsers: ids(admins),
        allowDM: dm.checked,
      }),
    );
    content.append(
      node(
        'p',
        state.configured
          ? 'Credentials saved. Verify event subscriptions and send Rove a mention in an allowed channel.'
          : 'Slack is not connected. Web chat works independently.',
        'hint',
      ),
    );
  }
  function renderGitHub() {
    intro(
      'GitHub & AIPs',
      'Agent Improvement Proposals turn reviewed ideas into changes your company owns.',
    );
    const steps = node('ol', null, 'aip-steps');
    for (const text of [
      'Discuss a workflow improvement in web chat or Slack.',
      'Review the draft and ask Rove to revise it in that conversation.',
      'Approve a separate action to open a draft GitHub pull request.',
      'Approve the exact final revision, pass repository checks, and merge in GitHub.',
      'Publish a verified immutable release, then approve its activation separately in the original conversation.',
    ])
      steps.append(node('li', text));
    content.append(steps);
    const form = node('form');
    content.append(form);
    const repo = field(
      form,
      'repo',
      'Company repository',
      'text',
      state.repo || '',
      'Use owner/repository. Approve the same repository in Plugins before activating its released changes.',
    );
    repo.required = true;
    const token = field(
      form,
      'token',
      'GitHub access token',
      'password',
      '',
      'Use a repository-scoped token with Contents and Pull requests read/write, plus Actions read access for release verification. Leave blank to retain the saved token.',
    );
    const workflow = field(
      form,
      'workflowPath',
      'Release workflow path',
      'text',
      state.workflowPath || '',
      'The GitHub Actions workflow that builds the release artifact, for example .github/workflows/release.yml. Leave blank to keep the configured default.',
    );
    submit(form, 'Save GitHub connection', () =>
      api('/api/admin/github', {
        repo: repo.value,
        token: token.value,
        ...(workflow.value.trim()
          ? { workflowPath: workflow.value.trim() }
          : {}),
      }),
    );
    content.append(
      node(
        'p',
        state.configured
          ? 'Connection saved. Ask Rove to draft an AIP in a conversation.'
          : 'Connect a company repository to enable AIP tools.',
        'hint',
      ),
    );
  }
  function render() {
    if (!alive) return;
    content.replaceChildren();
    for (const control of nav.children)
      control.setAttribute(
        'aria-current',
        control.dataset.section === section ? 'page' : 'false',
      );
    if (section === 'plugins') {
      intro(
        'Plugins',
        'Prepare a released version, review its settings and permissions, then activate it when you are ready.',
      );
      renderPlugins(content, state, runtime, {
        node,
        button,
        field,
        submit,
        api,
        run,
        selectedVersions,
        change(path, body, message) {
          return run(async () => {
            root.querySelector('#manage-status').textContent = '';
            await api(path, body);
            if (!alive) return;
            await load();
            root.querySelector('#manage-status').textContent = message;
          });
        },
      });
    } else if (section === 'pages') {
      intro(
        'Pages & actions',
        'Company pages from your active plugins. Review and approve each action in chat.',
      );
      renderPluginPages(content, state, {
        node,
        button,
        field,
        run,
        requestAction,
        drafts: actionDrafts,
      });
    } else if (section === 'slack') renderSlack();
    else if (section === 'github') renderGitHub();
    else renderCollection();
    content.querySelector('h2')?.focus();
  }
  async function load() {
    const endpoint =
      {
        slack: 'slack',
        github: 'github',
        plugins: 'plugins',
        pages: 'plugins/contributions',
      }[section] || 'extensions';
    const result = await api(`/api/admin/${endpoint}`);
    if (section === 'plugins') runtime = await api('/api/admin/runtime');
    if (!alive) return;
    state = result;
    render();
  }
  for (const [key, label] of Object.entries(labels)) {
    const control = button(label, () =>
      run(async () => {
        root.querySelector('#manage-status').textContent = '';
        section = key;
        await load();
      }),
    );
    control.dataset.section = key;
    nav.append(control);
  }
  return {
    load,
    dispose() {
      alive = false;
    },
  };
}
