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
