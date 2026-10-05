// Packages contribute data only; the host owns every control and action.
export function renderPlugins(content, state, runtime, ui) {
  const {
    node,
    button,
    field,
    submit,
    api,
    run,
    change,
    selectedVersions,
    onError,
  } = ui;
  const path = (action) => `/api/admin/plugins/${action}`;
  const unavailable = (control, value) => {
    control.disabled = value;
    control.dataset.unavailable = String(value);
  };
  function choose(parent, name, label, options, value) {
    const caption = node('label', label);
    const control = node('select');
    control.id = `manage-${name}`;
    control.name = name;
    caption.htmlFor = control.id;
    for (const [key, text] of options) {
      const option = node('option', text);
      option.value = key;
      control.append(option);
    }
    control.value = value;
    parent.append(caption, control);
    return control;
  }
  function disclosure(parent, title, open = false) {
    const details = node('details', null, 'plugin-details');
    details.open = open;
    details.append(node('summary', title));
    parent.append(details);
    return details;
  }
  function info(parent, label, value) {
    const line = node('p', null, 'hint');
    line.append(node('strong', `${label}: `), node('span', value));
    parent.append(line);
  }

  if (!state.installations.length)
    content.append(
      node(
        'p',
        'No plugins installed yet. Approve a repository below, then prepare a release. Nothing activates automatically.',
        'plugin-empty',
      ),
    );
  for (const item of state.installations) {
    let availableVersions = item.versions;
    const cachedVersions = item.versions.filter(
      (version) => version.cached !== false,
    );
    const latest = item.versions[0];
    if (!latest) continue;
    const row = node('section', null, 'configuration-row');
    const active = item.versions.find(
      (version) => version.digest === item.active,
    );
    row.append(
      node('h3', latest.name),
      node('p', active ? `Active · ${active.version}` : 'Inactive', 'small'),
    );
    info(row, 'Repository', item.repo);
    row.append(node('p', latest.description, 'description'));
    content.append(row);
    const details = disclosure(
      row,
      'Review versions and settings',
      selectedVersions.get(item.id)?.open || false,
    );
    details.name = 'plugin-review';
    const savedSelection = selectedVersions.get(item.id)?.digest;
    const selected = availableVersions.some(
      (version) => version.digest === savedSelection,
    )
      ? savedSelection
      : item.active || latest.digest;
    const versions = choose(
      details,
      `version-${item.id}`,
      'Prepared version',
      availableVersions.map((version) => [
        version.digest,
        `${version.version} · ${version.tag}${version.digest === item.active ? ' · active' : ''}${version.cached === false ? ' · download removed' : ''}`,
      ]),
      selected,
    );
    const body = node('div');
    details.append(body);
    const renderVersion = (version) => {
      body.replaceChildren();
      const summary = availableVersions.find(
        (entry) => entry.digest === version.digest,
      );
      const manifest = version.manifest;
      const target = {
        id: item.id,
        revision: item.revision,
        digest: version.digest,
      };
      info(body, 'Category', manifest.category);
      info(body, 'Commit', version.commit);
      info(body, 'Artifact SHA-256', version.digest);
      if (version.origin) {
        info(body, 'Imported format', version.origin.format);
        info(body, 'Source SHA-256', version.origin.sourceDigest);
        body.append(
          node(
            'p',
            'Imported declarative content only. This does not verify compatibility with another agent application.',
            'hint',
          ),
        );
        const metadata = version.origin.metadata;
        if (metadata) {
          const publisher = disclosure(body, 'Publisher and license');
          if (metadata.author) {
            info(publisher, 'Author', metadata.author.name);
            if (metadata.author.email)
              info(publisher, 'Author email', metadata.author.email);
            if (metadata.author.url)
              info(publisher, 'Author URL', metadata.author.url);
          }
          if (metadata.license) info(publisher, 'License', metadata.license);
          if (metadata.homepage) info(publisher, 'Homepage', metadata.homepage);
          if (metadata.repository)
            info(publisher, 'Repository', metadata.repository);
          for (const notice of metadata.notices || []) {
            const entry = disclosure(publisher, notice.path);
            entry.append(node('pre', notice.text, 'plugin-preview'));
          }
        }
      }
      if (version.blocked) body.append(node('p', version.blocked, 'error'));
      if (summary?.prunable) {
        const cleanup = disclosure(body, 'Remove cached download');
        cleanup.append(
          node(
            'p',
            'Free space by removing this unused download. Its version fingerprint and review history stay saved. To use it again, the exact original release must still be available from GitHub.',
            'hint',
          ),
        );
        cleanup.append(
          button('Remove this cached version', () =>
            change(
              path('prune'),
              target,
              'Cached download removed. Version identity and review history retained.',
            ),
          ),
        );
      } else if (summary?.pruneReason) {
        body.append(node('p', summary.pruneReason, 'hint'));
      }
      const preview = disclosure(body, 'Preview package contents');
      preview.append(
        node('pre', JSON.stringify(manifest, null, 2), 'plugin-preview'),
      );
      const form = node('form');
      body.append(form);
      const fields = {};
      for (const setting of manifest.settings) {
        const control = field(
          form,
          `plugin-${item.id}-${setting.key}`,
          `${setting.label}${setting.required ? ' (required)' : ''}`,
          setting.type === 'boolean' ? 'checkbox' : 'text',
          item.values[setting.key] ??
            setting.default ??
            (setting.type === 'boolean' ? false : ''),
        );
        if (setting.type === 'text') {
          control.maxLength = 2000;
          control.required = setting.required;
        }
        fields[setting.key] = control;
      }
      const access = {};
      if (manifest.channel) {
        const group = node('fieldset', null, 'plugin-permissions');
        group.append(node('legend', 'Channel access'));
        form.append(group);
        access.tenant = field(
          group,
          `channel-${item.id}-tenant`,
          'Workspace ID',
          'text',
          item.channelAccess?.tenant || '',
        );
        access.tenant.required = true;
        access.tenant.maxLength = 200;
        for (const [key, label] of [
          ['users', 'Allowed user IDs'],
          ['admins', 'Users allowed to approve actions'],
          ['destinations', 'Allowed conversation destinations'],
        ]) {
          access[key] = field(
            group,
            `channel-${item.id}-${key}`,
            label,
            'textarea',
            (item.channelAccess?.[key] || []).join('\n'),
            key === 'admins'
              ? 'Enter one provider ID per line. These users must also be in the allowed users list.'
              : 'Enter one provider ID per line.',
          );
          access[key].rows = 3;
          access[key].maxLength = 20000;
          access[key].required = key !== 'admins';
        }
        info(body, 'Incoming webhook', `/api/channels/${item.id}/events`);
        info(body, 'Delivery endpoint', manifest.channel.outgoing.url);
        const health = node('p', '', 'hint');
        health.tabIndex = -1;
        health.setAttribute('role', 'status');
        body.append(
          button('Check channel deliveries', () =>
            run(async () => {
              const result = await api(path(`${item.id}/channel`));
              health.textContent =
                result.state !== 'ready'
                  ? 'Channel processing is unavailable. Check the deployment logs, then restart Rove.'
                  : result.jobs.length
                    ? `${result.recentLimit ? `Active jobs and latest ${result.recentLimit} completed events: ` : ''}${result.jobs.map((job) => `${job.count} ${job.status}`).join(' · ')}`
                    : 'No channel deliveries yet.';
              health.focus();
            }),
          ),
          health,
        );
      }
      const bindings = {};
      for (const secret of manifest.secrets) {
        const saved = item.secrets[secret.key];
        const group = node('div');
        form.append(group);
        const prefix = `secret-${item.id}-${secret.key}`;
        const mode = choose(
          group,
          `${prefix}-mode`,
          `${secret.label}${secret.required ? ' (required)' : ''}`,
          [
            ['keep', saved ? 'Keep current binding' : 'Not configured'],
            ['stored', 'Store a secret'],
            ['environment', 'Use a deployment variable'],
            ...(saved ? [['remove', 'Remove binding']] : []),
          ],
          'keep',
        );
        if (saved)
          info(
            group,
            'Current binding',
            saved.source === 'environment'
              ? `${saved.name} · ${saved.configured ? 'available' : 'not set'}`
              : 'Encrypted secret saved',
          );
        const storedRow = node('div');
        const stored = field(
          storedRow,
          `${prefix}-value`,
          'Secret value',
          'password',
          '',
          'Saved values are never displayed.',
        );
        stored.maxLength = 2000;
        const environmentRow = node('div');
        const environment = field(
          environmentRow,
          `${prefix}-name`,
          'Deployment variable name',
          'text',
          saved?.name || '',
          'Use a variable beginning ROVE_PLUGIN_SECRET_. Its value is managed in your deployment settings.',
        );
        environment.pattern = 'ROVE_PLUGIN_SECRET_[A-Z0-9_]{1,80}';
        environment.maxLength = 99;
        group.append(storedRow, environmentRow);
        const showBinding = () => {
          storedRow.hidden = mode.value !== 'stored';
          environmentRow.hidden = mode.value !== 'environment';
          stored.required = mode.value === 'stored';
          environment.required = mode.value === 'environment';
          unavailable(stored, mode.value !== 'stored');
          unavailable(environment, mode.value !== 'environment');
        };
        mode.onchange = showBinding;
        showBinding();
        bindings[secret.key] = { mode, stored, environment };
      }
      const removed = {};
      for (const key of Object.keys(item.secrets).filter(
        (key) => !manifest.secrets.some((secret) => secret.key === key),
      )) {
        removed[key] = field(
          form,
          `remove-${item.id}-${key}`,
          `Remove credential “${key}”, which this version does not use`,
          'checkbox',
          false,
        );
        removed[key].required = true;
      }
      const permissions = node('fieldset', null, 'plugin-permissions');
      permissions.append(node('legend', 'Permissions'));
      form.append(permissions);
      const grants = {};
      for (const capability of manifest.capabilities) {
        const server = manifest.servers.find(
          (candidate) => `mcp:${candidate.id}` === capability,
        );
        grants[capability] = field(
          permissions,
          `grant-${item.id}-${capability.replaceAll(':', '-')}`,
          server
            ? `Allow tools from ${server.name}`
            : {
                'channel:ingress':
                  'Receive verified messages from this channel',
                'channel:delivery':
                  'Send replies to allowed channel destinations',
                'execute:offline': 'Run isolated code without network access',
              }[capability] || capability,
          'checkbox',
          item.grants.includes(capability),
          server?.url || '',
        );
      }
      permissions.append(
        node(
          'p',
          manifest.capabilities.length
            ? 'Saving a grant makes the connection eligible for activation. Every tool call still needs separate approval.'
            : 'This version requests no tool connections. Its instructions are sent to your model when active.',
          'hint',
        ),
      );
      form.append(
        node(
          'p',
          'Saving configuration deactivates this installation. Review and activate the selected version separately afterward.',
          'hint',
        ),
      );
      let dirty = false;
      const savedStatus = node('p', '', 'hint');
      savedStatus.setAttribute('role', 'status');
      const sourceApproved = state.sources.some(
        (source) => source.repo === item.repo && source.approved,
      );
      const activate = button(
        'Activate selected version',
        () => {
          if (dirty || version.blocked || !sourceApproved) return;
          change(
            path('activate'),
            target,
            'Selected plugin version activated.',
          );
        },
        true,
      );
      unavailable(
        activate,
        Boolean(version.blocked) ||
          !sourceApproved ||
          item.active === version.digest,
      );
      const markDirty = () => {
        dirty = true;
        unavailable(activate, true);
        savedStatus.textContent =
          'Unsaved changes. Save configuration before activating.';
      };
      form.oninput = markDirty;
      form.onchange = markDirty;
      submit(form, 'Save settings and permissions', async () => {
        const secrets = {};
        for (const [key, binding] of Object.entries(bindings)) {
          if (binding.mode.value === 'stored')
            secrets[key] = { source: 'stored', value: binding.stored.value };
          else if (binding.mode.value === 'environment')
            secrets[key] = {
              source: 'environment',
              name: binding.environment.value.trim(),
            };
          else if (binding.mode.value === 'remove')
            secrets[key] = { source: 'remove' };
        }
        for (const [key, control] of Object.entries(removed))
          if (control.checked) secrets[key] = { source: 'remove' };
        await api(path('configure'), {
          ...target,
          values: Object.fromEntries(
            manifest.settings.map((setting) => [
              setting.key,
              setting.type === 'boolean'
                ? fields[setting.key].checked
                : fields[setting.key].value,
            ]),
          ),
          secrets,
          ...(manifest.channel
            ? {
                channelAccess: {
                  tenant: access.tenant.value.trim(),
                  ...Object.fromEntries(
                    ['users', 'admins', 'destinations'].map((key) => [
                      key,
                      [
                        ...new Set(
                          access[key].value
                            .split('\n')
                            .map((value) => value.trim())
                            .filter(Boolean),
                        ),
                      ],
                    ]),
                  ),
                },
              }
            : {}),
          grants: Object.entries(grants)
            .filter(([, control]) => control.checked)
            .map(([key]) => key),
        });
      });
      form.append(savedStatus);
      const actions = node('div', null, 'settings-actions');
      actions.append(activate);
      if (item.active)
        actions.append(
          button('Deactivate plugin', () =>
            change(
              path('deactivate'),
              { id: item.id, revision: item.revision },
              'Plugin deactivated.',
            ),
          ),
        );
      body.append(actions);
      if (!sourceApproved)
        body.append(
          node(
            'p',
            'Repository approval is required before activation.',
            'hint',
          ),
        );
      body.append(
        node(
          'p',
          'Selecting an older prepared version changes future execution only. It cannot undo actions already performed.',
          'hint',
        ),
      );
    };
    let loadedDigest;
    let loadingDigest;
    let request = 0;
    const loadVersion = async () => {
      const digest = versions.value;
      if (digest === loadedDigest || digest === loadingDigest) return;
      const summary = availableVersions.find(
        (entry) => entry.digest === digest,
      );
      const current = ++request;
      if (summary?.cached === false) {
        loadedDigest = digest;
        loadingDigest = undefined;
        selectedVersions.set(item.id, { digest, open: details.open });
        body.setAttribute('aria-busy', 'false');
        body.replaceChildren(
          node(
            'p',
            'This cached download was removed. The version fingerprint and review history remain. Download the original release again before configuring or activating it.',
            'hint',
          ),
        );
        const restore = button('Download original release', () =>
          change(
            path('install'),
            {
              repo: item.repo,
              tag: summary.tag,
              format: summary.format || 'rove',
            },
            'Original release downloaded. Review before activation.',
          ),
        );
        unavailable(
          restore,
          !state.sources.some(
            (source) => source.repo === item.repo && source.approved,
          ),
        );
        body.append(restore);
        return;
      }
      loadingDigest = digest;
      loadedDigest = undefined;
      selectedVersions.set(item.id, { digest, open: details.open });
      const status = node('p', 'Loading version details…', 'hint');
      status.setAttribute('role', 'status');
      body.replaceChildren(status);
      body.setAttribute('aria-busy', 'true');
      try {
        const version = await api(path(`${item.id}/releases/${digest}`));
        if (current !== request) return;
        renderVersion(version);
        loadedDigest = digest;
      } catch (error) {
        if (error.status === 401) {
          onError(error);
          return;
        }
        if (current !== request) return;
        const message = node(
          'p',
          error.message || 'Version details could not be loaded.',
          'error',
        );
        message.setAttribute('role', 'alert');
        body.replaceChildren(
          message,
          button('Retry version details', loadVersion),
        );
      } finally {
        if (current === request) {
          loadingDigest = undefined;
          body.setAttribute('aria-busy', 'false');
        }
      }
    };
    let historyCursor = item.versionsCursor ?? null;
    let olderPage = false;
    let loadingHistory = false;
    const historyControls = node('div', null, 'settings-actions');
    const historyStatus = node('p', '', 'hint');
    historyStatus.setAttribute('role', 'status');
    const older = button('Load older versions', () =>
      run(() => loadHistory(historyCursor)),
    );
    const newest = button('Latest versions', () => run(() => loadHistory()));
    function historyState() {
      historyControls.hidden = !historyCursor && !olderPage;
      unavailable(older, !historyCursor || loadingHistory);
      unavailable(newest, !olderPage || loadingHistory);
    }
    async function loadHistory(cursor) {
      if (loadingHistory) return;
      loadingHistory = true;
      historyState();
      historyStatus.textContent = 'Loading release history…';
      try {
        const page = await api(
          path(
            `${item.id}/releases${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
          ),
        );
        const previous = versions.value;
        availableVersions = [...cachedVersions, ...page.versions];
        versions.replaceChildren(
          ...availableVersions.map((version) => {
            const option = node(
              'option',
              `${version.version} · ${version.tag}${version.digest === item.active ? ' · active' : ''}${version.cached === false ? ' · download removed' : ''}`,
            );
            option.value = version.digest;
            return option;
          }),
        );
        versions.value = availableVersions.some(
          (version) => version.digest === previous,
        )
          ? previous
          : item.active ||
            page.versions[0]?.digest ||
            cachedVersions[0]?.digest ||
            '';
        historyCursor = page.nextCursor;
        olderPage = Boolean(cursor);
        historyStatus.textContent = page.versions.length
          ? 'Showing a page of removed downloads. Cached versions stay available.'
          : 'No older removed downloads.';
        if (versions.value) await loadVersion();
        else {
          ++request;
          loadedDigest = undefined;
          loadingDigest = undefined;
          body.replaceChildren(
            node(
              'p',
              'Select Latest versions to return to recent releases.',
              'hint',
            ),
          );
        }
        requestAnimationFrame(() => versions.focus());
      } catch (error) {
        if (error.status === 401) onError(error);
        else
          historyStatus.textContent =
            error.message || 'Release history could not be loaded. Try again.';
      } finally {
        loadingHistory = false;
        historyState();
      }
    }
    historyControls.append(older, newest);
    details.append(historyControls, historyStatus);
    historyState();
    versions.onchange = loadVersion;
    details.ontoggle = () => {
      selectedVersions.set(item.id, {
        digest: versions.value,
        open: details.open,
      });
      if (details.open) return loadVersion();
    };
    if (details.open) loadVersion();
    const audit = disclosure(row, 'Recent changes');
    const history = node('ol', null, 'plugin-audit');
    for (const event of item.audit) {
      const entry = node(
        'li',
        `${new Date(event.at).toISOString().replace('T', ' ').slice(0, 19)} UTC · ${event.event.replaceAll('-', ' ')}`,
      );
      if (event.digest) entry.append(node('p', event.digest, 'hint'));
      history.append(entry);
    }
    audit.append(history);
  }

  const sources = node('section', null, 'configuration-row');
  sources.append(
    node('h3', 'GitHub repositories'),
    node(
      'p',
      'Approve each repository explicitly. New releases stay inactive until you review them.',
      'description',
    ),
  );
  content.append(sources);
  const sourceForm = node('form');
  const repo = field(
    sourceForm,
    'source-repo',
    'Repository',
    'text',
    '',
    'Use owner/repository.',
  );
  repo.required = true;
  repo.maxLength = 140;
  const token = field(
    sourceForm,
    'source-token',
    'GitHub access token (optional)',
    'password',
    '',
    'Public repositories may not need a token. Leave blank to keep a saved token.',
  );
  token.maxLength = 1000;
  const clear = field(
    sourceForm,
    'source-clear',
    'Remove the saved access token',
    'checkbox',
    false,
  );
  const approved = field(
    sourceForm,
    'source-approved',
    'I approve releases from this repository for review',
    'checkbox',
    false,
  );
  submit(sourceForm, 'Save repository', () =>
    api(path('sources'), {
      repo: repo.value.trim(),
      approved: approved.checked,
      token: token.value,
      clearToken: clear.checked,
    }),
  );
  let sourceEditor;
  for (const source of state.sources) {
    const row = node('div', null, 'plugin-source');
    row.append(
      node('strong', source.repo),
      node(
        'p',
        `${source.approved ? 'Approved' : 'Not approved'} · ${source.configured ? 'Access token saved' : 'No access token saved'}`,
        'hint',
      ),
    );
    const actions = node('div', null, 'settings-actions');
    actions.append(
      button('Edit repository', () => {
        sourceEditor.open = true;
        repo.value = source.repo;
        approved.checked = source.approved;
        token.value = '';
        clear.checked = false;
        repo.focus();
      }),
    );
    if (source.approved)
      actions.append(
        button('Revoke approval and deactivate', () =>
          change(
            path('sources'),
            { repo: source.repo, approved: false },
            'Repository approval revoked. Its active plugins were deactivated.',
          ),
        ),
      );
    row.append(actions);
    sources.append(row);
  }
  sourceEditor = disclosure(
    sources,
    'Add or edit a repository',
    !state.sources.length,
  );
  sourceEditor.append(sourceForm);
  const install = node('section', null, 'configuration-row');
  install.append(node('h3', 'Prepare a release'));
  content.append(install);
  const approvedSources = state.sources.filter((source) => source.approved);
  if (!approvedSources.length)
    install.append(
      node(
        'p',
        'Approve a repository above to prepare its first release.',
        'hint',
      ),
    );
  else {
    const form = node('form');
    install.append(form);
    const repository = choose(
      form,
      'install-repo',
      'Approved repository',
      approvedSources.map((source) => [source.repo, source.repo]),
      approvedSources[0].repo,
    );
    const tag = field(
      form,
      'install-tag',
      'Release tag',
      'text',
      '',
      'Enter an existing immutable GitHub release tag, such as v1.0.0.',
    );
    tag.required = true;
    tag.maxLength = 128;
    const format = choose(
      form,
      'install-format',
      'Package format',
      [
        ['rove', 'Rove release artifact'],
        ['claude-code', 'Claude Code plugin content'],
        ['cursor', 'Cursor plugin content'],
        ['codex-skill', 'Codex skill content'],
      ],
      'rove',
    );
    form.append(
      node(
        'p',
        'Imports support declared skills, instructions and remote MCP. Executable hooks and local commands are unavailable.',
        'hint',
      ),
    );
    submit(form, 'Prepare release', () =>
      api(path('install'), {
        repo: repository.value,
        tag: tag.value.trim(),
        format: format.value,
      }),
    );
  }
  const runtimeInfo = node('section', null, 'configuration-row');
  runtimeInfo.append(
    node('h3', 'Execution runtime'),
    node(
      'p',
      runtime.configured
        ? 'Railway connection configured. Every code execution must pass sandbox isolation checks.'
        : 'Railway Sandbox needs deployment credentials. Web chat and declarative plugins work independently.',
      'description',
    ),
  );
  runtimeInfo.append(node('p', state.executable.reason, 'hint'));
  if (runtime.pendingCleanup?.length)
    runtimeInfo.append(
      node(
        'p',
        `${runtime.pendingCleanup.length} sandbox cleanup records need reconciliation. Check the deployment runtime before enabling execution.`,
        'hint',
      ),
    );
  content.append(runtimeInfo);
}
