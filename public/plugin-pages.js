// Plugin content is data. Rove owns the page, forms, and approval controls.
export function renderPluginPages(content, state, ui) {
  const { node, button, field, run, requestAction, drafts } = ui;
  if (!state.plugins.length) {
    content.append(
      node(
        'p',
        'Active plugins can add company pages and actions here. Prepare and activate a plugin in Plugins to get started.',
        'plugin-empty',
      ),
    );
    return;
  }
  for (const plugin of state.plugins) {
    const section = node('section', null, 'configuration-row');
    section.append(node('h3', plugin.name));
    const editor = node('div');
    function openAction(action, opener) {
      editor.replaceChildren();
      const heading = node('h4', action.label);
      heading.tabIndex = -1;
      editor.append(heading, node('p', action.description, 'description'));
      const form = node('form');
      const key = `${action.name}:${action.revision}`;
      const args = field(
        form,
        `action-${plugin.id}`,
        'Action arguments (JSON)',
        'textarea',
        drafts.get(key) || '{}',
        'Review the input below. Requesting an action opens a separate approval in chat; it does not execute it.',
      );
      args.maxLength = 16000;
      args.required = true;
      args.spellcheck = false;
      args.oninput = () => drafts.set(key, args.value);
      const schema = node('details', null, 'plugin-details');
      schema.append(
        node('summary', 'Expected arguments'),
        node(
          'pre',
          JSON.stringify(action.parameters, null, 2),
          'plugin-preview',
        ),
      );
      form.append(schema);
      const submit = button('Review in chat', null, true);
      submit.type = 'submit';
      const controls = node('div', null, 'settings-actions');
      controls.append(
        submit,
        button('Close action', () => {
          editor.replaceChildren();
          opener.focus();
        }),
      );
      form.append(controls);
      form.onsubmit = (event) => {
        event.preventDefault();
        run(async () => {
          let value;
          try {
            value = JSON.parse(args.value);
          } catch {
            throw new Error(
              'Enter a valid JSON object for the action arguments.',
            );
          }
          if (!value || typeof value !== 'object' || Array.isArray(value))
            throw new Error('Action arguments must be a JSON object.');
          drafts.set(key, args.value);
          await requestAction({
            name: action.name,
            revision: action.revision,
            arguments: value,
          });
        });
      };
      editor.append(form);
      heading.focus();
    }
    function actionButtons(parent, names) {
      const actions = node('div', null, 'settings-actions');
      for (const action of plugin.actions.filter((item) =>
        names.includes(item.name),
      )) {
        const control = button(action.label, () => openAction(action, control));
        actions.append(control);
      }
      if (actions.children.length) parent.append(actions);
    }
    for (const page of plugin.pages) {
      const details = node('details', null, 'plugin-details');
      details.open = plugin.pages.length === 1;
      details.append(
        node('summary', page.title),
        node('p', page.content, 'message-content'),
      );
      actionButtons(details, page.actions);
      section.append(details);
    }
    const pageActions = new Set(plugin.pages.flatMap((page) => page.actions));
    actionButtons(
      section,
      plugin.actions
        .filter((action) => !pageActions.has(action.name))
        .map((action) => action.name),
    );
    section.append(editor);
    content.append(section);
  }
}
