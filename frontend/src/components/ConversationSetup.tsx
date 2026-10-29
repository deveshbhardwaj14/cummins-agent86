import { useEffect, useState } from "react";
import { Combobox, Option } from "@fluentui/react-components";
import { Chat24Regular, Checkmark24Regular, Clock24Regular, Globe24Regular, Mic24Regular } from "@fluentui/react-icons";
import { filterLanguages, LANGUAGES, type ConversationLanguage } from "../config/languages";
import { formatDuration, type InteractionMode } from "../utils/conversation";

export function CumminsBrand() {
  return (
    <div className="cummins-brand">
      <img src="/cummins-logo.png" alt="Cummins" width="48" height="48" />
      <div><strong>{import.meta.env.VITE_APP_TITLE || "Agent86"}</strong><span>Cummins CIO Earl's digital twin</span></div>
    </div>
  );
}

export function ConversationClock({ startedAt }: { startedAt?: number | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const date = new Date(now);
  return (
    <div className="conversation-clock">
      <Clock24Regular aria-hidden="true" />
      <div>
        <time dateTime={date.toISOString()}>
          {date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          <span>{date.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" })}</span>
        </time>
        {startedAt != null && <span className="session-duration" aria-label="Conversation duration">
          Session {formatDuration((now - startedAt) / 1000)}
        </span>}
      </div>
    </div>
  );
}

type SetupProps = {
  mode: InteractionMode;
  language: ConversationLanguage;
  onModeChange: (mode: InteractionMode) => void;
  onLanguageChange: (language: ConversationLanguage) => void;
};

export function ConversationSetup({ mode, language, onModeChange, onLanguageChange }: SetupProps) {
  const [query, setQuery] = useState(language.label);
  const matches = filterLanguages(query === language.label ? "" : query);
  return (
    <div className="conversation-setup">
      <div className="setup-label"><span>01</span> Choose how to connect</div>
      <div className="mode-options" role="group" aria-label="Interaction mode">
        {([
          { mode: "voice", title: "Voice conversation", description: "Speak naturally. Get spoken replies.", icon: <Mic24Regular /> },
          { mode: "chat", title: "Text conversation", description: "Type at your pace. No microphone needed.", icon: <Chat24Regular /> },
        ] as const).map((option) => (
          <button type="button" className={`mode-card${mode === option.mode ? " selected" : ""}`}
            aria-pressed={mode === option.mode} key={option.mode} onClick={() => onModeChange(option.mode)}>
            <span className="mode-icon">{option.icon}</span>
            <span><strong>{option.title}</strong><small>{option.description}</small></span>
            <span className="mode-check">{mode === option.mode && <Checkmark24Regular />}</span>
          </button>
        ))}
      </div>
      <label className="setup-label" htmlFor="conversation-language"><span>02</span> Select your language</label>
      <div className="language-control">
        <Globe24Regular aria-hidden="true" />
        <Combobox id="conversation-language" aria-describedby="language-hint" value={query}
          selectedOptions={[language.code]} placeholder="Type to find a language"
          onChange={(event) => setQuery(event.target.value)}
          onBlur={() => setQuery(language.label)}
          onOptionSelect={(_, data) => {
            const selected = LANGUAGES.find((item) => item.code === data.optionValue);
            if (selected) { onLanguageChange(selected); setQuery(selected.label); }
          }}>
          {matches.map((item) => (
            <Option key={item.code} value={item.code} text={item.label}>
              <span className="language-option"><strong>{item.label}</strong><small>{item.nativeName} · {item.code}</small></span>
            </Option>
          ))}
          {matches.length === 0 && <Option disabled value="no-results">No matching languages. Try another name or code.</Option>}
        </Combobox>
      </div>
      <p className="language-hint" id="language-hint">
        Search {LANGUAGES.length} locales by name or code. English is selected by default.
        {mode === "voice" && " Speech availability and quality depend on your configured model and voice."}
      </p>
    </div>
  );
}
