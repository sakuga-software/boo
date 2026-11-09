/** The coding agent that writes a pull request, as the pull request shows it. */
export interface Agent {
  id: 'claude' | 'copilot' | 'codex' | 'cursor' | 'devin';
  name: string;
  /** The page of the cloud session that wrote the pull request, if the description links it. */
  cloudSession?: string;
}

export interface AgentSignals {
  author: string;
  branch: string;
  body: string;
  /** The message of the last commit, with its trailers. */
  commitMessage: string;
  /** The logins of the authors of the last commit. */
  commitAuthors: readonly string[];
}

interface Rule {
  agent: Omit<Agent, 'cloudSession'>;
  logins: readonly string[];
  branch: string;
  /** A line of the last commit or of the description that only this agent writes. */
  mark?: RegExp;
}

const RULES: readonly Rule[] = [
  { agent: { id: 'copilot', name: 'Copilot' }, logins: ['Copilot', 'copilot-swe-agent[bot]'], branch: 'copilot/' },
  { agent: { id: 'codex', name: 'Codex' }, logins: ['chatgpt-codex-connector[bot]'], branch: 'codex/' },
  { agent: { id: 'cursor', name: 'Cursor' }, logins: ['cursor[bot]', 'cursoragent'], branch: 'cursor/' },
  { agent: { id: 'devin', name: 'Devin' }, logins: ['devin-ai-integration[bot]'], branch: 'devin/' },
  {
    agent: { id: 'claude', name: 'Claude Code' },
    logins: ['claude', 'claude[bot]'],
    branch: 'claude/',
    mark: /^co-authored-by: claude\b|generated (?:with|by) \[claude code\]/im,
  },
];

const CLOUD_SESSION = /https:\/\/claude\.ai\/code\/session_[A-Za-z0-9]+/;

/** Returns the agent that the pull request names, or undefined if a person writes it alone. */
export function detectAgent(signals: AgentSignals): Agent | undefined {
  const logins = [signals.author, ...signals.commitAuthors];
  const rule = RULES.find(
    ({ logins: known, branch, mark }) =>
      logins.some((login) => known.includes(login)) ||
      signals.branch.startsWith(branch) ||
      Boolean(mark && (mark.test(signals.commitMessage) || mark.test(signals.body))),
  );
  if (!rule) return undefined;
  const cloudSession = rule.agent.id === 'claude' ? CLOUD_SESSION.exec(signals.body)?.[0] : undefined;
  return { ...rule.agent, ...(cloudSession && { cloudSession }) };
}
