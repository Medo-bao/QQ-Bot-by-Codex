export const ttsProviders = ['dashscope', 'minimax', 'mimo'] as const;
export type TtsProvider = typeof ttsProviders[number];
export const keyedSpeechProviders = ['openai', ...ttsProviders] as const;
export type KeyedSpeechProvider = typeof keyedSpeechProviders[number];
export const speechProviders = [...keyedSpeechProviders, 'sovits'] as const;
export type SpeechProvider = typeof speechProviders[number];

export const speechProviderInfo = {
  openai: { label: 'OpenAI GPT-Live', keyEnv: 'OPENAI_API_KEY', model: 'gpt-live-1', voice: 'marin' },
  dashscope: { label: '阿里云百炼 · CosyVoice', keyEnv: 'DASHSCOPE_API_KEY', model: 'cosyvoice-v3-flash', voice: 'longanhuan' },
  minimax: { label: 'MiniMax Speech', keyEnv: 'MINIMAX_API_KEY', model: 'speech-2.8-turbo', voice: 'female-shaonv' },
  mimo: { label: '小米 MiMo', keyEnv: 'MIMO_API_KEY', model: 'mimo-v2.5-tts', voice: 'mimo_default' },
  sovits: { label: 'GPT-SoVITS · 本地' },
} as const;

export const speechPresets: Record<KeyedSpeechProvider, Record<string, string>> = {
  openai: { marin: 'Marin' },
  dashscope: { longanhuan: '龙安欢' },
  minimax: { 'female-shaonv': '少女', 'female-tianmei': '甜美女声', 'male-qn-qingse': '青涩青年' },
  mimo: { mimo_default: '小米默认', 冰糖: '冰糖', 茉莉: '茉莉', 苏打: '苏打', 白桦: '白桦', Mia: 'Mia', Chloe: 'Chloe', Milo: 'Milo', Dean: 'Dean' },
};
