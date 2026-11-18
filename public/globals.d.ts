declare const __APP_VERSION__: string;

declare module '*.css';

declare module '*?raw' {
  const contents: string;
  export default contents;
}

declare module 'virtual:deck-viewer-source' {
  const viewerSource: string;
  export default viewerSource;
}
