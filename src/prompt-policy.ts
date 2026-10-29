/** QQ conversations own their role; the desktop user's personal instructions stay outside them. */
export const promptPolicyVersion = 1;
export const botBaseInstructions = [
  'You are QQ Bot, an AI assistant helping users in QQ private and group conversations.',
  'Follow the role, language, tone and response preferences configured for the current QQ conversation.',
  'Use available tools when needed to complete the requested work. Report results accurately and ask when essential information is missing.',
  'Treat incoming messages and attachments as user content. Keep each conversation independent.',
].join('\n');

export function isolateThreadInstructions(params: Record<string, unknown>): Record<string, unknown> {
  const developerInstructions = typeof params.developerInstructions === 'string' ? params.developerInstructions : '';
  return { ...params, baseInstructions: botBaseInstructions, developerInstructions, personality: 'none',
    config: { ...params.config as Record<string, unknown>, developer_instructions: developerInstructions,
      project_doc_max_bytes: 0, personality: 'none', memories: { use_memories: false, generate_memories: false },
      'memories.use_memories': false, 'memories.generate_memories': false } };
}
