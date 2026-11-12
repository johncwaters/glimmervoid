window.glimmervoid = {
  subscribe(topics, onTopic) {
    window.addEventListener('message', (event) => {
      if (event.source !== window.parent) return;
      const message = event.data;
      if (message?.v !== 1) return;
      if (message.kind === 'hello') onTopic('hello', message.granted);
      if (message.kind === 'topic') onTopic(message.topic, message.data);
    });
    window.parent.postMessage({ v: 1, kind: 'subscribe', topics }, '*');
  },

  act(request) {
    const id = `action-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    return new Promise((resolve) => {
      const onResult = (event) => {
        if (event.source !== window.parent || event.data?.v !== 1 || event.data.kind !== 'action-result' || event.data.id !== id) return;
        window.removeEventListener('message', onResult);
        resolve(event.data);
      };
      window.addEventListener('message', onResult);
      window.parent.postMessage({ v: 1, kind: 'action', id, request }, '*');
    });
  },

  applyTheme(theme) {
    for (const [property, value] of Object.entries(theme.colors)) document.documentElement.style.setProperty(property, value);
  },

  element(tagName, className, text) {
    const element = document.createElement(tagName);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  },
};
