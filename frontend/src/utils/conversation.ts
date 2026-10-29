import type { ConversationLanguage } from "../config/languages.ts";

export type InteractionMode = "chat" | "voice";

type SessionOptions = {
  mode: InteractionMode;
  language: ConversationLanguage;
  instructions?: string;
  voiceName: string;
  personalVoiceName?: string;
  temperature: number;
  vadEagerness: string;
  noiseSuppression: string;
};

export function buildConversationSession(options: SessionOptions): Record<string, unknown> {
  const session: Record<string, unknown> = {
    modalities: options.mode === "chat" ? ["text"] : ["text", "audio"],
    instructions: [
      options.instructions,
      `Conversation language: ${options.language.label} (${options.language.code}). Respond in this language unless the user explicitly requests a different language. Preserve the configured persona, safety rules, and knowledge-grounding requirements.`,
    ].filter(Boolean).join("\n\n"),
    tools: [{
      type: "function",
      name: "search_knowledge_base",
      description: "Search the knowledge base for relevant information to support the coaching conversation.",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "Search query" } },
        required: ["query"],
      },
    }],
    tool_choice: "auto",
  };
  if (options.mode === "chat") {
    session.turn_detection = null;
    return session;
  }
  session.input_audio_sampling_rate = 24000;
  session.turn_detection = {
    type: "azure_semantic_vad",
    threshold: 0.3,
    prefix_padding_ms: 500,
    silence_duration_ms: 500,
    speech_duration_ms: 80,
    remove_filler_words: true,
    interrupt_response: true,
    auto_truncate: true,
    eagerness: options.vadEagerness,
  };
  session.input_audio_echo_cancellation = { type: "server_echo_cancellation" };
  session.input_audio_transcription = { model: "azure-speech", language: options.language.code };
  session.voice = options.personalVoiceName
    ? { type: "azure-personal", name: options.personalVoiceName, model: "DragonLatestNeural", temperature: options.temperature }
    : { type: "azure-standard", name: options.voiceName, temperature: options.temperature };
  if (options.noiseSuppression !== "none") {
    session.input_audio_noise_reduction = { type: options.noiseSuppression };
  }
  return session;
}

export function usesCachedAudio(mode: InteractionMode, language: ConversationLanguage): boolean {
  return mode === "voice" && language.code.startsWith("en-");
}

export function buildNudgeResponse(language: ConversationLanguage) {
  return {
    modalities: ["text", "audio"],
    tool_choice: "none",
    instructions: `Follow the session's persona and safety rules. The user has been silent. Offer one short, gentle check-in in ${language.label} (${language.code}), asking whether they would like to continue. Do not answer an earlier question, introduce new information, or use tools.`,
  };
}

export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(total / 60);
  return `${String(minutes).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}
