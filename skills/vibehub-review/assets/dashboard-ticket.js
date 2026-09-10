/* Content-first ticket inspector. Saved requirements remain distinct from
   recorded progress; this view never approves a decision or starts an agent. */
(() => {
  'use strict';
  const el = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const same = (a, b) => String(a || '').trim() === String(b || '').trim();
  function contentFor(item, details) {
    const description = details?.outcome || item.outcome || '';
    return {
      description,
      background: same(details?.context, description) ? '' : details?.context || '',
      criteria: (details?.acceptance || []).filter(c => c.state !== 'retired' && !same(c.criterion, description)),
      constraints: details?.constraints || [],
    };
  }
  function mount({ container, item, workflow, dependencies, dependents, goals, navigate, loadDetails, copy, contractUrl }) {
    let active = true, details = null;
    const narrative = el('div', undefined, 'ticket-narrative');container.append(narrative);
    function section(title) {
      const node = el('section', undefined, 'ticket-section');node.append(el('h3', title));narrative.append(node);return node;
    }
    function render() {
      narrative.replaceChildren();
      const content = contentFor(item, details);
      const description = section('Description');
      description.append(el('p', content.description || 'No description has been recorded for this ticket yet.', 'ticket-description'));
      if (content.criteria.length) {
        const node = section('Done when'), list = el('ul', undefined, 'ticket-criteria');
        for (const criterion of content.criteria) {
          const row = el('li');row.append(el('span', criterion.criterion));
          if (criterion.authority === 'human') row.append(el('small', 'Your decision', 'criterion-human'));
          list.append(row);
        }
        node.append(list);
      }
      if (content.background) section('Background').append(el('p', content.background, 'ticket-background'));
      if (content.constraints.length) {
        const node = section('Constraints'), list = el('ul', undefined, 'ticket-constraints');
        content.constraints.forEach(value => list.append(el('li', value)));node.append(list);
      }
    }
    render();
    const loadStatus = el('p', item.ticket ? 'Loading requirements…' : '', 'ticket-load-status');
    loadStatus.setAttribute('role', 'status');container.append(loadStatus);
    const related = el('section', undefined, 'ticket-related');
    for (const [label, values] of [['Goal', goals], ['Depends on', dependencies], ['Unblocks', dependents]]) {
      if (!values.length) continue;
      const row = el('div', undefined, 'ticket-related-row');row.append(el('h3', label));
      const links = el('div', undefined, 'ticket-related-links');
      for (const value of values) {
        const button = el('button', value.title, 'ticket-related-link');button.type = 'button';
        button.disabled = value.type === 'missing';
        button.addEventListener('click', () => navigate(value, button));links.append(button);
      }
      row.append(links);related.append(row);
    }
    if (related.childElementCount) container.append(related);
    const metadata = el('details', undefined, 'ticket-record-details');metadata.append(el('summary', 'Record details'));
    const meta = el('dl');
    for (const [label, value] of [['Ticket ID', item.originalId || item.id], ['Source', item.path], ['Recorded next action', workflow.detail]]) {
      if (value) meta.append(el('dt', label), el('dd', value));
    }
    metadata.append(meta);container.append(metadata);
    const actions = document.getElementById('detail-actions');
    const button = el('button', workflow.lane === 'attention' ? 'Copy decision brief' : 'Copy work brief');button.type = 'button';
    button.addEventListener('click', () => {
      const content = contentFor(item, details);
      copy([item.title, content.description, content.background,
        ...content.criteria.map(c => `Done when: ${c.criterion}${c.authority === 'human' ? ' (human decision)' : ''}`),
        ...content.constraints.map(value => `Constraint: ${value}`),
        `Source: ${item.path}`, `Next action: ${workflow.detail}`,
        workflow.lane === 'attention' ? 'Help me review this decision. Prepare options and tradeoffs; this is not approval.' : '',
      ].filter(Boolean).join('\n\n'));
    });
    actions.append(button);
    if (contractUrl) { const link = el('a', 'Contract & evidence ↗');link.href = contractUrl;actions.append(link); }
    actions.append(el('small', 'Paste the brief into your agent to continue.', 'ticket-handoff-hint'));
    if (item.ticket) loadDetails().then(result => {
      if (!active) return;
      details = result;render();loadStatus.remove();
    }).catch(error => {
      if (active) loadStatus.textContent = `Requirements could not be loaded: ${error.message}`;
    });
    return () => { active = false; };
  }
  globalThis.VibeHubTicket = { contentFor, mount };
})();
