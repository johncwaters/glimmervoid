export const ICON_CATEGORIES = ['infra', 'interface', 'security', 'people', 'objects', 'signals', 'design'] as const;

export const ICON_NAMES = [
  'database', 'server', 'cloud', 'storage', 'cache', 'queue', 'network', 'router', 'api', 'webhook',
  'function', 'container', 'cluster', 'load-balancer', 'cdn', 'terminal', 'code', 'git-branch', 'cpu', 'package',
  'workflow', 'monitor', 'phone', 'tablet', 'laptop', 'browser', 'dashboard', 'chart', 'search', 'settings',
  'bell', 'mail', 'message', 'calendar', 'home', 'link', 'globe', 'lock', 'unlock', 'key',
  'shield', 'shield-check', 'fingerprint', 'eye', 'eye-off', 'user', 'users', 'user-plus', 'bot', 'building',
  'file', 'document', 'folder', 'image', 'video', 'archive', 'clipboard', 'book', 'tag', 'payment',
  'cart', 'zap', 'activity', 'alert', 'info', 'check', 'error', 'clock', 'refresh', 'arrow-right',
  'flag', 'star', 'trending-up', 'type', 'palette', 'grid', 'component', 'form', 'button', 'modal',
  'nav', 'pen', 'layers', 'cursor', 'shapes', 'toggle', 'list',
] as const;

type IconCategory = typeof ICON_CATEGORIES[number];
export type IconName = typeof ICON_NAMES[number];

interface IconSpec {
  category: IconCategory;
  label: string;
  elements: readonly string[];
}

export const ICON_VIEWBOX = '0 0 24 24';
export const PLACED_ICON: IconName = 'component';
export const ICON_BOX_GLYPH_SIZE = 48;
export const ICON_BOX_GLYPH_GAP = 8;
export const TITLE_ICON_CHARS = 2;
export const LINE_ICON_CHARS = 3;

