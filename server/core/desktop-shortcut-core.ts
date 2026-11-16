import path from 'node:path';

const SHORTCUT_NAME = 'Glimmervoid';
const SHORTCUT_COMMENT = 'Open the Glimmervoid dashboard, starting Glimmervoid first when it is not running';
const ICO_HEADER_BYTES = 6;
const ICO_ENTRY_BYTES = 16;
const ICNS_HEADER_BYTES = 8;
const EXECUTABLE_FILE_MODE = 0o755;
const MAC_APPLET_EXECUTABLE_NAME = 'applet';
const MAC_BUNDLE_IDENTIFIER = 'dev.glimmervoid.launcher';
const LINK_SCHEME = 'glimmervoid';
const LINUX_DESKTOP_FILE_NAME = 'glimmervoid.desktop';
const LAUNCH_SERVICES_REGISTER_PATH = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';

type ShortcutFile = { path: string; contents: string | Uint8Array; mode?: number };
type DesktopShortcutPlan = {
  shortcutPath: string | null;
  replacedPath: string | null;
  stagedPath: string | null;
  buildCommands: string[][];
  files: ShortcutFile[];
  followUpCommands: string[][];
  areFollowUpsRequired: boolean;
  registrationCommands: string[][];
};

function buildIcns(png: Uint8Array): Uint8Array {
  const totalBytes = ICNS_HEADER_BYTES * 2 + png.length;
  const icns = Buffer.alloc(totalBytes);
  icns.write('icns', 0, 'latin1');
  icns.writeUInt32BE(totalBytes, 4);
  icns.write('ic09', ICNS_HEADER_BYTES, 'latin1');
  icns.writeUInt32BE(ICNS_HEADER_BYTES + png.length, ICNS_HEADER_BYTES + 4);
  icns.set(png, ICNS_HEADER_BYTES * 2);
  return icns;
}

function buildIco(png: Uint8Array): Uint8Array {
  const imageOffset = ICO_HEADER_BYTES + ICO_ENTRY_BYTES;
  const ico = Buffer.alloc(imageOffset + png.length);
  ico.writeUInt16LE(1, 2);
  ico.writeUInt16LE(1, 4);
  ico.writeUInt16LE(1, 10);
  ico.writeUInt16LE(32, 12);
  ico.writeUInt32LE(png.length, 14);
  ico.writeUInt32LE(imageOffset, 18);
  ico.set(png, imageOffset);
  return ico;
}

function shellQuoted(argument: string): string {
  return `'${argument.replaceAll("'", `'\\''`)}'`;
}

function appleScriptString(text: string): string {
  return `"${text.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function macLaunchScriptLines(openArgv: readonly string[]): string[] {
  const quotedOpenCommand = openArgv.map(shellQuoted).join(' ');
  return [
    'on run',
    `do shell script ${appleScriptString(`${quotedOpenCommand} >/dev/null 2>&1 &`)}`,
    'end run',
    'on open location linkUrl',
    `do shell script ${appleScriptString(`${quotedOpenCommand} `)} & quoted form of linkUrl & ${appleScriptString(' >/dev/null 2>&1 &')}`,
    'end open location',
  ];
}

