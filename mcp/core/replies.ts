type ReplyBody = Record<string, unknown>;

function spawnReplyForMcp(body: ReplyBody): ReplyBody {
  if (body.ok !== true || typeof body.sessionId !== 'string' || typeof body.name !== 'string') return body;
  const note = `this session owns ${body.name} until the task is done: session read with child ${body.sessionId} reads its messages, session send steers it, and session close ends it and discards its worktree, refusing while it holds work that is not on the integration branch unless you set discard`;
  return { ...body, note };
}

function boardReplyWithoutCommandGuide(body: ReplyBody): ReplyBody {
  return Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'note'));
}

function secretText(readout: object): string {
  return 'configured' in readout && readout.configured === true ? 'configured' : 'not configured';
}

function settingLineOf(readout: unknown): string | null {
  if (typeof readout !== 'object' || readout === null || !('path' in readout) || typeof readout.path !== 'string') return null;
  const isSecret = 'secret' in readout && readout.secret === true;
  const valueText = isSecret ? secretText(readout) : JSON.stringify('value' in readout ? readout.value ?? null : null);
  const source = 'source' in readout ? String(readout.source) : 'default';
  return `${readout.path} = ${valueText} (${source})`;
}

function settingsListForMcp(body: ReplyBody): ReplyBody {
  if (body.ok !== true || !Array.isArray(body.readout)) return body;
  const lines = body.readout.map(settingLineOf).filter((line) => line !== null);
  return { ok: true, text: lines.join('\n') };
}

export { boardReplyWithoutCommandGuide, settingsListForMcp, spawnReplyForMcp };
