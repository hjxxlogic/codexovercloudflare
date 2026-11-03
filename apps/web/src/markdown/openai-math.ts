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
    openaiMathFlow: 'openaiMathFlow';
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

const lineEnding = (code: number | null) =>
  code === -5 || code === -4 || code === -3;

// Block parsing precedes text parsing. Protect standalone display delimiters
// here so TeX lines such as `=` cannot become Markdown setext headings.
const flowConstruct: Construct = {
  name: 'openaiMathFlow',
  concrete: true,
  tokenize(effects, ok, nok) {
    let length = 0;
    const continuation: Construct = {
      partial: true,
      tokenize(check, yes, no) {
        return (code) => {
          check.enter('lineEnding');
          check.consume(code);
          check.exit('lineEnding');
          return (next) =>
            this.parser.lazy[this.now().line] ? no(next) : yes(next);
        };
      },
    };
    const nextLine: State = (code) =>
      effects.attempt(continuation, body, nok)(code);
    const body: State = (code) => {
      if (code === null || ++length > 16388) return nok(code);
      if (lineEnding(code)) return nextLine(code);
      effects.enter('openaiMathData');
      return data(code);
    };
    const data: State = (code) => {
      if (code === null || lineEnding(code)) {
        effects.exit('openaiMathData');
        return body(code);
      }
      if (++length > 16388) return nok(code);
      effects.consume(code);
      return code === 92 ? escaped : data;
    };
    const escaped: State = (code) => {
      if (code === 91) return nok(code);
      if (code === 93) {
        effects.consume(code);
        effects.exit('openaiMathData');
        effects.exit('openaiMathFlow');
        return after;
      }
      if (code === 92) {
        effects.consume(code);
        return data;
      }
      return data(code);
    };
    // Keep following prose in the native inline parser, including links,
    // emphasis and inline math; it is outside the display-math token.
    const after: State = (code) => {
      if (code === null || lineEnding(code)) return ok(code);
      effects.enter('paragraph');
      effects.enter('chunkText', { contentType: 'text' });
      return prose(code);
    };
    const prose: State = (code) => {
      if (code === null || lineEnding(code)) {
        effects.exit('chunkText');
        effects.exit('paragraph');
        return ok(code);
      }
      effects.consume(code);
      return prose;
    };
    const openingEnd: State = (code) => {
      if (code === 32 || code === -2 || code === -1) {
        effects.consume(code);
        return openingEnd;
      }
      if (!lineEnding(code)) return nok(code);
      effects.exit('openaiMathData');
      if (this.interrupt) return ok(code);
      return nextLine(code);
    };
    return (code) => {
      effects.enter('openaiMathFlow');
      effects.enter('openaiMathData');
      effects.consume(code);
      return (next) => {
        if (next !== 91) return nok(next);
        effects.consume(next);
        return openingEnd;
      };
    };
  },
};

const fromMarkdown: Extension = {
  enter: {
    openaiMathFlow(token) {
      const value = this.sliceSerialize(token).slice(2, -2).trim();
      this.enter(
        {
          type: 'math',
          value,
          data: {
            hName: 'code',
            hProperties: { className: ['language-math', 'math-display'] },
            hChildren: [{ type: 'text', value }],
          },
        },
        token,
      );
      this.buffer();
    },
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
    openaiMathFlow(token) {
      this.resume();
      this.exit(token);
    },
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
  (data.micromarkExtensions ||= []).push({
    text: { 92: construct },
    flow: { 92: flowConstruct },
  });
  (data.fromMarkdownExtensions ||= []).push(fromMarkdown);
}
