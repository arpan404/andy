export const Capabilities = {
  filesystem: {
    read: "filesystem.read",
    readSensitive: "filesystem.read_sensitive",
    write: "filesystem.write",
    delete: "filesystem.delete",
  },
  memory: {
    fetch: "memory.fetch",
    save: "memory.save",
    saveFact: "memory.save_fact",
    query: "memory.query",
    semanticQuery: "memory.semantic_query",
    embed: "memory.embed",
    forget: "memory.forget",
    list: "memory.list",
  },
  messaging: {
    receive: "messaging.receive",
    send: "messaging.send",
    manageWebhook: "messaging.manage_webhook",
    readContact: "messaging.read_contact",
    mapIdentity: "messaging.map_identity",
  },
  telegram: {
    listen: "messaging.telegram.listen",
    sendMessage: "messaging.telegram.send_message",
    setWebhook: "messaging.telegram.set_webhook",
  },
  whatsapp: {
    listen: "messaging.whatsapp.listen",
    sendMessage: "messaging.whatsapp.send_message",
    setWebhook: "messaging.whatsapp.set_webhook",
  },
  computer: {
    mouse: "computer.mouse",
    keyboard: "computer.keyboard",
    window: "computer.window",
    app: "computer.app",
    accessibilityTree: "computer.accessibility_tree",
  },
  voice: {
    listen: "voice.listen",
    record: "voice.record",
    transcribe: "voice.transcribe",
    speak: "voice.speak",
    stop: "voice.stop",
  },
  vision: {
    capture: "screen.capture",
    ocr: "screen.ocr",
    describe: "screen.describe",
  },
  browser: {
    navigate: "browser.navigate",
    inspect: "browser.inspect",
    click: "browser.click",
    type: "browser.type",
    screenshot: "browser.screenshot",
    submitForm: "browser.submit_form",
  },
  codex: {
    run: "codex.run",
    thread: "codex.thread",
  },
  background: {
    run: "background.run",
    schedule: "background.schedule",
    cancel: "background.cancel",
  },
  notification: {
    send: "notification.send",
    approvalRequest: "notification.approval_request",
  },
  secrets: {
    get: "secrets.get",
  },
  swarm: {
    plan: "swarm.plan",
    spawn: "swarm.spawn",
    delegate: "swarm.delegate",
    join: "swarm.join",
    cancel: "swarm.cancel",
  },
} as const;

export const Tools = {
  filesystem: {
    read: "filesystem.read",
    write: "filesystem.write",
    delete: "filesystem.delete",
    list: "filesystem.list",
  },
  memory: {
    fetch: "memory.fetch",
    save: "memory.save",
    saveFact: "memory.saveFact",
    query: "memory.query",
    semanticQuery: "memory.semanticQuery",
    forget: "memory.forget",
    list: "memory.list",
  },
  telegram: {
    listen: "telegram.listen",
    sendMessage: "telegram.sendMessage",
    setWebhook: "telegram.setWebhook",
  },
  whatsapp: {
    listen: "whatsapp.listen",
    sendMessage: "whatsapp.sendMessage",
    setWebhook: "whatsapp.setWebhook",
  },
  background: {
    run: "background.run",
    schedule: "background.schedule",
    cancel: "background.cancel",
  },
  swarm: {
    spawn: "swarm.spawn",
    delegate: "swarm.delegate",
    join: "swarm.join",
    cancel: "swarm.cancel",
  },
  messaging: {
    receive: "messaging.receive",
    send: "messaging.send",
  },
  voice: {
    listen: "voice.listen",
    record: "voice.record",
    transcribe: "voice.transcribe",
    speak: "voice.speak",
    stop: "voice.stop",
  },
  browser: {
    navigate: "browser.navigate",
    inspect: "browser.inspect",
    click: "browser.click",
    type: "browser.type",
    screenshot: "browser.screenshot",
    submitForm: "browser.submit_form",
  },
  codex: {
    run: "codex.run",
  },
  secrets: {
    get: "secrets.get",
  },
} as const;

export type CanonicalCapability =
  (typeof Capabilities)[keyof typeof Capabilities][keyof (typeof Capabilities)[keyof typeof Capabilities]];

export type CanonicalTool =
  (typeof Tools)[keyof typeof Tools][keyof (typeof Tools)[keyof typeof Tools]];

export function qualifyToolName(pluginId: string, toolName: string): string {
  return `${pluginId}.${toolName}`;
}
