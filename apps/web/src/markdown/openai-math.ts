import type { Processor } from 'unified';
import type {
  Construct,
  State,
  Extension as MicromarkExtension,
} from 'micromark-util-types';
import type { Extension } from 'mdast-util-from-markdown';

declare module 'micromark-util-types' {
  interface TokenTypeMap {
    openaiMath: 'openaiMath';
    openaiMathData: 'openaiMathData';
  }
}

// Recognize TeX delimiters before Markdown consumes backslash escapes or `_`.
// Native Markdown parsing keeps fenced/inline code and link destinations literal.
const construct: Construct = {
  name: 'openaiMath',
  tokenize(effects, ok, nok) {
    let closing = 0;
    let openingCode = 0;
    let length = 0;
    const body: State = (code) => {
      if (code === null || ++length > 16388) return nok(code);
      if (closing === 41 && (code === -5 || code === -4 || code === -3))
        return nok(code);
      if (code === -5 || code === -4 || code === -3) {
        effects.exit('openaiMathData');
        effects.enter('lineEnding');
        effects.consume(code);
        effects.exit('lineEnding');
        return lineStart;
      }
      effects.consume(code);
      return code === 92 ? escaped : body;
    };
    const lineStart: State = (code) => {
      effects.enter('openaiMathData');
      return body(code);
    };
    const escaped: State = (code) => {
      if (code === openingCode) return nok(code);
      if (code === closing) {
        effects.consume(code);
        effects.exit('openaiMathData');
        effects.exit('openaiMath');
        return ok;
      }
      // Consume an escaped backslash as a pair, not as a closing delimiter.
      if (code === 92) {
        effects.consume(code);
        return body;
      }
      return body(code);
    };
    const opening: State = (code) => {
      if (code !== 40 && code !== 91) return nok(code);
      openingCode = code;
      closing = code === 40 ? 41 : 93;
      effects.consume(code);
      return body;
    };
    return (code) => {
      effects.enter('openaiMath');
      effects.enter('openaiMathData');
      effects.consume(code);
      return opening;
    };
  },
};

const fromMarkdown: Extension = {
  enter: {
    openaiMath(token) {
      const raw = this.sliceSerialize(token);
      const value = raw.slice(2, -2).trim();
      this.enter(
        {
          type: 'inlineMath',
          value,
          data: {
            hName: 'code',
            hProperties: {
              className: [
                'language-math',
                raw.startsWith('\\[') ? 'math-display' : 'math-inline',
              ],
            },
            hChildren: [{ type: 'text', value }],
          },
        },
        token,
      );
      this.buffer();
    },
  },
  exit: {
    openaiMath(token) {
      this.resume();
      this.exit(token);
    },
  },
};

export function remarkOpenAiMath(this: Processor) {
  const data = this.data() as {
    micromarkExtensions?: MicromarkExtension[];
    fromMarkdownExtensions?: Extension[];
  };
  (data.micromarkExtensions ||= []).push({ text: { 92: construct } });
  (data.fromMarkdownExtensions ||= []).push(fromMarkdown);
}
