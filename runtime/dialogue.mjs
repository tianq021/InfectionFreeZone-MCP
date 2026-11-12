import { z } from "zod";

export const dialogueChoiceInput = {
  session_id: z.string().uuid(),
  choice_id: z.string().uuid(),
  option_id: z.number().int().positive(),
  request_id: z.string().uuid(),
};
const choiceSchema = z.strictObject(dialogueChoiceInput);
const fail = (status, code, message) => Object.assign(new Error(message), { status, code });
const conflicts = new Set(["control_busy", "request_conflict", "stale_session", "stale_dialogue_choice",
  "dialogue_option_unavailable", "result_unknown"]);

export function createDialogueChooser({ pipe, stateService, gameSessionId }) {
  async function call(method, args) {
    let reply;
    try { reply = await pipe.call(method, args); }
    catch (error) { throw fail(502, error.code ?? "bridge_error", error.message); }
    if (!reply?.ok) {
      const code = reply?.code ?? "bridge_error";
      const status = conflicts.has(code) ? 409 : code === "invalid_dialogue_option" ? 400 : 502;
      throw fail(status, code, reply?.message ?? "The radio request could not be confirmed.");
    }
    return reply;
  }

  return async (input) => {
    const parsed = choiceSchema.safeParse(input);
    if (!parsed.success) throw fail(400, "invalid_dialogue_choice", parsed.error.issues[0].message);
    const args = parsed.data;
    if (!stateService.ready || !stateService.online || stateService.state?.sessionId !== args.session_id ||
        (gameSessionId && gameSessionId !== args.session_id))
      throw fail(409, "stale_session", "Read the current game session before choosing a radio response.");
    const { lease } = await call("acquire_control", { owner: "IFZ Runtime radio" });
    try {
      return await call("choose_dialogue_option", { ...args, lease });
    } finally {
      await pipe.call("release_control", { lease }).catch(() => {});
    }
  };
}
