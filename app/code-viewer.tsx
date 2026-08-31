import { Highlight, themes } from "prism-react-renderer";
import type { CodeTheme } from "./code-theme";
import "./code-viewer.css";

export function CodeThemeToggle({
  theme,
  onChange,
}: {
  theme: CodeTheme;
  onChange: (theme: CodeTheme) => void;
}) {
  return (
    <div className="code-theme-control">
      <span>Code theme</span>
      <div role="group" aria-label="Code color theme">
        {(["light", "dark"] as const).map((option) => (
          <button
            type="button"
            className={theme === option ? "is-active" : ""}
            aria-pressed={theme === option}
            onClick={() => onChange(option)}
            key={option}
          >
            {option}
          </button>
        ))}
      </div>
    </div>
  );
}

export function SyntaxCode({
  source,
  startLine,
  theme,
  label,
  className = "",
}: {
  source: string;
  startLine: number;
  theme: CodeTheme;
  label: string;
  className?: string;
}) {
  const normalized = source.replace(/\r\n?/g, "\n");
  const code = normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized;

  return (
    <div
      className={`syntax-shell syntax-shell--${theme} ${className}`.trim()}
      role="region"
      aria-label={label}
    >
      <Highlight theme={theme === "dark" ? themes.vsDark : themes.vsLight} code={code} language="jsx">
        {({ style, tokens, getLineProps, getTokenProps }) => (
          <pre className="syntax-pre" style={{ ...style, backgroundColor: "transparent" }}>
            <code>
              {tokens.map((line, lineIndex) => (
                <span {...getLineProps({ line })} className="syntax-line" key={lineIndex}>
                  <span className="syntax-line-number" aria-hidden="true">{startLine + lineIndex}</span>
                  <span className="syntax-line-content">
                    {line.map((token, tokenIndex) => (
                      <span {...getTokenProps({ token })} key={tokenIndex} />
                    ))}
                    {line.length === 0 && " "}
                  </span>
                </span>
              ))}
            </code>
          </pre>
        )}
      </Highlight>
    </div>
  );
}