export const ICON_CATALOG: Readonly<Record<IconName, IconSpec>> = Object.freeze({
  database: { category: 'infra', label: 'Database', elements: ['<ellipse cx="12" cy="5" rx="9" ry="3"/>', '<path d="M3 5V19A9 3 0 0 0 21 19V5"/>', '<path d="M3 12A9 3 0 0 0 21 12"/>'] },
  server: { category: 'infra', label: 'Server', elements: ['<rect width="20" height="8" x="2" y="2" rx="2" ry="2"/>', '<rect width="20" height="8" x="2" y="14" rx="2" ry="2"/>', '<line x1="6" x2="6.01" y1="6" y2="6"/>', '<line x1="6" x2="6.01" y1="18" y2="18"/>'] },
  cloud: { category: 'infra', label: 'Cloud', elements: ['<path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/>'] },
  storage: { category: 'infra', label: 'Storage', elements: ['<line x1="22" x2="2" y1="12" y2="12"/>', '<path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>', '<line x1="6" x2="6.01" y1="16" y2="16"/>', '<line x1="10" x2="10.01" y1="16" y2="16"/>'] },
  cache: { category: 'infra', label: 'Cache', elements: ['<path d="M6 19v-3"/>', '<path d="M10 19v-3"/>', '<path d="M14 19v-3"/>', '<path d="M18 19v-3"/>', '<path d="M8 11V9"/>', '<path d="M16 11V9"/>', '<path d="M12 11V9"/>', '<path d="M2 15h20"/>', '<path d="M2 7a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v1.1a2 2 0 0 0 0 3.837V17a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-5.1a2 2 0 0 0 0-3.837Z"/>'] },
  queue: { category: 'infra', label: 'Queue', elements: ['<path d="M10 12h11"/>', '<path d="M10 18h11"/>', '<path d="M10 6h11"/>', '<path d="M4 10h2"/>', '<path d="M4 6h1v4"/>', '<path d="M6 18H4c0-1 2-2 2-3s-1-1.5-2-1"/>'] },
  network: { category: 'infra', label: 'Network', elements: ['<rect x="16" y="16" width="6" height="6" rx="1"/>', '<rect x="2" y="16" width="6" height="6" rx="1"/>', '<rect x="9" y="2" width="6" height="6" rx="1"/>', '<path d="M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3"/>', '<path d="M12 12V8"/>'] },
  router: { category: 'infra', label: 'Router', elements: ['<rect width="20" height="8" x="2" y="14" rx="2"/>', '<path d="M6.01 18H6"/>', '<path d="M10.01 18H10"/>', '<path d="M15 10v4"/>', '<path d="M17.84 7.17a4 4 0 0 0-5.66 0"/>', '<path d="M20.66 4.34a8 8 0 0 0-11.31 0"/>'] },
  api: { category: 'infra', label: 'API', elements: ['<path d="M12 22v-5"/>', '<path d="M9 8V2"/>', '<path d="M15 8V2"/>', '<path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"/>'] },
  webhook: { category: 'infra', label: 'Webhook', elements: ['<path d="M18 16.98h-5.99c-1.1 0-1.95.94-2.48 1.9A4 4 0 0 1 2 17c.01-.7.2-1.4.57-2"/>', '<path d="m6 17 3.13-5.78c.53-.97.1-2.18-.5-3.1a4 4 0 1 1 6.89-4.06"/>', '<path d="m12 6 3.13 5.73C15.66 12.7 16.9 13 18 13a4 4 0 0 1 0 8"/>'] },
  function: { category: 'infra', label: 'Function', elements: ['<rect width="18" height="18" x="3" y="3" rx="2" ry="2"/>', '<path d="M9 17c2 0 2.8-1 2.8-2.8V10c0-2 1-3.3 3.2-3"/>', '<path d="M9 11.2h5.7"/>'] },
  container: { category: 'infra', label: 'Container', elements: ['<path d="M22 7.7c0-.6-.4-1.2-.8-1.5l-6.3-3.9a1.72 1.72 0 0 0-1.7 0l-10.3 6c-.5.2-.9.8-.9 1.4v6.6c0 .5.4 1.2.8 1.5l6.3 3.9a1.72 1.72 0 0 0 1.7 0l10.3-6c.5-.3.9-1 .9-1.5Z"/>', '<path d="M10 21.9V14L2.1 9.1"/>', '<path d="m10 14 11.9-6.9"/>', '<path d="M14 19.8v-8.1"/>', '<path d="M18 17.5V9.4"/>'] },
  cluster: { category: 'infra', label: 'Cluster', elements: ['<path d="M2.97 12.92A2 2 0 0 0 2 14.63v3.24a2 2 0 0 0 .97 1.71l3 1.8a2 2 0 0 0 2.06 0L12 19v-5.5l-5-3-4.03 2.42Z"/>', '<path d="m7 16.5-4.74-2.85"/>', '<path d="m7 16.5 5-3"/>', '<path d="M7 16.5v5.17"/>', '<path d="M12 13.5V19l3.97 2.38a2 2 0 0 0 2.06 0l3-1.8a2 2 0 0 0 .97-1.71v-3.24a2 2 0 0 0-.97-1.71L17 10.5l-5 3Z"/>', '<path d="m17 16.5-5-3"/>', '<path d="m17 16.5 4.74-2.85"/>', '<path d="M17 16.5v5.17"/>', '<path d="M7.97 4.42A2 2 0 0 0 7 6.13v4.37l5 3 5-3V6.13a2 2 0 0 0-.97-1.71l-3-1.8a2 2 0 0 0-2.06 0l-3 1.8Z"/>', '<path d="M12 8 7.26 5.15"/>', '<path d="m12 8 4.74-2.85"/>', '<path d="M12 13.5V8"/>'] },
  'load-balancer': { category: 'infra', label: 'Load balancer', elements: ['<path d="M16 3h5v5"/>', '<path d="M8 3H3v5"/>', '<path d="M12 22v-8.3a4 4 0 0 0-1.172-2.872L3 3"/>', '<path d="m15 9 6-6"/>'] },
  cdn: { category: 'infra', label: 'CDN', elements: ['<path d="M4 10a7.31 7.31 0 0 0 10 10Z"/>', '<path d="m9 15 3-3"/>', '<path d="M17 13a6 6 0 0 0-6-6"/>', '<path d="M21 13A10 10 0 0 0 11 3"/>'] },
  terminal: { category: 'infra', label: 'Terminal', elements: ['<polyline points="4 17 10 11 4 5"/>', '<line x1="12" x2="20" y1="19" y2="19"/>'] },
  code: { category: 'infra', label: 'Code', elements: ['<polyline points="16 18 22 12 16 6"/>', '<polyline points="8 6 2 12 8 18"/>'] },
  'git-branch': { category: 'infra', label: 'Git branch', elements: ['<line x1="6" x2="6" y1="3" y2="15"/>', '<circle cx="18" cy="6" r="3"/>', '<circle cx="6" cy="18" r="3"/>', '<path d="M18 9a9 9 0 0 1-9 9"/>'] },
  cpu: { category: 'infra', label: 'CPU', elements: ['<rect width="16" height="16" x="4" y="4" rx="2"/>', '<rect width="6" height="6" x="9" y="9" rx="1"/>', '<path d="M15 2v2"/>', '<path d="M15 20v2"/>', '<path d="M2 15h2"/>', '<path d="M2 9h2"/>', '<path d="M20 15h2"/>', '<path d="M20 9h2"/>', '<path d="M9 2v2"/>', '<path d="M9 20v2"/>'] },
  package: { category: 'infra', label: 'Package', elements: ['<path d="M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z"/>', '<path d="M12 22V12"/>', '<path d="m3.3 7 7.703 4.734a2 2 0 0 0 1.994 0L20.7 7"/>', '<path d="m7.5 4.27 9 5.15"/>'] },
  workflow: { category: 'infra', label: 'Workflow', elements: ['<rect width="8" height="8" x="3" y="3" rx="2"/>', '<path d="M7 11v4a2 2 0 0 0 2 2h4"/>', '<rect width="8" height="8" x="13" y="13" rx="2"/>'] },
  monitor: { category: 'interface', label: 'Monitor', elements: ['<rect width="20" height="14" x="2" y="3" rx="2"/>', '<line x1="8" x2="16" y1="21" y2="21"/>', '<line x1="12" x2="12" y1="17" y2="21"/>'] },
  phone: { category: 'interface', label: 'Phone', elements: ['<rect width="14" height="20" x="5" y="2" rx="2" ry="2"/>', '<path d="M12 18h.01"/>'] },
  tablet: { category: 'interface', label: 'Tablet', elements: ['<rect width="16" height="20" x="4" y="2" rx="2" ry="2"/>', '<line x1="12" x2="12.01" y1="18" y2="18"/>'] },
  laptop: { category: 'interface', label: 'Laptop', elements: ['<path d="M20 16V7a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v9m16 0H4m16 0 1.28 2.55a1 1 0 0 1-.9 1.45H3.62a1 1 0 0 1-.9-1.45L4 16"/>'] },
  browser: { category: 'interface', label: 'Browser', elements: ['<rect x="2" y="4" width="20" height="16" rx="2"/>', '<path d="M10 4v4"/>', '<path d="M2 8h20"/>', '<path d="M6 4v4"/>'] },
  dashboard: { category: 'interface', label: 'Dashboard', elements: ['<rect width="7" height="9" x="3" y="3" rx="1"/>', '<rect width="7" height="5" x="14" y="3" rx="1"/>', '<rect width="7" height="9" x="14" y="12" rx="1"/>', '<rect width="7" height="5" x="3" y="16" rx="1"/>'] },
  chart: { category: 'interface', label: 'Chart', elements: ['<path d="M3 3v16a2 2 0 0 0 2 2h16"/>', '<path d="M18 17V9"/>', '<path d="M13 17V5"/>', '<path d="M8 17v-3"/>'] },
  search: { category: 'interface', label: 'Search', elements: ['<circle cx="11" cy="11" r="8"/>', '<path d="m21 21-4.3-4.3"/>'] },
  settings: { category: 'interface', label: 'Settings', elements: ['<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/>', '<circle cx="12" cy="12" r="3"/>'] },
  bell: { category: 'interface', label: 'Notification', elements: ['<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/>', '<path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>'] },
  mail: { category: 'interface', label: 'Mail', elements: ['<rect width="20" height="16" x="2" y="4" rx="2"/>', '<path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>'] },
  message: { category: 'interface', label: 'Message', elements: ['<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>'] },
  calendar: { category: 'interface', label: 'Calendar', elements: ['<path d="M8 2v4"/>', '<path d="M16 2v4"/>', '<rect width="18" height="18" x="3" y="4" rx="2"/>', '<path d="M3 10h18"/>'] },
  home: { category: 'interface', label: 'Home', elements: ['<path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"/>', '<path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'] },
  link: { category: 'interface', label: 'Link', elements: ['<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>', '<path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>'] },
  globe: { category: 'interface', label: 'Web', elements: ['<circle cx="12" cy="12" r="10"/>', '<path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/>', '<path d="M2 12h20"/>'] },
  lock: { category: 'security', label: 'Lock', elements: ['<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/>', '<path d="M7 11V7a5 5 0 0 1 10 0v4"/>'] },
  unlock: { category: 'security', label: 'Unlock', elements: ['<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/>', '<path d="M7 11V7a5 5 0 0 1 9.9-1"/>'] },
  key: { category: 'security', label: 'Key', elements: ['<path d="m15.5 7.5 2.3 2.3a1 1 0 0 0 1.4 0l2.1-2.1a1 1 0 0 0 0-1.4L19 4"/>', '<path d="m21 2-9.6 9.6"/>', '<circle cx="7.5" cy="15.5" r="5.5"/>'] },
  shield: { category: 'security', label: 'Shield', elements: ['<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>'] },
  'shield-check': { category: 'security', label: 'Verified', elements: ['<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>', '<path d="m9 12 2 2 4-4"/>'] },
  fingerprint: { category: 'security', label: 'Fingerprint', elements: ['<path d="M12 10a2 2 0 0 0-2 2c0 1.02-.1 2.51-.26 4"/>', '<path d="M14 13.12c0 2.38 0 6.38-1 8.88"/>', '<path d="M17.29 21.02c.12-.6.43-2.3.5-3.02"/>', '<path d="M2 12a10 10 0 0 1 18-6"/>', '<path d="M2 16h.01"/>', '<path d="M21.8 16c.2-2 .131-5.354 0-6"/>', '<path d="M5 19.5C5.5 18 6 15 6 12a6 6 0 0 1 .34-2"/>', '<path d="M8.65 22c.21-.66.45-1.32.57-2"/>', '<path d="M9 6.8a6 6 0 0 1 9 5.2v2"/>'] },
  eye: { category: 'security', label: 'Visible', elements: ['<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/>', '<circle cx="12" cy="12" r="3"/>'] },
  'eye-off': { category: 'security', label: 'Hidden', elements: ['<path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"/>', '<path d="M14.084 14.158a3 3 0 0 1-4.242-4.242"/>', '<path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"/>', '<path d="m2 2 20 20"/>'] },
  user: { category: 'people', label: 'User', elements: ['<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/>', '<circle cx="12" cy="7" r="4"/>'] },
  users: { category: 'people', label: 'Team', elements: ['<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/>', '<circle cx="9" cy="7" r="4"/>', '<path d="M22 21v-2a4 4 0 0 0-3-3.87"/>', '<path d="M16 3.13a4 4 0 0 1 0 7.75"/>'] },
  'user-plus': { category: 'people', label: 'Sign up', elements: ['<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/>', '<circle cx="9" cy="7" r="4"/>', '<line x1="19" x2="19" y1="8" y2="14"/>', '<line x1="22" x2="16" y1="11" y2="11"/>'] },
  bot: { category: 'people', label: 'Bot', elements: ['<path d="M12 8V4H8"/>', '<rect width="16" height="12" x="4" y="8" rx="2"/>', '<path d="M2 14h2"/>', '<path d="M20 14h2"/>', '<path d="M15 13v2"/>', '<path d="M9 13v2"/>'] },
  building: { category: 'people', label: 'Company', elements: ['<path d="M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z"/>', '<path d="M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2"/>', '<path d="M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2"/>', '<path d="M10 6h4"/>', '<path d="M10 10h4"/>', '<path d="M10 14h4"/>', '<path d="M10 18h4"/>'] },
  file: { category: 'objects', label: 'File', elements: ['<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/>', '<path d="M14 2v4a2 2 0 0 0 2 2h4"/>'] },
  document: { category: 'objects', label: 'Document', elements: ['<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/>', '<path d="M14 2v4a2 2 0 0 0 2 2h4"/>', '<path d="M10 9H8"/>', '<path d="M16 13H8"/>', '<path d="M16 17H8"/>'] },
  folder: { category: 'objects', label: 'Folder', elements: ['<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>'] },
  image: { category: 'objects', label: 'Image', elements: ['<rect width="18" height="18" x="3" y="3" rx="2" ry="2"/>', '<circle cx="9" cy="9" r="2"/>', '<path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>'] },
  video: { category: 'objects', label: 'Video', elements: ['<path d="m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5"/>', '<rect x="2" y="6" width="14" height="12" rx="2"/>'] },
  archive: { category: 'objects', label: 'Archive', elements: ['<rect width="20" height="5" x="2" y="3" rx="1"/>', '<path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/>', '<path d="M10 12h4"/>'] },
  clipboard: { category: 'objects', label: 'Clipboard', elements: ['<rect width="8" height="4" x="8" y="2" rx="1" ry="1"/>', '<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>'] },
  book: { category: 'objects', label: 'Docs', elements: ['<path d="M12 7v14"/>', '<path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/>'] },
  tag: { category: 'objects', label: 'Tag', elements: ['<path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"/>', '<circle cx="7.5" cy="7.5" r=".5" fill="currentColor"/>'] },
  payment: { category: 'objects', label: 'Payment', elements: ['<rect width="20" height="14" x="2" y="5" rx="2"/>', '<line x1="2" x2="22" y1="10" y2="10"/>'] },
  cart: { category: 'objects', label: 'Cart', elements: ['<circle cx="8" cy="21" r="1"/>', '<circle cx="19" cy="21" r="1"/>', '<path d="M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12"/>'] },
  zap: { category: 'signals', label: 'Event', elements: ['<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>'] },
  activity: { category: 'signals', label: 'Activity', elements: ['<path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"/>'] },
  alert: { category: 'signals', label: 'Alert', elements: ['<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/>', '<path d="M12 9v4"/>', '<path d="M12 17h.01"/>'] },
  info: { category: 'signals', label: 'Info', elements: ['<circle cx="12" cy="12" r="10"/>', '<path d="M12 16v-4"/>', '<path d="M12 8h.01"/>'] },
  check: { category: 'signals', label: 'Check', elements: ['<circle cx="12" cy="12" r="10"/>', '<path d="m9 12 2 2 4-4"/>'] },
  error: { category: 'signals', label: 'Error', elements: ['<circle cx="12" cy="12" r="10"/>', '<path d="m15 9-6 6"/>', '<path d="m9 9 6 6"/>'] },
  clock: { category: 'signals', label: 'Clock', elements: ['<circle cx="12" cy="12" r="10"/>', '<polyline points="12 6 12 12 16 14"/>'] },
  refresh: { category: 'signals', label: 'Refresh', elements: ['<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/>', '<path d="M21 3v5h-5"/>', '<path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/>', '<path d="M8 16H3v5"/>'] },
  'arrow-right': { category: 'signals', label: 'Arrow', elements: ['<path d="M5 12h14"/>', '<path d="m12 5 7 7-7 7"/>'] },
  flag: { category: 'signals', label: 'Flag', elements: ['<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/>', '<line x1="4" x2="4" y1="22" y2="15"/>'] },
  star: { category: 'signals', label: 'Star', elements: ['<path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z"/>'] },
  'trending-up': { category: 'signals', label: 'Trend', elements: ['<polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/>', '<polyline points="16 7 22 7 22 13"/>'] },
  type: { category: 'design', label: 'Type', elements: ['<polyline points="4 7 4 4 20 4 20 7"/>', '<line x1="9" x2="15" y1="20" y2="20"/>', '<line x1="12" x2="12" y1="4" y2="20"/>'] },
  palette: { category: 'design', label: 'Palette', elements: ['<circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/>', '<circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/>', '<circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/>', '<circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/>', '<path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z"/>'] },
  grid: { category: 'design', label: 'Grid', elements: ['<rect width="7" height="7" x="3" y="3" rx="1"/>', '<rect width="7" height="7" x="14" y="3" rx="1"/>', '<rect width="7" height="7" x="14" y="14" rx="1"/>', '<rect width="7" height="7" x="3" y="14" rx="1"/>'] },
  component: { category: 'design', label: 'Component', elements: ['<path d="M15.536 11.293a1 1 0 0 0 0 1.414l2.376 2.377a1 1 0 0 0 1.414 0l2.377-2.377a1 1 0 0 0 0-1.414l-2.377-2.377a1 1 0 0 0-1.414 0z"/>', '<path d="M2.297 11.293a1 1 0 0 0 0 1.414l2.377 2.377a1 1 0 0 0 1.414 0l2.377-2.377a1 1 0 0 0 0-1.414L6.088 8.916a1 1 0 0 0-1.414 0z"/>', '<path d="M8.916 17.912a1 1 0 0 0 0 1.415l2.377 2.376a1 1 0 0 0 1.414 0l2.377-2.376a1 1 0 0 0 0-1.415l-2.377-2.376a1 1 0 0 0-1.414 0z"/>', '<path d="M8.916 4.674a1 1 0 0 0 0 1.414l2.377 2.376a1 1 0 0 0 1.414 0l2.377-2.376a1 1 0 0 0 0-1.414l-2.377-2.377a1 1 0 0 0-1.414 0z"/>'] },
  form: { category: 'design', label: 'Form', elements: ['<path d="M5 4h1a3 3 0 0 1 3 3 3 3 0 0 1 3-3h1"/>', '<path d="M13 20h-1a3 3 0 0 1-3-3 3 3 0 0 1-3 3H5"/>', '<path d="M5 16H4a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h1"/>', '<path d="M13 8h7a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-7"/>', '<path d="M9 7v10"/>'] },
  button: { category: 'design', label: 'Button', elements: ['<rect width="20" height="12" x="2" y="6" rx="2"/>'] },
  modal: { category: 'design', label: 'Modal', elements: ['<path d="M21 9V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v10c0 1.1.9 2 2 2h4"/>', '<rect width="10" height="7" x="12" y="13" rx="2"/>'] },
  nav: { category: 'design', label: 'Navigation', elements: ['<rect width="18" height="18" x="3" y="3" rx="2"/>', '<path d="M3 9h18"/>'] },
  pen: { category: 'design', label: 'Pen', elements: ['<path d="M15.707 21.293a1 1 0 0 1-1.414 0l-1.586-1.586a1 1 0 0 1 0-1.414l5.586-5.586a1 1 0 0 1 1.414 0l1.586 1.586a1 1 0 0 1 0 1.414z"/>', '<path d="m18 13-1.375-6.874a1 1 0 0 0-.746-.776L3.235 2.028a1 1 0 0 0-1.207 1.207L5.35 15.879a1 1 0 0 0 .776.746L13 18"/>', '<path d="m2.3 2.3 7.286 7.286"/>', '<circle cx="11" cy="11" r="2"/>'] },
  layers: { category: 'design', label: 'Layers', elements: ['<path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/>', '<path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/>', '<path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/>'] },
  cursor: { category: 'design', label: 'Cursor', elements: ['<path d="M12.586 12.586 19 19"/>', '<path d="M3.688 3.037a.497.497 0 0 0-.651.651l6.5 15.999a.501.501 0 0 0 .947-.062l1.569-6.083a2 2 0 0 1 1.448-1.479l6.124-1.579a.5.5 0 0 0 .063-.947z"/>'] },
  shapes: { category: 'design', label: 'Shapes', elements: ['<path d="M8.3 10a.7.7 0 0 1-.626-1.079L11.4 3a.7.7 0 0 1 1.198-.043L16.3 8.9a.7.7 0 0 1-.572 1.1Z"/>', '<rect x="3" y="14" width="7" height="7" rx="1"/>', '<circle cx="17.5" cy="17.5" r="3.5"/>'] },
  toggle: { category: 'design', label: 'Toggle', elements: ['<rect width="20" height="12" x="2" y="6" rx="6" ry="6"/>', '<circle cx="16" cy="12" r="2"/>'] },
  list: { category: 'design', label: 'List', elements: ['<path d="M3 12h.01"/>', '<path d="M3 18h.01"/>', '<path d="M3 6h.01"/>', '<path d="M8 12h13"/>', '<path d="M8 18h13"/>', '<path d="M8 6h13"/>'] },
} satisfies Record<IconName, IconSpec>);
