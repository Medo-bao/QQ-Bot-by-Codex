export const sovitsParameters = {
  temperature: { label: '温度', min: 0.05, max: 1.5, step: 0.05, value: 0.7, hint: '调高会增加语调变化。' },
  topK: { label: 'Top-k', min: 1, max: 50, step: 1, value: 10, hint: '限制每次采样的候选数。' },
  topP: { label: 'Top-p', min: 0.1, max: 1, step: 0.05, value: 0.9, hint: '调高会扩大采样范围。' },
  speedFactor: { label: '语速', min: 0.5, max: 2, step: 0.05, value: 1, hint: '1× 为音色原速。' },
  maxChars: { label: '单段字数', min: 20, max: 300, step: 1, value: 90, hint: '较长文字会优先按句子分段。' },
  idleMinutes: { label: '空闲卸载', min: 0, max: 120, step: 1, value: 10, hint: '空闲后释放显存。0 分钟表示常驻。' },
} as const;

export type SovitsParameter = keyof typeof sovitsParameters;
export type SovitsSettings = Record<SovitsParameter, number> & { autoSpeak: boolean };
export const speechTextLimit = 1500;
