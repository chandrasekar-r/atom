// Example Atom plugin: a tool, a slash command, and event hooks.
export default function (atom) {
  atom.registerTool({
    name: "dice_oracle", readOnly: true,
    description: "Consult the dice oracle. Returns the oracle's answer word.",
    parameters: { type: "object", properties: { question: { type: "string" } }, required: ["question"] },
    async run(a) { return `The oracle says: ZEPHYR (${String(a.question).length})`; },
  });
  atom.registerCommand("ping", { description: "plugin ping", run: (args) => `pong ${args}`.trim() });
  atom.on("pre_tool", (e) => (e.tool === "bash" && /PLUGIN_BLOCK_ME/.test(e.input.command || "") ? { block: "demo plugin forbids this command" } : undefined));
}
