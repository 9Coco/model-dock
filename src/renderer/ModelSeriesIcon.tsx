import { Layers3 } from './MaterialIcon';
import openai from './assets/model-series-icons/openai.svg?no-inline';
import claude from './assets/model-series-icons/claude.svg?no-inline';
import deepseek from './assets/model-series-icons/deepseek.svg?no-inline';
import gemini from './assets/model-series-icons/gemini.svg?no-inline';
import qwen from './assets/model-series-icons/qwen.svg?no-inline';
import meta from './assets/model-series-icons/meta.svg?no-inline';
import grok from './assets/model-series-icons/grok.svg?no-inline';
import kimi from './assets/model-series-icons/kimi.svg?no-inline';
import zai from './assets/model-series-icons/zai.svg?no-inline';
import minimax from './assets/model-series-icons/minimax.svg?no-inline';
import mistral from './assets/model-series-icons/mistral.svg?no-inline';
import xiaomimimo from './assets/model-series-icons/xiaomimimo.svg?no-inline';
import bytedance from './assets/model-series-icons/bytedance.svg?no-inline';
import stepfun from './assets/model-series-icons/stepfun.svg?no-inline';

const marks = { openai, claude, deepseek, gemini, qwen, meta, grok, kimi, zai, minimax, mistral, xiaomimimo, bytedance, stepfun };
type Mark = keyof typeof marks;
const seriesMarks: Record<string, Mark> = {
  gpt: 'openai', 'openai-o': 'openai', 'gpt-image': 'openai', 'gpt-audio': 'openai',
  'gpt-realtime': 'openai', 'gpt-oss': 'openai', 'text-embedding': 'openai',
  'dall-e': 'openai', whisper: 'openai', codex: 'openai', tts: 'openai',
  claude: 'claude', deepseek: 'deepseek', gemini: 'gemini', qwen: 'qwen', llama: 'meta',
  grok: 'grok', kimi: 'kimi', glm: 'zai', minimax: 'minimax', mistral: 'mistral',
  mimo: 'xiaomimimo', seed: 'bytedance', step: 'stepfun',
};

/** Local brand marks are decorative; each tab supplies its own accessible series name. */
export function ModelSeriesIcon({ series }: { series: string }) {
  const mark = Object.hasOwn(seriesMarks, series) ? seriesMarks[series] : undefined;
  return <span className="model-series-icon" data-model-series-icon={mark ?? 'default'} aria-hidden="true">
    {mark ? <span className="model-series-icon-mark" style={{ maskImage: `url("${marks[mark]}")`, WebkitMaskImage: `url("${marks[mark]}")` }} /> : <Layers3 size={18} />}
  </span>;
}
