const board = { sessions: [], focusedSessionId: null, attention: null };

function stateColor(state) {
  return `var(--state-${state.toLowerCase()}, var(--text-dim))`;
}

function sessionCard(session) {
  const card = window.glimmervoid.element('div', session.id === board.focusedSessionId ? 'session focused' : 'session');
  card.append(window.glimmervoid.element('div', 'name', session.name));
  card.append(window.glimmervoid.element('div', 'task', session.taskTitle ?? 'No task title yet'));
  const state = window.glimmervoid.element('span', 'state', session.state);
  state.style.color = stateColor(session.state);
  card.append(state);
  return card;
}

function render() {
  const attention = board.attention;
  document.getElementById('summary').textContent = attention
    ? `${board.sessions.length} sessions: ${attention.waiting} waiting, ${attention.failed} failed, ${attention.finished} finished`
    : `${board.sessions.length} sessions`;
  const list = document.getElementById('sessions');
  if (board.sessions.length === 0) {
    list.replaceChildren(window.glimmervoid.element('p', 'empty', 'No sessions are running.'));
    return;
  }
  list.replaceChildren(...board.sessions.map(sessionCard));
}

window.glimmervoid.subscribe(['sessions', 'attention', 'focus', 'theme'], (topic, data) => {
  if (topic === 'theme') window.glimmervoid.applyTheme(data);
  if (topic === 'sessions') board.sessions = data.sessions;
  if (topic === 'attention') board.attention = data;
  if (topic === 'focus') board.focusedSessionId = data.sessionId;
  render();
});
