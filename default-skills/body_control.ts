type Ctx = { anp: { sendCommand: (id: string, cmd: string, payload: unknown) => void }; node_id: string };

export async function speak(args: { text: string; node_id?: string }, ctx: Ctx): Promise<unknown> {
  const target = args.node_id ?? 'aura_body_01';
  ctx.anp.sendCommand(target, 'speak', { text: args.text });
  return { sent: true, target };
}

export async function set_led(args: { pattern: string; color: string; node_id?: string }, ctx: Ctx): Promise<unknown> {
  const target = args.node_id ?? 'aura_body_01';
  ctx.anp.sendCommand(target, 'led', { pattern: args.pattern, color: args.color });
  return { sent: true, target };
}

export async function send_alert(args: { text: string; haptic?: string; node_id?: string }, ctx: Ctx): Promise<unknown> {
  const target = args.node_id ?? 'aura_body_01';
  ctx.anp.sendCommand(target, 'alert', { text: args.text, haptic: args.haptic ?? 'single' });
  return { sent: true, target };
}

export async function set_display(args: { line1: string; line2?: string; node_id?: string }, ctx: Ctx): Promise<unknown> {
  const target = args.node_id ?? 'aura_body_01';
  ctx.anp.sendCommand(target, 'display', { line1: args.line1, line2: args.line2 });
  return { sent: true, target };
}