function desktopEntryQuoted(argument: string): string {
  const quotedEscaped = argument.replace(/["`$\\]/g, (character) => `\\${character}`);
  return `"${quotedEscaped.replaceAll('\\', '\\\\').replaceAll('%', '%%')}"`;
}

function windowsArgumentQuoted(argument: string): string {
  if (argument !== '' && !/[\s"]/.test(argument)) return argument;
  return `"${argument.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
}

function powershellLiteral(text: string): string {
  return `'${text.replaceAll("'", "''")}'`;
}

function macInfoPlist(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>${SHORTCUT_NAME}</string>
  <key>CFBundleDisplayName</key><string>${SHORTCUT_NAME}</string>
  <key>CFBundleIdentifier</key><string>${MAC_BUNDLE_IDENTIFIER}</string>
  <key>CFBundleExecutable</key><string>${MAC_APPLET_EXECUTABLE_NAME}</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSUIElement</key><true/>
  <key>CFBundleURLTypes</key>
  <array><dict>
    <key>CFBundleURLName</key><string>${MAC_BUNDLE_IDENTIFIER}</string>
    <key>CFBundleURLSchemes</key><array><string>${LINK_SCHEME}</string></array>
  </dict></array>
</dict>
</plist>
`;
}

function macPlan(desktopDir: string, iconDir: string, openArgv: readonly string[], png: Uint8Array): DesktopShortcutPlan {
  const appPath = path.join(desktopDir, `${SHORTCUT_NAME}.app`);
  const stagedPath = path.join(iconDir, 'staging', `${SHORTCUT_NAME}.app`);
  const contentsPath = path.join(stagedPath, 'Contents');
  return {
    shortcutPath: appPath,
    replacedPath: appPath,
    stagedPath,
    buildCommands: [['osacompile', '-o', stagedPath, ...macLaunchScriptLines(openArgv).flatMap((scriptLine) => ['-e', scriptLine])]],
    files: [
      { path: path.join(contentsPath, 'Info.plist'), contents: macInfoPlist() },
      { path: path.join(contentsPath, 'Resources', 'AppIcon.icns'), contents: buildIcns(png) },
    ],
    followUpCommands: [['codesign', '--force', '--sign', '-', stagedPath]],
    areFollowUpsRequired: true,
    registrationCommands: [[LAUNCH_SERVICES_REGISTER_PATH, '-f', appPath]],
  };
}

function linuxPlan(desktopDir: string, iconDir: string, applicationsDir: string, openArgv: readonly string[], png: Uint8Array): DesktopShortcutPlan {
  const iconPath = path.join(iconDir, 'glimmervoid.png');
  const shortcutPath = path.join(desktopDir, LINUX_DESKTOP_FILE_NAME);
  const desktopEntry = [
    '[Desktop Entry]',
    'Type=Application',
    `Name=${SHORTCUT_NAME}`,
    `Comment=${SHORTCUT_COMMENT}`,
    `Exec=${openArgv.map(desktopEntryQuoted).join(' ')} %u`,
    `Icon=${iconPath}`,
    'Terminal=false',
    'Categories=Development;',
    `MimeType=x-scheme-handler/${LINK_SCHEME};`,
    '',
  ].join('\n');
  return {
    shortcutPath,
    replacedPath: null,
    stagedPath: null,
    buildCommands: [],
    files: [
      { path: iconPath, contents: png },
      { path: shortcutPath, contents: desktopEntry, mode: EXECUTABLE_FILE_MODE },
    ],
    followUpCommands: [['gio', 'set', shortcutPath, 'metadata::trusted', 'true']],
    areFollowUpsRequired: false,
    registrationCommands: [
      ['install', '-D', '-m', '644', shortcutPath, path.join(applicationsDir, LINUX_DESKTOP_FILE_NAME)],
      ['xdg-mime', 'default', LINUX_DESKTOP_FILE_NAME, `x-scheme-handler/${LINK_SCHEME}`],
    ],
  };
}

function windowsLinkHandlerLines(openArgv: readonly string[]): string[] {
  const schemeKey = `HKCU:\\Software\\Classes\\${LINK_SCHEME}`;
  const handlerCommandLine = `${openArgv.map(windowsArgumentQuoted).join(' ')} -- "%1"`;
  return [
    'try {',
    `  New-Item -Path ${powershellLiteral(schemeKey)} -Value 'URL:${SHORTCUT_NAME}' -Force | Out-Null`,
    `  New-ItemProperty -Path ${powershellLiteral(schemeKey)} -Name 'URL Protocol' -Value '' -Force | Out-Null`,
    `  New-Item -Path ${powershellLiteral(`${schemeKey}\\shell\\open\\command`)} -Value ${powershellLiteral(handlerCommandLine)} -Force | Out-Null`,
    '} catch {}',
  ];
}

function windowsShortcutScript(iconPath: string, openArgv: readonly string[]): string {
  const [target = '', ...targetArguments] = openArgv;
  return [
    "$ErrorActionPreference = 'Stop'",
    `$shortcutPath = Join-Path ([Environment]::GetFolderPath('Desktop')) '${SHORTCUT_NAME}.lnk'`,
    '$shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($shortcutPath)',
    `$shortcut.TargetPath = ${powershellLiteral(target)}`,
    `$shortcut.Arguments = ${powershellLiteral(targetArguments.map(windowsArgumentQuoted).join(' '))}`,
    `$shortcut.IconLocation = ${powershellLiteral(`${iconPath},0`)}`,
    `$shortcut.Description = ${powershellLiteral(SHORTCUT_COMMENT)}`,
    `$shortcut.WorkingDirectory = [Environment]::GetFolderPath('UserProfile')`,
    '$shortcut.WindowStyle = 7',
    '$shortcut.Save()',
    ...windowsLinkHandlerLines(openArgv),
    'Write-Output $shortcutPath',
  ].join('\n');
}

function windowsPlan(iconDir: string, openArgv: readonly string[], png: Uint8Array): DesktopShortcutPlan {
  const iconPath = path.win32.join(iconDir, 'glimmervoid.ico');
  const encodedScript = Buffer.from(windowsShortcutScript(iconPath, openArgv), 'utf16le').toString('base64');
  return {
    shortcutPath: null,
    replacedPath: null,
    stagedPath: null,
    buildCommands: [],
    files: [{ path: iconPath, contents: buildIco(png) }],
    followUpCommands: [['powershell.exe', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodedScript]],
    areFollowUpsRequired: true,
    registrationCommands: [],
  };
}

function planDesktopShortcut({ platform, desktopDir, iconDir, applicationsDir, launchArgv, png }: { platform: string; desktopDir: string; iconDir: string; applicationsDir: string; launchArgv: readonly string[]; png: Uint8Array }): DesktopShortcutPlan | null {
  const openArgv = [...launchArgv, 'open'];
  if (platform === 'darwin') return macPlan(desktopDir, iconDir, openArgv, png);
  if (platform === 'win32') return windowsPlan(iconDir, openArgv, png);
  if (platform === 'linux') return linuxPlan(desktopDir, iconDir, applicationsDir, openArgv, png);
  return null;
}

export { planDesktopShortcut };
export type { DesktopShortcutPlan };
